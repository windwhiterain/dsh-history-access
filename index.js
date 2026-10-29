/**
 * `dsh-history-access` — model-facing recall of a session's own condensed history.
 *
 * A compaction pass replaces earlier conversation with a summary and leaves the
 * originals in the append-only session log. This plugin gives the model three
 * tools over that log — an outline, a windowed transcript read (with a span-map
 * view), and a literal search — so recovering a condensed detail never requires
 * shelling out to read or decompress a session file.
 *
 * The data path is the session projection service, not repeated queries: a
 * registered unit with no wire view feeds each committed event reference to the
 * plugin once (`lib/recall-index.js`), and the plugin advances its own derived
 * index over the appended events on the next tool call. A recall tool therefore
 * costs O(events appended since the previous call) rather than a whole-session
 * deep clone, which is what made a chained read cost ~20 s per call.
 *
 * The three tools are registered LAZILY, so a session that has condensed
 * nothing spends no schema tokens on recall it cannot use. Registration lands
 * in the calling agent's own scope (`agent.ctx.tools.register`) at the moment
 * the need appears:
 *
 * - on a successful `compaction/end`, and
 * - at `agent/created` for a session that already carries checkpoints — a
 *   resume, whose earlier condensation this plugin never saw.
 *
 * A mid-session tool addition is first-class here rather than a workaround: the
 * loop logs a `request/header` for the new set plus a `developer/message`
 * carrying `tool-addition` blocks, and the next step's request presents the
 * schema (`packages/core/agent-loop/src/agent.ts` `buildRequest`). Automatic
 * compaction runs inside the `agent/pre-step` waterfall or on
 * `agent/request-error`, both ahead of the next `assemble()`
 * (`packages/compaction/compaction-basic/src/index.ts`), so the tools are
 * visible from the step after the one that condensed. The step that requested
 * the compaction itself still runs with the old schema.
 *
 * The agent's own layer is exempt from `tools.restrict()` and unwinds with the
 * agent's fiber, so a preset that masks a global tool cannot strip recall, and
 * nothing needs explicit teardown.
 *
 * @module dsh-history-access
 */

import { Config, MAX_SEARCH_CONTEXT, MIN_PAGE_CHARS, normalizeConfig } from './lib/config.js'
import { createPointerDedupe, pointerText } from './lib/pointer.js'
import {
  QueryError,
  collectMap,
  collectTranscript,
  findCheckpoint,
  remainingInRange,
  resolveRead,
  searchIn,
} from './lib/query.js'
import { FEED_KEY, createIndexReader, registerEventFeed, structureOf } from './lib/recall-index.js'
import {
  decodeCursor,
  finishSpanMapPage,
  finishTranscriptPage,
  renderOutline,
  renderSearchPage,
  renderSpanMap,
  renderTranscriptPage,
} from './lib/render.js'

export { Config }

/** Cordis plugin name. */
export const name = 'history-access'

/** Fibers this module has already applied to, so a repeated `apply` is a no-op. */
const applied = new WeakSet()

/** Canonical `history_read`/`history_search` parameter keys, in schema order. */
const READ_ARGUMENTS = ['checkpoint', 'seq', 'cursor', 'chars', 'events', 'view']
const SEARCH_ARGUMENTS = ['query', 'checkpoint', 'limit', 'context']

/** `history_read` views. */
const VIEWS = Object.freeze(['transcript', 'map'])

/**
 * Canonical tool output: the model-facing page text and nothing else.
 *
 * The registry snapshots and validates this per call, so `render` receives the
 * exact value `execute` returned.
 */
const OUTPUT = Object.freeze({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
})

/**
 * Resolve the calling agent, refusing a caller that has no live session.
 * @param exec - the tool execution context.
 * @returns the calling agent.
 * @throws {QueryError} when the call is not agent-bound.
 */
function callerOf(exec) {
  const agent = exec.agent
  if (agent === undefined || agent.session === undefined) {
    throw new QueryError('history recall requires an agent-bound caller')
  }
  return agent
}

