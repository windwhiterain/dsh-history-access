/**
 * Offline probe for `dsh-history-access`.
 *
 * Runs with no Harness, no host, and no dependency: `node probe/probe.mjs`.
 * It drives `apply()` against an in-memory fake `ctx` whose `tools.register`
 * captures the three definitions, and a fake `sessionQuery` serving a synthetic
 * session log that contains four turns, an assistant message with a tool call,
 * matching tool results, two compaction checkpoints (the second superseding the
 * first), and the replacement `user/message` events that carry their
 * `surfaceOp: { op: 'replace', … }` markers.
 */

import assert from 'node:assert/strict'
import { Config, ConfigError, normalizeConfig } from '../lib/config.js'
import { createPointerDedupe, pointerText } from '../lib/pointer.js'
import { apply } from '../index.js'

let probes = 0

/**
 * Run one probe, counting it only when it completes.
 * @param name - what the probe asserts.
 * @param run - the probe body.
 */
async function test(name, run) {
  try {
    await run()
  } catch (error) {
    console.error(`not ok ${probes + 1} - ${name}`)
    throw error
  }
  probes += 1
  console.log(`ok ${probes} - ${name}`)
}

/** Assert that one call rejects with a message matching `pattern`. */
async function rejects(run, pattern) {
  try {
    await run()
  } catch (error) {
    assert.match(String(error.message), pattern)
    return error
  }
  return assert.fail(`expected a rejection matching ${pattern}`)
}

// ---------------------------------------------------------------------------
// The synthetic session log
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-under-probe'

function text(value) {
  return { type: 'text', text: value }
}

function userMessage(seq, value) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq * 1000,
    surfaceOp: 'append',
    data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [text(value)] },
  }
}

function assistantMessage(seq, blocks) {
  return {
    seq,
    type: 'assistant/message',
    time: 1_700_000_000_000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      message: {
        id: `m${seq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'probe', model: 'probe' },
        content: blocks,
      },
    },
  }
}

function toolResult(seq, value) {
  return {
    seq,
    type: 'tool/result',
    time: 1_700_000_000_000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      message: {
        id: `m${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        content: [text(value)],
        isError: false,
      },
    },
  }
}

function boundary(seq, type, data) {
  return { seq, type, time: 1_700_000_000_000 + seq * 1000, data }
}

function replacement(seq, startSeq, endSeq, value) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq * 1000,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [startSeq, endSeq],
    data: {
      id: `m${seq}`,
      role: 'user',
      source: { kind: 'compact-checkpoint' },
      content: [text(value)],
    },
  }
}

function compactionSummary(seq, compactionId, value, shadowedSeqs, shadowedTokenCount) {
  return boundary(seq, 'compaction/summary', {
    compactionId,
    summary: [text(value)],
    shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) },
    shadowedSeqs,
    shadowedTokenCount,
    provider: 'probe',
    model: 'probe',
  })
}

/** The span checkpoint one replaces: the four surface events of turn one. */
const CHECKPOINT_ONE_SEQS = [4, 5, 7, 10]

/** The span checkpoint two replaces, including checkpoint one's own node. */
const CHECKPOINT_TWO_SEQS = [21, 15, 16, 25, 26]

/** The step boundary the tool calls execute inside. */
const CURRENT_STEP_SEQ = 34

