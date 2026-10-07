/**
 * `dsh-history-access` — model-facing recall of a session's own condensed history.
 *
 * A compaction pass replaces earlier conversation with a summary and leaves the
 * originals in the append-only session log. This plugin gives the model three
 * tools over that log — an outline, a paginated transcript read, and a literal
 * search — so recovering a condensed detail never requires shelling out to read
 * or decompress a session file. Every read is a pure function of the durable
 * log: no index, no embeddings, no second model call.
 *
 * The plugin registers no session event type and stores nothing: out-of-tree
 * event types are refused by the session persistence reader, and
 * `compaction/summary` already records what each checkpoint replaced
 * (`packages/compaction/compaction/src/types.ts`). A post-compaction pointer
 * reaches the model through the documented injection channel
 * (`Agent.inject`, `packages/core/agent/src/runtime-types.ts`).
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

import { Config, normalizeConfig } from './lib/config.js'
import { createPointerDedupe, pointerText } from './lib/pointer.js'
import { createQuery, QueryError } from './lib/query.js'
import { decodeCursor, renderOutline, renderSearchPage, renderTranscriptPage, snippetOf } from './lib/render.js'

export { Config }

/** Cordis plugin name. */
export const name = 'history-access'

/** Fibers this module has already applied to, so a repeated `apply` is a no-op. */
const applied = new WeakSet()

/** Canonical `history_read`/`history_search` parameter keys, in schema order. */
const READ_ARGUMENTS = ['checkpoint', 'seq', 'cursor']
const SEARCH_ARGUMENTS = ['query', 'checkpoint', 'limit']

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
 * Resolve the calling agent's own session id, refusing a caller that has none.
 * @param exec - the tool execution context.
 * @returns the caller's session id.
 * @throws {QueryError} when the call is not agent-bound.
 */
function callerOf(exec) {
  const agent = exec.agent
  if (agent === undefined || agent.session === undefined) {
    throw new QueryError('history recall requires an agent-bound caller')
  }
  return agent.session.id
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
 * Normalize `history_read` arguments.
 * @param raw - the model's raw arguments.
 * @returns the checkpoint id, the start seq, or the continuation cursor — exactly one.
 * @throws {QueryError} when the caller supplied none or more than one.
 */
function readArguments(raw) {
  const args = argumentsOf(raw, READ_ARGUMENTS, 'history_read')
  const checkpoint = args.checkpoint === undefined ? null : args.checkpoint
  const seq = args.seq === undefined ? null : args.seq
  const cursor = args.cursor === undefined ? null : args.cursor
  const supplied = [checkpoint, seq, cursor].filter(value => value !== null)
  if (supplied.length === 0) {
    throw new QueryError('history_read needs one of checkpoint (an id from history_outline), seq (an event position), or cursor (from a previous page)')
  }
  if (supplied.length > 1) {
    throw new QueryError('history_read takes exactly one of checkpoint, seq, or cursor')
  }
  if (checkpoint !== null && (typeof checkpoint !== 'string' || checkpoint.trim().length === 0)) {
    throw new QueryError('history_read checkpoint must be a checkpoint id such as "c245"')
  }
  if (seq !== null && (!Number.isInteger(seq) || seq < 0)) {
    throw new QueryError('history_read seq must be a non-negative integer event position')
  }
  if (cursor !== null && (typeof cursor !== 'string' || decodeCursor(cursor) === null)) {
    throw new QueryError('history_read cursor must be the cursor line a previous page returned')
  }
  return { checkpoint, seq, cursor }
}

/**
 * Normalize `history_search` arguments.
 * @param raw - the model's raw arguments.
 * @param maxHits - the configured hit ceiling.
 * @returns the literal query, the optional checkpoint id, and the hit limit.
 * @throws {QueryError} when the query is missing or the limit is out of range.
 */
function searchArguments(raw, maxHits) {
  const args = argumentsOf(raw, SEARCH_ARGUMENTS, 'history_search')
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    throw new QueryError('history_search needs a non-empty literal query')
  }
  const checkpoint = args.checkpoint === undefined ? null : args.checkpoint
  if (checkpoint !== null && (typeof checkpoint !== 'string' || checkpoint.trim().length === 0)) {
    throw new QueryError('history_search checkpoint must be a checkpoint id such as "c245"')
  }
  const limit = args.limit === undefined ? maxHits : args.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > maxHits) {
    throw new QueryError(`history_search limit must be an integer between 1 and ${maxHits}`)
  }
  return { query: args.query.trim(), checkpoint, limit }
}