/**
 * Resolve the inclusive last seq a read may touch: everything the model can
 * already see exists strictly before the running step, so a read never reaches
 * the call that is executing it. Mirrors the boundary
 * `packages/session-query/tool-session-query/src/operations.ts` applies.
 * @param ctx - the plugin context.
 * @param agent - the calling agent.
 * @returns the inclusive upper bound on readable seqs.
 * @throws {QueryError} when the session has no active step boundary.
 */
function stepCap(ctx, agent) {
  const boundary = ctx.get('sessionProjections')?.stateOf(agent.session, 'turnBoundary')
  const start = boundary?.lastStepStartSeq
  if (start === null || start === undefined) {
    throw new QueryError('history recall requires an active step boundary in this session')
  }
  return start - 1
}

/**
 * Resolve this session's feed and advance its derived index.
 * @param ctx - the plugin context.
 * @param reader - the per-session index reader.
 * @param agent - the calling agent.
 * @returns the feed's event array and the derived index.
 * @throws {QueryError} when the deployment mounts no projection service.
 */
function recallState(ctx, reader, agent) {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) {
    throw new QueryError('history recall is unavailable: this deployment mounts no session projection service')
  }
  const feed = projections.stateOf(agent.session, FEED_KEY)
  if (feed === undefined) {
    throw new QueryError('history recall is not indexed for this session yet')
  }
  return { events: feed.events, index: reader.read(agent.session, feed) }
}

/**
 * Reject unknown or malformed tool arguments before they reach a read.
 * @param args - the model's raw arguments.
 * @param allowed - the canonical parameter keys.
 * @param tool - the tool name for the diagnostic.
 * @returns the arguments object.
 * @throws {QueryError} when a key is unknown or the value is not an object.
 */
function argumentsOf(args, allowed, tool) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new QueryError(`${tool} arguments must be an object`)
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new QueryError(`${tool} does not accept "${key}" (it accepts ${allowed.join(', ')})`)
    }
  }
  return args
}

/**
 * Clamp one integer budget into its range, remembering what the caller asked for.
 * @param raw - the caller's value, or undefined for the default.
 * @param fallback - the configured default.
 * @param minimum - the smallest accepted value.
 * @param maximum - the largest accepted value.
 * @param tool - the tool name for the diagnostic.
 * @param field - the argument name for the diagnostic.
 * @returns the effective value and, when it was clamped, the requested one.
 * @throws {QueryError} when the value is not an integer.
 */
function budgetOf(raw, fallback, minimum, maximum, tool, field) {
  if (raw === undefined) return { value: fallback, requested: undefined }
  if (!Number.isInteger(raw)) {
    throw new QueryError(`${tool} ${field} must be an integer`)
  }
  return { value: Math.min(maximum, Math.max(minimum, raw)), requested: raw }
}

/**
 * Normalize `history_read` arguments.
 *
 * `checkpoint` and `seq` combine; a cursor carries its own range identity and
 * therefore excludes both. Budgets clamp instead of failing, because a page
 * that asked for more than the deployment allows still has a useful answer.
 * @param raw - the model's raw arguments.
 * @param config - the normalized row configuration.
 * @returns the resolved selectors, view, and effective budgets.
 * @throws {QueryError} when a selector is missing, repeated, or malformed.
 */