const LOG = [
  boundary(0, 'system/message', { message: { id: 'm0', role: 'system', source: { kind: 'system-prompt' }, content: [text('You are a coding agent.')] } }),
  boundary(1, 'request/header', { header: { tools: [] } }),
  boundary(2, 'turn/start', { turn: 1 }),
  boundary(3, 'step/start', { turn: 1, step: 1 }),
  userMessage(4, 'Fix the failing retry tests in retry.test.ts. [e4]'),
  assistantMessage(5, [
    text('I will inspect the retry helper first. [e5]'),
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"src/retry.ts"}' },
  ]),
  boundary(6, 'tool/call', { callId: 'call-1', name: 'read', arguments: '{"path":"src/retry.ts"}' }),
  toolResult(7, `export function retryBudget() { return 3 } [e7]\n${'// padding line so one event can exceed a small page budget\n'.repeat(60)}`),
  boundary(8, 'step/end', { turn: 1, step: 1 }),
  boundary(9, 'step/start', { turn: 1, step: 2 }),
  assistantMessage(10, [text('The retry budget constant is 3, but retry.test.ts expects 5 attempts. [e10]')]),
  boundary(11, 'step/end', { turn: 1, step: 2 }),
  boundary(12, 'turn/end', { reason: { kind: 'completed' } }),
  boundary(13, 'turn/start', { turn: 2 }),
  boundary(14, 'step/start', { turn: 2, step: 1 }),
  userMessage(15, 'Add a CHANGELOG entry for the retry budget change. [e15]'),
  assistantMessage(16, [text('Adding the CHANGELOG entry now. [e16]')]),
  boundary(17, 'step/end', { turn: 2, step: 1 }),
  boundary(18, 'turn/end', { reason: { kind: 'completed' } }),
  boundary(19, 'compaction/start', { compactionId: 'cmp-1', turn: null }),
  compactionSummary(20, 'cmp-1', 'Checkpoint one: fixed the retry tests; the retry budget is 3 attempts.', CHECKPOINT_ONE_SEQS, 48210),
  replacement(21, 4, 10, '<compacted-summary>Checkpoint one: fixed the retry tests.</compacted-summary>'),
  boundary(22, 'compaction/end', { compactionId: 'cmp-1', turn: null }),
  boundary(23, 'turn/start', { turn: 3 }),
  boundary(24, 'step/start', { turn: 3, step: 1 }),
  userMessage(25, 'Summarise the retry design in one paragraph. [e25]'),
  assistantMessage(26, [text('The design keeps a fixed retry budget of 3 attempts with no backoff. [e26]')]),
  boundary(27, 'step/end', { turn: 3, step: 1 }),
  boundary(28, 'turn/end', { reason: { kind: 'completed' } }),
  boundary(29, 'compaction/start', { compactionId: 'cmp-2', turn: null }),
  compactionSummary(30, 'cmp-2', 'Checkpoint two: the retry budget stays 3 and the CHANGELOG entry is written.', CHECKPOINT_TWO_SEQS, 91044),
  replacement(31, 21, 26, '<compacted-summary>Checkpoint two: retry budget and CHANGELOG.</compacted-summary>'),
  boundary(32, 'compaction/end', { compactionId: 'cmp-2', turn: null }),
  boundary(33, 'turn/start', { turn: 4 }),
  boundary(CURRENT_STEP_SEQ, 'step/start', { turn: 4, step: 1 }),
  userMessage(35, 'UNIQUE-CURRENT-STEP-MARKER please double-check the retry budget. [e35]'),
  assistantMessage(36, [text('I will re-read the retry helper. [e36]')]),
]

/** Fold the synthetic log's surface operations into a seq → surface map. */
function foldSurface(events) {
  const nodes = []
  const surface = new Map()
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      surface.set(event.seq, 'current')
      continue
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    assert.notEqual(startIdx, -1, `replace startSeq ${op.startSeq} is not a surface node`)
    assert.notEqual(endIdx, -1, `replace endSeq ${op.endSeq} is not a surface node`)
    for (const seq of nodes.slice(startIdx, endIdx + 1)) surface.set(seq, 'shadowed')
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    surface.set(event.seq, 'current')
  }
  return surface
}

/** The first-party semantic text one event contributes, mirroring the service's extractor. */
function eventText(event) {
  const contentText = content => (Array.isArray(content) ? content : [])
    .flatMap((block) => {
      if (block.type === 'text') return [block.text]
      if (block.type === 'tool-call') return [block.name, block.arguments]
      return []
    })
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n')
  switch (event.type) {
    case 'user/message': return contentText(event.data.content)
    case 'assistant/message': return contentText(event.data.message.content)
    case 'tool/call': return [event.data.name, event.data.arguments].join('\n')
    case 'tool/result': return contentText(event.data.message.content)
    default: return ''
  }
}

/** The literal, case-insensitive, whitespace-flexible predicate the service applies. */
function textPattern(query) {
  const parts = query.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  return new RegExp(parts.join('\\s+'), 'iu')
}

/**
 * Build the fake `sessionQuery` service over one synthetic log.
 * @param events - the synthetic log.
 * @param windowMax - the deployment's `readWindowMax`, which bounds `after`.
 * @returns the service and its call counters.
 */