/**
 * Find one checkpoint by the id `history_outline` reported.
 * @param structure - the session structure map.
 * @param requested - the id the model passed, with or without its `c` prefix.
 * @returns the checkpoint.
 * @throws {QueryError} listing every id that does exist.
 */
function findCheckpoint(structure, requested) {
  const wanted = String(requested).trim().replace(/^[cC]/u, '')
  const checkpoint = structure.checkpoints.find(entry => entry.summarySeq === Number(wanted))
  if (checkpoint === undefined) {
    const known = structure.checkpoints.length === 0
      ? 'this session has no compaction checkpoints'
      : `this session has ${structure.checkpoints.map(entry => entry.id).join(', ')}`
    throw new QueryError(`unknown checkpoint "${requested}" — ${known}`)
  }
  return checkpoint
}

/** Describe one checkpoint to the transcript renderer. */
function checkpointTarget(checkpoint) {
  return {
    kind: 'checkpoint',
    ref: checkpoint.id,
    id: checkpoint.id,
    startSeq: checkpoint.startSeq,
    endSeq: checkpoint.endSeq,
    eventCount: checkpoint.shadowedSeqs.length,
    shadowedTokenCount: checkpoint.shadowedTokenCount,
    superseded: checkpoint.superseded,
  }
}

/** The model-facing description of `history_outline`. */
const OUTLINE_DESCRIPTION = 'Map this session\'s own history: how many events it holds, every compaction '
  + 'checkpoint with the id, seq range, size, and short summary of the span it replaced, and the turn list with '
  + 'each turn\'s seq range and first request. Call it when a summary may have dropped something you need, or '
  + 'before a long read: the checkpoint ids it reports are the ids history_read and history_search take.'

/** The model-facing description of `history_read`. */
const READ_DESCRIPTION = 'Read this session\'s own earlier history as a role-labeled transcript (User:, Assistant:, '
  + 'Tool result:). Pass a checkpoint id from history_outline to read the exact span that checkpoint replaced, or a '
  + 'seq to read forward from that position; a page ends with a cursor that reads the next page. Text is condensed '
  + 'only when a page is cut, and every cut is marked. This is the supported way to recover what a compaction '
  + 'summary replaced — do not read or decompress session files to get history back.'

/** The model-facing description of `history_search`. */
const SEARCH_DESCRIPTION = 'Find a literal, case-insensitive phrase anywhere in this session\'s own history, '
  + 'including history that compaction has already condensed. Returns each matching event position with the '
  + 'checkpoint that owns it and a snippet around the match, plus how much was scanned. Use it when you remember a '
  + 'distinctive string, path, error, or identifier but not where it appeared; use history_read to read the '
  + 'surrounding text. This is the supported way to find condensed detail without reading or decompressing '
  + 'session files.'

/** The `history_outline` tool definition. */
function outlineDefinition(config, query) {
  return {
    name: 'history_outline',
    description: OUTLINE_DESCRIPTION,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    async execute(_args, exec) {
      const sessionId = callerOf(exec)
      const structure = await query.structure(sessionId, exec.signal)
      return { text: renderOutline(structure, config.outlineMaxChars) }
    },
  }
}