function readArguments(raw, config) {
  const args = argumentsOf(raw, READ_ARGUMENTS, 'history_read')
  const checkpoint = args.checkpoint === undefined ? null : args.checkpoint
  const seq = args.seq === undefined ? null : args.seq
  const cursor = args.cursor === undefined ? null : args.cursor
  if (cursor !== null && (checkpoint !== null || seq !== null)) {
    throw new QueryError('history_read cursor already carries its position; omit checkpoint and seq when continuing a page')
  }
  if (cursor === null && checkpoint === null && seq === null) {
    throw new QueryError('history_read needs checkpoint (an id from history_outline), seq (an event position), or cursor (from a previous page)')
  }
  if (checkpoint !== null && (typeof checkpoint !== 'string' || checkpoint.trim().length === 0)) {
    throw new QueryError('history_read checkpoint must be a checkpoint id such as "c245"')
  }
  if (seq !== null && (!Number.isInteger(seq) || seq < 0)) {
    throw new QueryError('history_read seq must be a non-negative integer event position')
  }
  const carried = cursor === null ? undefined : decodeCursor(cursor)
  if (cursor !== null && (typeof cursor !== 'string' || carried === null)) {
    throw new QueryError('history_read cursor must be the cursor line a previous page returned')
  }
  // A cursor carries the budgets of the page it came from, so continuing a page
  // keeps its size instead of silently growing to the deployment default.
  const chars = budgetOf(args.chars, carried?.chars ?? config.readDefaultChars, MIN_PAGE_CHARS, config.readMaxChars, 'history_read', 'chars')
  const events = budgetOf(args.events, carried?.events ?? config.readDefaultEvents, 1, config.readMaxEvents, 'history_read', 'events')
  const view = args.view === undefined ? 'transcript' : args.view
  if (!VIEWS.includes(view)) {
    throw new QueryError(`history_read view must be ${VIEWS.map(value => `"${value}"`).join(' or ')}`)
  }
  return {
    checkpoint,
    seq,
    cursor,
    chars: chars.value,
    charsRequested: chars.requested,
    events: events.value,
    eventsRequested: events.requested,
    view,
  }
}

/**
 * Normalize `history_search` arguments.
 * @param raw - the model's raw arguments.
 * @param config - the normalized row configuration.
 * @returns the literal query, the optional checkpoint id, and the effective bounds.
 * @throws {QueryError} when the query is missing or malformed.
 */
function searchArguments(raw, config) {
  const args = argumentsOf(raw, SEARCH_ARGUMENTS, 'history_search')
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    throw new QueryError('history_search needs a non-empty literal query')
  }
  const checkpoint = args.checkpoint === undefined ? null : args.checkpoint
  if (checkpoint !== null && (typeof checkpoint !== 'string' || checkpoint.trim().length === 0)) {
    throw new QueryError('history_search checkpoint must be a checkpoint id such as "c245"')
  }
  const limit = budgetOf(args.limit, config.searchMaxHits, 1, config.searchMaxHits, 'history_search', 'limit')
  const context = budgetOf(args.context, config.searchDefaultContext, 80, MAX_SEARCH_CONTEXT, 'history_search', 'context')
  return { query: args.query.trim(), checkpoint, limit: limit.value, context: context.value }
}

/** The model-facing description of `history_outline`. */
const OUTLINE_DESCRIPTION = 'Map this session\'s own history: how many events it holds, every compaction '
  + 'checkpoint with the id, seq range, size, and short summary of the span it replaced, and the turn list with '
  + 'each turn\'s seq range and first request. Call it when a summary may have dropped something you need, or '
  + 'before a long read: the checkpoint ids it reports are the ids history_read takes, and history_read with '
  + 'view "map" lists the events inside one.'

/** The model-facing description of `history_read`. */
const READ_DESCRIPTION = 'Read this session\'s own earlier history as a role-labeled transcript (User:, Assistant:, '
  + 'Tool result:). Pass a checkpoint id from history_outline to read the span that checkpoint replaced, a seq to '
  + 'read forward from a position, or both together to start inside that span. A page stops at the chars and events '
  + 'budgets and ends with a cursor that continues it; asking for a larger chars (up to the maximum named on the '
  + 'argument) fetches a whole region in one call instead of chaining small pages. Pass view "map" for a '
  + 'one-line-per-event index of the range, which is how you find where in a large span to read. This is the '
  + 'supported way to recover what a compaction summary replaced — do not read or decompress session files.'

/** The model-facing description of `history_search`. */
const SEARCH_DESCRIPTION = 'Find a literal, case-insensitive phrase anywhere in this session\'s own history, '
  + 'including history that compaction has already condensed. Returns each matching event position with the '
  + 'checkpoint that owns it, its role, and a snippet around the match, plus how much was scanned. Use it when you '
  + 'remember a distinctive string, path, error, or identifier but not where it appeared; use history_read to read '
  + 'the surrounding text. This is the supported way to find condensed detail without reading or decompressing '
  + 'session files.'