function fakeSessionQuery(events, windowMax) {
  const surface = foldSurface(events)
  const calls = { listEvents: 0, readEvent: 0, filterEvents: 0, windowAfter: [] }
  return {
    calls,
    async listEvents() {
      calls.listEvents += 1
      return events.map(event => ({
        sessionId: SESSION_ID,
        seq: event.seq,
        type: event.type,
        time: event.time,
        surface: surface.get(event.seq) ?? 'log-only',
      }))
    },
    async readEvent(request) {
      calls.readEvent += 1
      const { seq, before = 0, after = 0 } = request
      calls.windowAfter.push(after)
      if (after > windowMax) {
        const error = new Error(`after must be an integer between 0 and ${windowMax}`)
        error.code = 'SESSION_QUERY_INVALID_WINDOW'
        throw error
      }
      const target = events[seq]
      if (target === undefined) {
        const error = new Error(`session has no event at seq ${seq}`)
        error.code = 'SESSION_QUERY_EVENT_NOT_FOUND'
        throw error
      }
      const startSeq = Math.max(0, seq - before)
      const endSeq = Math.min(events.length - 1, seq + after)
      return {
        session: { id: SESSION_ID },
        inheritedEventCount: 0,
        target,
        events: events.slice(startSeq, endSeq + 1),
        startSeq,
        endSeq,
      }
    },
    async filterEvents(_sessionId, filters) {
      calls.filterEvents += 1
      const documents = []
      for (const event of events) {
        const value = eventText(event)
        if (value.length === 0) continue
        documents.push({
          sessionId: SESSION_ID,
          seq: event.seq,
          type: event.type,
          time: event.time,
          surface: surface.get(event.seq) ?? 'log-only',
          text: value,
        })
      }
      return documents.filter(document => filters.every((filter) => {
        switch (filter.kind) {
          case 'seq': return (filter.from === undefined || document.seq >= filter.from)
            && (filter.to === undefined || document.seq <= filter.to)
          case 'type': return filter.values.includes(document.type)
          case 'surface': return filter.values.includes(document.surface)
          case 'text': return textPattern(filter.text).test(document.text)
          default: throw new Error(`unsupported filter ${filter.kind}`)
        }
      }))
    },
  }
}

/**
 * Build one fake Cordis context around the plugin's real entry point.
 * @param options - the service overrides and the calling agent's step boundary.
 * @returns the context, its captured state, and the registered tool definitions.
 */
function fakeContext(options = {}) {
  const effects = []
  const listeners = new Map()
  const registered = []
  const disposed = []
  const injected = []
  const warnings = []
  const stepStartSeq = options.stepStartSeq === undefined ? CURRENT_STEP_SEQ : options.stepStartSeq
  const ctx = {
    fiber: { label: 'probe' },
    logger: { warn: message => warnings.push(String(message)) },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => disposed.push(definition.name)
      },
    },
    effect(run, label) {
      const dispose = run()
      effects.push({ label, dispose })
      return () => {}
    },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    get(name) {
      if (name === 'sessionQuery') return options.service
      if (name === 'agents') return options.agents
      if (name === 'sessionProjections') {
        return {
          stateOf: (_session, key) => key === 'turnBoundary' ? { lastStepStartSeq: stepStartSeq } : undefined,
        }
      }
      return undefined
    },
  }
  return { ctx, registered, listeners, disposed, injected, warnings, effects }
}

/** The calling agent identity every probe executes as. */
function callerAgent(injected) {
  return {
    session: { id: SESSION_ID, header: { id: SESSION_ID, cwd: 'C:/probe' } },
    inject: message => injected.push(message),
  }
}

/** Execute one registered tool and return its rendered model-facing text. */
async function invoke(registered, name, args, exec) {
  const definition = registered.find(entry => entry.name === name)
  assert.ok(definition, `tool ${name} is registered`)
  const value = await definition.execute(args, exec)
  const content = definition.output.render(args, value)
  assert.deepEqual(content.map(block => block.type), ['text'])
  return content[0].text
}

/** Apply the plugin to one fake context and return its execution helpers. */
async function harness(options = {}) {
  const service = options.noService === true
    ? undefined
    : options.service ?? fakeSessionQuery(LOG, options.windowMax ?? 50)
  const injected = []
  const fake = fakeContext({ ...options, service, agents: { get: () => callerAgent(injected) } })
  await apply(fake.ctx, options.config)
  const signal = new AbortController().signal
  const exec = { agent: callerAgent(injected), signal, callId: 'call', name: 'history_read', arguments: {} }
  return {
    ...fake,
    service,
    injected,
    exec,
    call: (name, args) => invoke(fake.registered, name, args, exec),
  }
}