/** The `history_read` tool definition. */
function readDefinition(ctx, config, query) {
  return {
    name: 'history_read',
    description: READ_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        checkpoint: {
          type: 'string',
          description: 'Checkpoint id reported by history_outline, such as "c245"; reads the span that checkpoint replaced.',
        },
        seq: {
          type: 'integer',
          description: 'Event seq to read forward from, such as one reported by history_outline or history_search.',
        },
        cursor: {
          type: 'string',
          description: 'Cursor line a previous history_read page ended with; reads the next page.',
        },
      },
      required: [],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = callerOf(exec)
      const input = readArguments(args)
      const structure = await query.structure(sessionId, exec.signal)
      const cap = stepCap(ctx, exec.agent)
      let target
      let range
      let resumeSeq
      if (input.cursor !== null) {
        const decoded = decodeCursor(input.cursor)
        resumeSeq = decoded.nextSeq
        if (decoded.ref.startsWith('c')) {
          const checkpoint = findCheckpoint(structure, decoded.ref.slice(1))
          target = checkpointTarget(checkpoint)
          range = { fromSeq: checkpoint.startSeq, toSeq: checkpoint.endSeq, seqs: new Set(checkpoint.shadowedSeqs) }
        } else {
          const from = Number(decoded.ref.slice(1))
          target = { kind: 'seq', ref: `s${from}`, seq: from, firstSeq: structure.firstSeq, lastSeq: structure.lastSeq }
          range = { fromSeq: from, toSeq: Math.min(structure.lastSeq, cap), seqs: undefined }
        }
      } else if (input.checkpoint !== null) {
        const checkpoint = findCheckpoint(structure, input.checkpoint)
        target = checkpointTarget(checkpoint)
        range = { fromSeq: checkpoint.startSeq, toSeq: checkpoint.endSeq, seqs: new Set(checkpoint.shadowedSeqs) }
        resumeSeq = checkpoint.startSeq
      } else {
        if (input.seq > structure.lastSeq) {
          throw new QueryError(`seq ${input.seq} is past the end of this session, whose last recorded seq is ${structure.lastSeq}`)
        }
        target = { kind: 'seq', ref: `s${input.seq}`, seq: input.seq, firstSeq: structure.firstSeq, lastSeq: structure.lastSeq }
        range = { fromSeq: input.seq, toSeq: Math.min(structure.lastSeq, cap), seqs: undefined }
        resumeSeq = input.seq
      }
      if (range.toSeq < range.fromSeq) {
        throw new QueryError(
          `seqs ${range.fromSeq} and later belong to the step that is running now; history_read reads history `
          + `recorded before this step, up to seq ${cap}`,
        )
      }
      const page = await query.readPage(sessionId, range, resumeSeq, config.readMaxEvents, exec.signal)
      return {
        text: renderTranscriptPage({
          target,
          events: page.events,
          maxEvents: config.readMaxEvents,
          maxChars: config.readMaxChars,
          moreBeyondBuffer: page.moreBeyondBuffer,
        }).text,
      }
    },
  }
}