/** The `history_outline` tool definition. */
function outlineDefinition(ctx, config, reader) {
  return {
    name: 'history_outline',
    description: OUTLINE_DESCRIPTION,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    async execute(_args, exec) {
      const agent = callerOf(exec)
      const { events, index } = recallState(ctx, reader, agent)
      return { text: renderOutline(structureOf(index, events), config.outlineMaxChars) }
    },
  }
}

/** The `history_read` tool definition. */
function readDefinition(ctx, config, reader) {
  return {
    name: 'history_read',
    description: READ_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        checkpoint: {
          type: 'string',
          description: 'Checkpoint id reported by history_outline, such as "c245"; restricts the read to the span that checkpoint replaced.',
        },
        seq: {
          type: 'integer',
          description: 'Event seq to start at, such as one reported by history_outline or history_search; combine with checkpoint to start inside that span.',
        },
        cursor: {
          type: 'string',
          description: 'Cursor line a previous page ended with; continues that page. Carries its own position, so it cannot combine with checkpoint or seq.',
        },
        chars: {
          type: 'integer',
          description: `Page budget in characters (${MIN_PAGE_CHARS} to ${config.readMaxChars}, default ${config.readDefaultChars}); a larger page is cheaper than many small ones.`,
        },
        events: {
          type: 'integer',
          description: `Page budget in events (1 to ${config.readMaxEvents}, default ${config.readDefaultEvents}); in map view it bounds lines.`,
        },
        view: {
          type: 'string',
          enum: [...VIEWS],
          description: '"transcript" (default) renders the text; "map" lists one line per event with its role, size, and preview to find where to read.',
        },
      },
      required: [],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const agent = callerOf(exec)
      const input = readArguments(args, config)
      const { events, index } = recallState(ctx, reader, agent)
      const cap = stepCap(ctx, agent)
      const { target, range, resumeSeq } = resolveRead(input, index, events, cap)
      const collected = input.view === 'map'
        ? collectMap(events, range, resumeSeq, input.events)
        : collectTranscript(events, range, resumeSeq, input.events)
      const pageInput = {
        target,
        events: collected.events,
        maxEvents: input.events,
        maxChars: input.chars,
        moreBeyondBuffer: collected.moreBeyondBuffer,
      }
      const page = input.view === 'map' ? renderSpanMap(pageInput) : renderTranscriptPage(pageInput)
      const remaining = page.cutSeq === null ? 0 : remainingInRange(range, page.cutSeq)
      const budgets = {
        chars: input.chars,
        charsRequested: input.charsRequested,
        events: input.events,
        eventsRequested: input.eventsRequested,
      }
      const finish = input.view === 'map' ? finishSpanMapPage : finishTranscriptPage
      return { text: finish({ page, remaining, budgets }) }
    },
  }
}

/** The `history_search` tool definition. */
function searchDefinition(ctx, config, reader) {
  return {
    name: 'history_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Literal, case-insensitive phrase to find; separate words may match across whitespace.',
        },
        checkpoint: {
          type: 'string',
          description: 'Optional checkpoint id from history_outline; narrows the scan to the span that checkpoint replaced.',
        },
        limit: {
          type: 'integer',
          description: `Maximum number of matches to report (1 to ${config.searchMaxHits}); larger values are capped.`,
        },
        context: {
          type: 'integer',
          description: `Snippet width in characters around each match (80 to ${MAX_SEARCH_CONTEXT}, default ${config.searchDefaultContext}).`,
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const agent = callerOf(exec)
      const input = searchArguments(args, config)
      const { events, index } = recallState(ctx, reader, agent)
      const cap = stepCap(ctx, agent)
      let fromSeq = 0
      let toSeq = Math.min(events.length - 1, cap)
      let seqs
      if (input.checkpoint !== null) {
        const checkpoint = findCheckpoint(index, input.checkpoint)
        fromSeq = checkpoint.startSeq
        toSeq = Math.min(checkpoint.endSeq, cap)
        seqs = checkpoint.seqs
      }
      if (toSeq < fromSeq) {
        return {
          text: renderSearchPage({
            query: input.query,
            hits: [],
            scanned: 0,
            matched: 0,
            truncated: false,
            hitLimit: config.searchMaxHits,
          }),
        }
      }
      const result = searchIn(index, events, {
        query: input.query,
        fromSeq,
        toSeq,
        seqs,
        limit: input.limit,
        context: input.context,
      })
      return {
        text: renderSearchPage({
          query: input.query,
          hits: result.hits,
          scanned: result.scanned,
          matched: result.matched,
          truncated: result.matched > result.hits.length,
          hitLimit: config.searchMaxHits,
        }),
      }
    },
  }
}