/** Every `(seq N)` marker a transcript page printed. */
function seqsIn(text) {
  return [...text.matchAll(/\(seq (\d+)\)/gu)].map(match => Number(match[1]))
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

await test('registers exactly the three recall tools under their model-visible names', async () => {
  const h = await harness()
  assert.deepEqual(h.registered.map(definition => definition.name), ['history_outline', 'history_read', 'history_search'])
})

await test('every tool declares a raw JSON Schema and an object-rooted output', async () => {
  const h = await harness()
  for (const definition of h.registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 80, `${definition.name} describes itself`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
    assert.deepEqual(definition.output.schema.required, ['text'])
    assert.equal(typeof definition.execute, 'function')
  }
})

await test('history_outline takes no arguments and history_search requires a query', async () => {
  const h = await harness()
  const outline = h.registered.find(entry => entry.name === 'history_outline')
  const search = h.registered.find(entry => entry.name === 'history_search')
  assert.deepEqual(Object.keys(outline.parameters.properties), [])
  assert.deepEqual(search.parameters.required, ['query'])
  assert.deepEqual(Object.keys(search.parameters.properties), ['query', 'checkpoint', 'limit'])
})

await test('registration and the pointer listener are effect-based, so a dispose unregisters them', async () => {
  const h = await harness()
  assert.equal(h.effects.length, 3)
  assert.deepEqual(h.effects.map(effect => effect.label), [
    'history-access.history_outline',
    'history-access.history_read',
    'history-access.history_search',
  ])
  for (const effect of h.effects) effect.dispose()
  assert.deepEqual(h.disposed, ['history_outline', 'history_read', 'history_search'])
  assert.equal(h.listeners.get('session/event').length, 1)
})

await test('apply() is idempotent on the same fiber', async () => {
  const fake = fakeContext({ service: fakeSessionQuery(LOG, 50), agents: { get: () => undefined } })
  await apply(fake.ctx, {})
  await apply(fake.ctx, {})
  assert.deepEqual(fake.registered.map(definition => definition.name), ['history_outline', 'history_read', 'history_search'])
})

// ---------------------------------------------------------------------------
// history_outline
// ---------------------------------------------------------------------------

await test('history_outline maps the event count, both checkpoints, and the turn list', async () => {
  const h = await harness()
  const text = await h.call('history_outline', {})
  assert.match(text, /history_outline — 37 events, 2 compaction checkpoint\(s\), 4 turn\(s\)/)
  assert.match(text, /c20 \| summary at seq 20 \| shadows 4 events \(seqs 4-10\) \| ~48210 tokens/)
  assert.match(text, /c20 .* superseded by c30 \| "Checkpoint one: fixed the retry tests/)
  assert.match(text, /c30 \| summary at seq 30 \| shadows 5 events \(seqs 15-26\) \| ~91044 tokens/)
  assert.match(text, /c30 .* \| current \| "Checkpoint two: the retry budget stays 3/)
  assert.match(text, /#1 seqs 2-12 \(11 events, shadowed\) — "Fix the failing retry tests in retry\.test\.ts\. \[e4\]"/)
  assert.match(text, /#4 seqs 33-36 \(4 events, visible\) — "UNIQUE-CURRENT-STEP-MARKER/)
})

await test('history_outline keeps every checkpoint and elides turns when the budget is tight', async () => {
  const h = await harness({ config: { outlineMaxChars: 400 } })
  const text = await h.call('history_outline', {})
  assert.match(text, /c20 \|/)
  assert.match(text, /c30 \|/)
  assert.match(text, /… \[\+\d+ turns elided to stay within the outline budget/)
})

// ---------------------------------------------------------------------------
// history_read
// ---------------------------------------------------------------------------

await test('history_read renders a shadowed span as a role-labeled transcript', async () => {
  const h = await harness()
  const text = await h.call('history_read', { checkpoint: 'c20' })
  assert.match(text, /^history_read checkpoint c20 — shadowed seqs 4-10, 4 events, ~48210 tokens, superseded/)
  assert.deepEqual(seqsIn(text), CHECKPOINT_ONE_SEQS)
  assert.match(text, /User \(seq 4\): Fix the failing retry tests/)
  assert.match(text, /Assistant \(seq 5\): I will inspect the retry helper first\./)
  assert.match(text, /\[tool call\] read \{"path":"src\/retry\.ts"\}/)
  assert.match(text, /Tool result \(seq 7\): export function retryBudget\(\) \{ return 3 \}/)
  assert.match(text, /Assistant \(seq 10\): The retry budget constant is 3/)
  assert.match(text, /… \[end of this range\]/)
})

await test('history_read never emits raw event JSON or surface markers', async () => {
  const h = await harness()
  const text = await h.call('history_read', { checkpoint: 'c30' })
  for (const forbidden of ['"surfaceOp"', 'surfaceOp', '"type":"user/message"', 'sourceEventSeqs', '"role":"assistant"', '{"seq"']) {
    assert.equal(text.includes(forbidden), false, `transcript must not contain ${forbidden}`)
  }
  assert.match(text, /User \(seq 21\): <compacted-summary>Checkpoint one: fixed the retry tests\./)
})

await test('history_read pages a shadowed span with a working cursor and no duplicated or skipped events', async () => {
  const h = await harness({ config: { readMaxEvents: 2, readMaxChars: 8000 } })
  const seen = []
  let cursor
  let pages = 0
  do {
    const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c20' } : { cursor })
    pages += 1
    seen.push(...seqsIn(text))
    cursor = /^cursor: (.+)$/mu.exec(text)?.[1]
    assert.ok(pages < 10, 'paging terminates')
  } while (cursor !== undefined)
  assert.equal(pages, 2)
  assert.deepEqual(seen, CHECKPOINT_ONE_SEQS)
})

await test('history_read pages a span whose shadowed seqs are not ascending', async () => {
  const h = await harness({ config: { readMaxEvents: 2 } })
  const seen = []
  let cursor
  do {
    const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c30' } : { cursor })
    seen.push(...seqsIn(text))
    cursor = /^cursor: (.+)$/mu.exec(text)?.[1]
  } while (cursor !== undefined)
  assert.deepEqual(seen, [15, 16, 21, 25, 26])
  assert.deepEqual([...seen].sort((left, right) => left - right), [...CHECKPOINT_TWO_SEQS].sort((left, right) => left - right))
})

await test('history_read truncates one event explicitly when it cannot fit the page', async () => {
  const h = await harness({ config: { readMaxChars: 400, readMaxEvents: 80 } })
  const text = await h.call('history_read', { seq: 7 })
  assert.match(text, /Tool result \(seq 7\): export function retryBudget\(\) \{ return 3 \} \[e7\]/)
  assert.match(text, /… \[\+\d+ chars\]/)
  assert.ok(text.length <= 400, `page is within budget (${text.length})`)
})

await test('history_read keeps every page inside readMaxChars across budgets', async () => {
  for (const readMaxChars of [400, 500, 800, 1500, 3000]) {
    const h = await harness({ config: { readMaxChars } })
    let cursor
    do {
      const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c30' } : { cursor })
      assert.ok(text.length <= readMaxChars, `page of ${text.length} chars fits ${readMaxChars}`)
      cursor = /^cursor: (.+)$/mu.exec(text)?.[1]
    } while (cursor !== undefined)
  }
})

await test('history_read with seq reads forward from that position', async () => {
  const h = await harness()
  const text = await h.call('history_read', { seq: 7 })
  assert.match(text, /^history_read from seq 7 — this session's history, seqs 0-36/)
  assert.deepEqual(seqsIn(text), [7, 10, 15, 16, 21, 25, 26, 31])
})

await test('history_read rejects an unknown checkpoint and lists the available ids', async () => {
  const h = await harness()
  await rejects(() => h.call('history_read', { checkpoint: 'c999' }), /unknown checkpoint "c999" — this session has c20, c30/)
})

await test('history_read requires exactly one of checkpoint, seq, or cursor', async () => {
  const h = await harness()
  await rejects(() => h.call('history_read', {}), /needs one of checkpoint .* seq .* or cursor/)
  await rejects(() => h.call('history_read', { checkpoint: 'c20', seq: 4 }), /exactly one of checkpoint, seq, or cursor/)
  await rejects(() => h.call('history_read', { cursor: 'not-a-cursor' }), /cursor must be the cursor line/)
})

await test('history_read refuses arguments outside its schema and a seq past the end', async () => {
  const h = await harness()
  await rejects(() => h.call('history_read', { offset: 3 }), /does not accept "offset" \(it accepts checkpoint, seq, cursor\)/)
  await rejects(() => h.call('history_read', { seq: 900 }), /seq 900 is past the end of this session, whose last recorded seq is 36/)
})

// ---------------------------------------------------------------------------
// history_search
// ---------------------------------------------------------------------------

await test('history_search finds text that exists only inside a shadowed span and names its checkpoint', async () => {
  const h = await harness()
  const text = await h.call('history_search', { query: 'retryBudget' })
  assert.match(text, /^history_search "retryBudget" — \d+ events scanned, \d+ matched, showing \d+/)
  assert.match(text, /\n1\. seq 7 \| shadowed \| c20 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\n/)
  assert.match(text, /export function retryBudget\(\) \{ return 3 \}/)
  assert.match(text, /scanned \d+, matched \d+, truncated false/)
})

await test('history_search reports a currently visible hit as visible and names no checkpoint', async () => {
  const h = await harness({ stepStartSeq: 999 })
  const text = await h.call('history_search', { query: 'UNIQUE-CURRENT-STEP-MARKER' })
  assert.match(text, /1\. seq 35 \| visible \| \(visible\) \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/)
  assert.match(text, /UNIQUE-CURRENT-STEP-MARKER please double-check the retry budget/)
  assert.match(text, /scanned \d+, matched 1, truncated false/)
  const lower = await h.call('history_search', { query: 'changelog' })
  assert.match(lower, /1\. seq 15 \| shadowed \| c30 \|/)
  assert.match(lower, /Add a CHANGELOG entry for the retry budget change/)
})

await test('history_search narrows to one checkpoint span', async () => {
  const h = await harness()
  const wide = await h.call('history_search', { query: 'retry budget' })
  const narrow = await h.call('history_search', { checkpoint: 'c20', query: 'retry budget' })
  assert.ok(seqsInSearch(wide).length > seqsInSearch(narrow).length)
  for (const seq of seqsInSearch(narrow)) {
    assert.ok(CHECKPOINT_ONE_SEQS.includes(seq), `seq ${seq} belongs to checkpoint c20`)
  }
  assert.match(narrow, /scanned 4, matched \d+/)
  await rejects(() => h.call('history_search', { checkpoint: 'c7', query: 'x' }), /unknown checkpoint "c7"/)
})

await test('history_search truncates to the configured hit limit and says so', async () => {
  const h = await harness({ config: { searchMaxHits: 2 } })
  const text = await h.call('history_search', { query: 'retry' })
  assert.match(text, /truncated true — showing 2 of \d+; raise limit \(max 2\) or narrow the search with checkpoint\./)
  await rejects(() => h.call('history_search', { query: 'retry', limit: 5 }), /limit must be an integer between 1 and 2/)
})

await test('history_search with no matches explains the literal scan and points at history_outline', async () => {
  const h = await harness()
  const text = await h.call('history_search', { query: 'no-such-phrase-anywhere' })
  assert.match(text, /No matches\. The scan is a literal, case-insensitive text match/)
  assert.match(text, /Call history_outline to list the compaction checkpoints, then history_read/)
  assert.match(text, /scanned \d+, matched 0, truncated false/)
})

await test('history_search requires a non-empty query', async () => {
  const h = await harness()
  await rejects(() => h.call('history_search', {}), /needs a non-empty literal query/)
  await rejects(() => h.call('history_search', { query: '   ' }), /needs a non-empty literal query/)
  await rejects(() => h.call('history_search', { query: 'ok', extra: 1 }), /does not accept "extra"/)
})

await test('history_search excludes the step that is executing it', async () => {
  const h = await harness()
  const text = await h.call('history_search', { query: 'UNIQUE-CURRENT-STEP-MARKER' })
  assert.match(text, /matched 0/)
  assert.match(text, /No matches/)
})

await test('history_read refuses to read into the executing step', async () => {
  const h = await harness()
  await rejects(() => h.call('history_read', { seq: 35 }), /belong to the step that is running now/)
  const capped = await h.call('history_read', { seq: 31 })
  assert.deepEqual(seqsIn(capped), [31])
})

/** The seqs a rendered search page reports. */
function seqsInSearch(text) {
  return [...text.matchAll(/^(\d+)\. seq (\d+) \|/gmu)].map(match => Number(match[2]))
}

// ---------------------------------------------------------------------------
// Caller identity and service failures
// ---------------------------------------------------------------------------

await test('every tool rejects a caller that has no agent', async () => {
  const h = await harness()
  for (const [name, args] of [['history_outline', {}], ['history_read', { checkpoint: 'c20' }], ['history_search', { query: 'x' }]]) {
    await rejects(
      () => h.registered.find(entry => entry.name === name).execute(args, { agent: undefined, signal: h.exec.signal }),
      /history recall requires an agent-bound caller/,
    )
  }
})

await test('a missing session query service produces a model-safe failure', async () => {
  const h = await harness({ noService: true })
  await rejects(() => h.call('history_read', { checkpoint: 'c20' }), /session history recall is unavailable: this deployment mounts no session query service/)
})

await test('service failures are translated and cancellation is preserved exactly', async () => {
  const failing = {
    async listEvents() {
      const error = new Error('persistence is down')
      error.code = 'SESSION_QUERY_PERSISTENCE_FAILED'
      throw error
    },
  }
  const h = await harness({ service: failing })
  await rejects(() => h.call('history_outline', {}), /session history storage is unavailable/)

  const controller = new AbortController()
  const signal = controller.signal
  const exec = { agent: h.exec.agent, signal }
  const h2 = await harness()
  controller.abort(new Error('caller cancelled'))
  await rejects(
    () => h2.registered.find(entry => entry.name === 'history_outline').execute({}, exec),
    /caller cancelled/,
  )
})

await test('the raw-event window adapts to a deployment that caps readWindowMax below the plugin default', async () => {
  const h = await harness({ windowMax: 6, config: { readMaxEvents: 20 } })
  const text = await h.call('history_read', { checkpoint: 'c30' })
  assert.deepEqual(seqsIn(text), [15, 16, 21, 25, 26])
  assert.ok(h.service.calls.windowAfter.some(after => after > 6), 'the oversized attempt was made before adapting')
  assert.ok(h.service.calls.windowAfter.at(-1) <= 6, 'later reads use the adapted window')
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

await test('configuration defaults apply and every field is validated at load', async () => {
  assert.deepEqual(normalizeConfig(undefined), {
    readMaxChars: 8000,
    readMaxEvents: 80,
    searchMaxHits: 20,
    outlineMaxChars: 4000,
    pointer: 'inject',
  })
  assert.throws(() => normalizeConfig({ nope: 1 }), error => error instanceof ConfigError
    && /unknown configuration field "nope" \(known fields: readMaxChars, readMaxEvents, searchMaxHits, outlineMaxChars, pointer\)/.test(error.message))
  assert.throws(() => normalizeConfig({ readMaxEvents: 0 }), /readMaxEvents must be an integer between 1 and 1000 \(got 0\)/)
  assert.throws(() => normalizeConfig({ readMaxEvents: 1.5 }), /readMaxEvents must be an integer between 1 and 1000 \(got 1\.5\)/)
  assert.throws(() => normalizeConfig({ readMaxChars: 399 }), /readMaxChars must be an integer between 400 and 1000000/)
  assert.throws(() => normalizeConfig({ searchMaxHits: 5000 }), /searchMaxHits must be an integer between 1 and 200/)
  assert.throws(() => normalizeConfig({ pointer: 'yes' }), /pointer must be one of "inject", "off" \(got "yes"\)/)
  assert.throws(() => normalizeConfig('nope'), /configuration must be an object/)
})

await test('the exported Config is a Standard Schema adapter reporting issues instead of throwing', async () => {
  const ok = Config['~standard'].validate({ readMaxEvents: 5 })
  assert.equal(ok.value.readMaxEvents, 5)
  const bad = Config['~standard'].validate({ readMaxEvents: -1 })
  assert.equal(bad.value, undefined)
  assert.match(bad.issues[0].message, /readMaxEvents must be an integer between 1 and 1000/)
  assert.deepEqual(bad.issues[0].path, ['readMaxEvents'])
})

// ---------------------------------------------------------------------------
// The post-compaction pointer
// ---------------------------------------------------------------------------

await test('a completed compaction delivers exactly one pointer naming the checkpoint and its size', async () => {
  const h = await harness()
  const listener = h.listeners.get('session/event')[0]
  const session = { id: SESSION_ID }
  const summary = { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-1', shadowedSeqs: CHECKPOINT_ONE_SEQS, shadowedTokenCount: 48210 } }
  const end = { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-1', turn: null } }
  listener(session, summary)
  listener(session, end)
  // `session/event` is dispatched inside `Session.append()`, whose append lock
  // is still held; splicing the inbox synchronously would be refused with
  // "session append cannot reenter while another append is being published".
  assert.equal(h.injected.length, 0, 'delivery is deferred past the publishing append')
  await Promise.resolve()
  assert.equal(h.injected.length, 1)
  const message = h.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'history-access')
  assert.equal(message.id, 'history-access:cmp-1')
  assert.deepEqual(message.content.map(block => block.type), ['text'])
  const text = message.content[0].text
  assert.match(text, /condensed into checkpoint c20: 4 earlier events \(~48210 tokens\)/)
  assert.match(text, /history_read \(checkpoint "c20"\) or history_search to retrieve them/)
  assert.match(text, /do not read or decompress session files/)
  listener(session, summary)
  listener(session, end)
  await Promise.resolve()
  assert.equal(h.injected.length, 1, 'a repeated pass is deduped')
})

await test('a failed compaction pass delivers no pointer and leaves the next pass free', async () => {
  const h = await harness()
  const listener = h.listeners.get('session/event')[0]
  const session = { id: SESSION_ID }
  listener(session, { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-9', shadowedSeqs: [4], shadowedTokenCount: 10 } })
  listener(session, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-9', error: 'summarize failed' } })
  assert.equal(h.injected.length, 0)
  listener(session, { type: 'compaction/summary', seq: 30, data: { compactionId: 'cmp-9', shadowedSeqs: [4, 5], shadowedTokenCount: 20 } })
  listener(session, { type: 'compaction/end', seq: 32, data: { compactionId: 'cmp-9' } })
  await Promise.resolve()
  assert.equal(h.injected.length, 1, 'a later completed pass with the same id still delivers once')
})

await test('the pointer is not registered when it is switched off', async () => {
  const h = await harness({ config: { pointer: 'off' } })
  assert.equal(h.listeners.get('session/event'), undefined)
})

await test('an unavailable agent and a throwing injection never escape the listener', async () => {
  const silent = fakeContext({ service: fakeSessionQuery(LOG, 50), agents: { get: () => undefined } })
  await apply(silent.ctx, {})
  const noAgent = silent.listeners.get('session/event')[0]
  noAgent({ id: SESSION_ID }, { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-1', shadowedSeqs: [4], shadowedTokenCount: 1 } })
  noAgent({ id: SESSION_ID }, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-1' } })

  const throwing = fakeContext({
    service: fakeSessionQuery(LOG, 50),
    agents: { get: () => ({ session: { id: SESSION_ID }, inject() { throw new Error('agent disposed') } }) },
  })
  await apply(throwing.ctx, {})
  const failing = throwing.listeners.get('session/event')[0]
  failing({ id: SESSION_ID }, { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-1', shadowedSeqs: [4], shadowedTokenCount: 1 } })
  failing({ id: SESSION_ID }, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-1' } })
  await Promise.resolve()
  assert.equal(throwing.warnings.length, 1)
  assert.match(throwing.warnings[0], /the post-compaction pointer was not delivered: Error: agent disposed/)
})

await test('pointer text and its dedupe policy are usable without a host', async () => {
  const text = pointerText({ id: 'c245', eventCount: 118, shadowedTokenCount: 48210 })
  assert.equal(text.split('\n').length, 2)
  assert.match(text, /checkpoint c245/)
  assert.match(text, /118 earlier events \(~48210 tokens\)/)
  assert.match(text, /history_read/)
  assert.match(text, /history_search/)
  assert.match(text, /do not read or decompress session files/)
  const dedupe = createPointerDedupe(2)
  assert.equal(dedupe.shouldDeliver('a'), true)
  dedupe.markDelivered('a')
  dedupe.markDelivered('b')
  dedupe.markDelivered('c')
  assert.equal(dedupe.shouldDeliver('a'), true, 'the oldest id is forgotten past the bound')
  assert.equal(dedupe.shouldDeliver('c'), false)
  assert.equal(dedupe.size(), 2)
})

console.log(`\n${probes} probes passed`)