/** The `history_search` tool definition. */
function searchDefinition(ctx, config, query) {
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
          description: `Maximum number of matches to report (1 to ${config.searchMaxHits}).`,
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = callerOf(exec)
      const input = searchArguments(args, config.searchMaxHits)
      const structure = await query.structure(sessionId, exec.signal)
      const cap = stepCap(ctx, exec.agent)
      let fromSeq = structure.firstSeq
      let toSeq = Math.min(structure.lastSeq, cap)
      let seqs
      if (input.checkpoint !== null) {
        const checkpoint = findCheckpoint(structure, input.checkpoint)
        fromSeq = checkpoint.startSeq
        toSeq = Math.min(checkpoint.endSeq, cap)
        seqs = new Set(checkpoint.shadowedSeqs)
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
      const result = await query.search(sessionId, {
        query: input.query,
        fromSeq,
        toSeq,
        seqs,
        limit: input.limit,
      }, exec.signal)
      const hits = result.documents.map(document => ({
        seq: document.seq,
        surface: document.surface === 'current' ? 'visible' : document.surface,
        owner: structure.shadowedOwner.get(document.seq) ?? (document.surface === 'current' ? '(visible)' : '(shadowed)'),
        time: document.time,
        snippet: snippetOf(document.text, input.query),
      }))
      return {
        text: renderSearchPage({
          query: input.query,
          hits,
          scanned: result.scanned,
          matched: result.matched,
          truncated: result.matched > hits.length,
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
 * @param query - the shared read facade.
 * @returns the three definitions, in canonical order.
 */
function recallTools(ctx, config, query) {
  return [
    outlineDefinition(config, query),
    readDefinition(ctx, config, query),
    searchDefinition(ctx, config, query),
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
 * @param query - the shared read facade.
 * @param agent - the agent whose scope receives the tools.
 */
function registerRecallTools(ctx, config, query, agent) {
  const tools = agent.ctx?.tools
  if (tools === undefined) {
    // The deployment mounts no tool registry; there is nothing to register into
    // and nothing this listener can do about it, so the pass is dropped quietly.
    ctx.logger?.warn?.('history-access: no tool registry is mounted, so the recall tools stay unregistered')
    return
  }
  for (const definition of recallTools(agent.ctx, config, query)) {
    if (tools.get(definition.name, agent) !== undefined) continue
    tools.register(definition)
  }
}

/**
 * Find a checkpoint sequence to name the pointer of a session this plugin
 * joined late.
 *
 * The live log is indexed by log position, and `SessionSeq` is that position
 * (`packages/core/session/src/index.ts` `append`), so a summary event's index is
 * the seq the `c<summarySeq>` checkpoint id is built from.
 * @param session - the session to inspect.
 * @returns the first recorded checkpoint's seq, or undefined when it has none.
 */
function firstCheckpointSeq(session) {
  const events = session.snapshotEvents?.()
  if (!Array.isArray(events)) return undefined
  for (const [index, event] of events.entries()) {
    if (event.type !== 'compaction/summary') continue
    if (Number.isInteger(event.seq)) return event.seq
    return index
  }
  return undefined
}

/**
 * Register the recall tools at agent creation when the session already carries
 * condensation this plugin never saw.
 *
 * A resume starts from a log whose earlier turns were already replaced by
 * checkpoints, so waiting for the next compaction would leave recall
 * unavailable for a session that may never compact again. The check reads the
 * live log this plugin already holds — one pass over the in-memory event list,
 * no service call — and a resumed session has already paid to load that log.
 * @param ctx - the plugin context.
 * @param config - the normalized row configuration.
 * @param query - the shared read facade.
 * @returns the `agent/created` listener.
 */
function creationListener(ctx, config, query) {
  return ({ agent }) => {
    if (agent?.session === undefined) return
    if (firstCheckpointSeq(agent.session) === undefined) return
    try {
      registerRecallTools(ctx, config, query, agent)
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
 * @param query - the shared read facade.
 * @param dedupe - the per-compaction pointer delivery policy.
 * @returns the `session/event` listener.
 */
function pointerListener(ctx, config, query, dedupe) {
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
        registerRecallTools(ctx, config, query, agent)
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
 * Mount this plugin's lazy tool registration and its post-compaction pointer.
 *
 * Nothing is registered at apply time: a session that has condensed nothing
 * pays no schema tokens for recall it cannot use. See the module comment for
 * the two moments that do register, and why a mid-session addition is carried
 * by the loop rather than special-cased here.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's configuration, validated here and by {@link Config}.
 */
export async function apply(ctx, rawConfig) {
  const owner = ctx.fiber ?? ctx
  if (applied.has(owner)) return
  applied.add(owner)
  const config = normalizeConfig(rawConfig)
  const query = createQuery(ctx)
  // Global listeners: this plugin is commonly mounted once at the root, and a
  // row placed inside a preset's plugin list would otherwise see only that
  // preset's agents — missing every session it is supposed to serve.
  ctx.on('agent/created', creationListener(ctx, config, query), { global: true })
  ctx.on('session/event', pointerListener(ctx, config, query, createPointerDedupe()), { global: true })
}