/**
 * Build the recall tools against the context whose scope they will serve.
 *
 * A definition is built per registering agent, not once per plugin, because
 * `history_read`'s step boundary is resolved through that agent's own context.
 * @param ctx - the registering agent's context.
 * @param config - the normalized row configuration.
 * @param reader - the per-session index reader.
 * @returns the three definitions, in canonical order.
 */
function recallTools(ctx, config, reader) {
  return [
    outlineDefinition(ctx, config, reader),
    readDefinition(ctx, config, reader),
    searchDefinition(ctx, config, reader),
  ]
}

/**
 * Register the three tools into one agent's own scope, once.
 *
 * Ownership rides the agent's fiber, so disposal and HMR unwind the
 * registration with no bookkeeping here. The visible-set check makes the
 * operation idempotent: re-registering a name already present in this scope
 * would throw (`packages/core/scope/src/store.ts` `NamedEntries.insert`), and a
 * second compaction pass, a repeated `agent/created`, or a reload must not.
 * @param ctx - the plugin context, for diagnostics and the read facade.
 * @param config - the normalized row configuration.
 * @param reader - the per-session index reader.
 * @param agent - the agent whose scope receives the tools.
 */
function registerRecallTools(ctx, config, reader, agent) {
  const tools = agent.ctx?.tools
  if (tools === undefined) {
    // The deployment mounts no tool registry; there is nothing to register into
    // and nothing this listener can do about it, so the pass is dropped quietly.
    ctx.logger?.warn?.('history-access: no tool registry is mounted, so the recall tools stay unregistered')
    return
  }
  for (const definition of recallTools(agent.ctx, config, reader)) {
    if (tools.get(definition.name, agent) !== undefined) continue
    tools.register(definition)
  }
}

/**
 * Register the recall tools at agent creation when the session already carries
 * condensation this plugin never saw.
 *
 * A resume starts from a log whose earlier turns were already replaced by
 * checkpoints, so waiting for the next compaction would leave recall
 * unavailable for a session that may never compact again. The check reads the
 * feed's derived index, which the projection service folds from the in-memory
 * log the resume already loaded.
 * @param ctx - the plugin context.
 * @param config - the normalized row configuration.
 * @param reader - the per-session index reader.
 * @returns the `agent/created` listener.
 */
function creationListener(ctx, config, reader) {
  return ({ agent }) => {
    if (agent?.session === undefined) return
    try {
      const projections = ctx.get('sessionProjections')
      const feed = projections?.stateOf(agent.session, FEED_KEY)
      if (feed === undefined) return
      if (reader.read(agent.session, feed).checkpoints.length === 0) return
      registerRecallTools(ctx, config, reader, agent)
    } catch (error) {
      ctx.logger?.warn?.(`history-access: the recall tools were not registered: ${String(error)}`)
    }
  }
}

/**
 * Build the post-compaction pointer listener.
 *
 * A compaction pass records its summary while it is still running, so the
 * pointer is composed from the `compaction/summary` payload and delivered only
 * when the matching `compaction/end` reports success. Delivery goes through
 * `Agent.inject`, which stages durable context for the next pre-step without
 * waking an idle agent; a failed or repeated pass delivers nothing.
 *
 * The listener also arms the recall tools. That half runs synchronously, while
 * the publishing append's lock is still held, because registering a tool only
 * mutates a registry layer and the next `assemble()` needs it; splicing an
 * inbox, which the host refuses under that lock, is deferred separately below.
 * A pass that reported an `error` condensed nothing and arms nothing.
 * @param ctx - the plugin context.
 * @param config - the normalized row configuration.
 * @param reader - the per-session index reader.
 * @param dedupe - the per-compaction pointer delivery policy.
 * @returns the `session/event` listener.
 */
function pointerListener(ctx, config, reader, dedupe) {
  /** Session id -> compaction id -> the completed checkpoint's pointer facts. */
  const pending = new Map()
  return (session, event) => {
    if (event.type === 'compaction/summary') {
      const data = event.data
      if (typeof data?.compactionId !== 'string') return
      const byId = pending.get(session.id) ?? new Map()
      byId.set(data.compactionId, {
        id: `c${event.seq}`,
        eventCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
        shadowedTokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0,
      })
      pending.set(session.id, byId)
      return
    }
    if (event.type !== 'compaction/end') return
    const compactionId = event.data?.compactionId
    const byId = pending.get(session.id)
    const checkpoint = typeof compactionId === 'string' ? byId?.get(compactionId) : undefined
    pending.delete(session.id)
    // A pass that reported an error condensed nothing, and a pass this plugin
    // joined after its summary has no pointer facts.
    if (event.data?.error !== undefined || checkpoint === undefined) return
    const agent = ctx.get('agents')?.get(session.id)
    // Arming is per session, not per pass, and the registration is idempotent:
    // a session that already registered keeps its tools across every later
    // checkpoint.
    if (agent !== undefined) {
      try {
        registerRecallTools(ctx, config, reader, agent)
      } catch (error) {
        ctx.logger?.warn?.(`history-access: the recall tools were not registered: ${String(error)}`)
      }
    }
    if (config.pointer !== 'inject') return
    if (typeof compactionId !== 'string' || !dedupe.shouldDeliver(compactionId)) return
    if (agent === undefined) return
    // This listener runs inside `Session.append()`, whose append lock is still
    // held, so splicing the inbox here would reenter the log and be refused
    // ("session append cannot reenter while another append is being published").
    // Delivery is deferred past the publishing append, and the pass is recorded
    // as delivered only once the splice succeeded, so a failed delivery is
    // retried by the next `compaction/end` for the same pass.
    queueMicrotask(() => {
      try {
        agent.inject({
          id: `history-access:${compactionId}`,
          role: 'user',
          content: [{ type: 'text', text: pointerText(checkpoint) }],
          source: { kind: 'history-access' },
        })
        dedupe.markDelivered(compactionId)
      } catch (error) {
        // A disposed agent has no inbox; the pointer is dropped rather than
        // surfaced, because nothing in the host awaits this listener's work.
        ctx.logger?.warn?.(`history-access: the post-compaction pointer was not delivered: ${String(error)}`)
      }
    })
  }
}

/**
 * Mount this plugin's event feed, lazy tool registration, and post-compaction pointer.
 *
 * Nothing is registered at apply time except the projection feed: a session
 * that has condensed nothing pays no schema tokens for recall it cannot use,
 * and the feed is what makes the first recall call cheap. See the module
 * comment for the two moments that do register tools.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's configuration, validated here and by {@link Config}.
 */
export async function apply(ctx, rawConfig) {
  const owner = ctx.fiber ?? ctx
  if (applied.has(owner)) return
  applied.add(owner)
  const config = normalizeConfig(rawConfig)
  const reader = createIndexReader()
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) {
    // Without the projection service there is no feed to fold and no recall to
    // serve; the tools stay unregistered rather than failing on every call.
    ctx.logger?.warn?.('history-access: no sessionProjections service is mounted, so the recall tools stay unregistered')
  } else {
    ctx.effect(() => registerEventFeed(projections), 'history-access: event feed')
  }
  // Global listeners: this plugin is commonly mounted once at the root, and a
  // row placed inside a preset's plugin list would otherwise see only that
  // preset's agents — missing every session it is supposed to serve.
  ctx.on('agent/created', creationListener(ctx, config, reader), { global: true })
  ctx.on('session/event', pointerListener(ctx, config, reader, createPointerDedupe()), { global: true })
}
