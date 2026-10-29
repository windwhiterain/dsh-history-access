/**
 * Offline probe for `dsh-history-access`.
 *
 * Runs with no Harness, no host, and no dependency: `node probe/probe.mjs`.
 * It drives `apply()` against an in-memory fake `ctx` whose `tools.register`
 * captures the three definitions and whose `sessionProjections` service folds a
 * synthetic session log exactly the way the real projection registry does — the
 * registered event feed is advanced with `init`/`apply`, and every tool reads
 * its derived index through `stateOf`.
 *
 * The synthetic log contains four turns, an assistant message with a tool call,
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

/** The clock every synthetic event carries. */
const TIME = 1_700_000_000_000

function text(value) {
  return { type: 'text', text: value }
}

function userMessage(seq, value) {
  return {
    seq,
    type: 'user/message',
    time: TIME + seq * 1000,
    surfaceOp: 'append',
    data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [text(value)] },
  }
}

function assistantMessage(seq, blocks) {
  return {
    seq,
    type: 'assistant/message',
    time: TIME + seq * 1000,
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

function toolResult(seq, value, isError = false) {
  return {
    seq,
    type: 'tool/result',
    time: TIME + seq * 1000,
    surfaceOp: 'append',
    data: {
      message: {
        id: `m${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        content: [text(value)],
        isError,
      },
    },
  }
}

function boundary(seq, type, data) {
  return { seq, type, time: TIME + seq * 1000, data }
}

function replacement(seq, startSeq, endSeq, value) {
  return {
    seq,
    type: 'user/message',
    time: TIME + seq * 1000,
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

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

/**
 * Build one fake Cordis context around the plugin's real entry point.
 *
 * The `sessionProjections` fake is faithful in the two ways the plugin relies
 * on: `register` owns a definition and returns its disposer, and `stateOf`
 * folds a session's `__events` through `init`/`apply` once and then advances it
 * event by event. `turnBoundary` is the harness's own projection.
 * @param options - the service overrides, the calling agent's step boundary, and any pre-registered names.
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
  const visible = new Set(options.visible ?? [])
  const disposers = new Map()
  const toolRuntime = {
    register(definition) {
      if (visible.has(definition.name)) throw new Error(`duplicate tool name "${definition.name}"`)
      visible.add(definition.name)
      registered.push(definition)
      const dispose = () => {
        visible.delete(definition.name)
        disposed.push(definition.name)
      }
      disposers.set(definition.name, dispose)
      return dispose
    },
    get(name) {
      return visible.has(name) ? registered.find(entry => entry.name === name) : undefined
    },
  }
  const projections = {
    defs: new Map(),
    cells: new WeakMap(),
    register(definition) {
      this.defs.set(definition.key, definition)
      return () => {
        this.defs.delete(definition.key)
      }
    },
    stateOf(session, key) {
      if (key === 'turnBoundary') {
        if (stepStartSeq === null) return undefined
        return { lastStepStartSeq: stepStartSeq }
      }
      if (options.feedUnavailable === true || options.noProjections === true) return undefined
      const definition = this.defs.get(key)
      if (definition === undefined || session === undefined) return undefined
      let byKey = this.cells.get(session)
      if (byKey === undefined) {
        byKey = new Map()
        this.cells.set(session, byKey)
      }
      let cell = byKey.get(key)
      if (cell === undefined) {
        cell = { state: definition.init(session.header ?? {}, 0), folded: 0 }
        byKey.set(key, cell)
      }
      const events = session.__events ?? []
      for (let seq = cell.folded; seq < events.length; seq += 1) {
        cell.state = definition.apply(cell.state, events[seq])
      }
      cell.folded = events.length
      return cell.state
    },
  }
  function get(name) {
    if (name === 'agents') return options.agents
    if (name === 'sessionProjections') return options.noProjections === true ? undefined : projections
    return undefined
  }
  const ctx = {
    fiber: { label: 'probe' },
    logger: { warn: message => warnings.push(String(message)) },
    tools: toolRuntime,
    effect(run, label) {
      const dispose = run()
      effects.push({ label, dispose })
      return () => {}
    },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    get,
  }
  if (options.agent !== undefined) options.agent.ctx = { tools: toolRuntime, get }
  return { ctx, registered, visible, disposers, listeners, disposed, injected, warnings, effects, projections }
}

/**
 * The calling agent identity every probe executes as.
 * @param injected - the sink an `Agent.inject` call lands in.
 * @param events - the session's recorded events.
 * @returns the fake agent, whose `ctx` the fake context fills in.
 */
function callerAgent(injected, events = []) {
  return {
    session: {
      id: SESSION_ID,
      header: { id: SESSION_ID, cwd: 'C:/probe' },
      __events: [...events],
    },
    ctx: undefined,
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

/** Create the fake agent through the plugin's `agent/created` listener. */
function create(fake) {
  for (const listener of fake.listeners.get('agent/created') ?? []) listener({ agent: fake.agent, source: 'startup' })
}

/**
 * Apply the plugin to one fake context and arm the calling agent.
 * @param options - the fake-context options plus `config`, `events`, and `create`.
 * @returns the fake context and the calling helper.
 */
async function harness(options = {}) {
  const injected = []
  const agent = callerAgent(injected, options.events ?? LOG)
  const fake = fakeContext({ ...options, agent, agents: options.agents ?? { get: () => agent } })
  await apply(fake.ctx, options.config)
  const combined = { ...fake, agent, injected }
  if (options.create !== false) create(combined)
  const exec = { agent, signal: new AbortController().signal, callId: 'call', name: 'history_read', arguments: {} }
  return {
    ...combined,
    exec,
    call: (name, args) => invoke(fake.registered, name, args, exec),
  }
}

/**
 * Apply the plugin without arming any agent.
 * @param options - the fake-context options plus `config` and `events`.
 * @returns the fake context and its agent.
 */
async function unarmed(options = {}) {
  const injected = []
  const agent = callerAgent(injected, options.events ?? [])
  const fake = fakeContext({ ...options, agent, agents: { get: () => agent } })
  await apply(fake.ctx, options.config)
  return { ...fake, agent, injected }
}

/** Deliver one completed compaction pass to the plugin's session listener. */
function compact(fake, { compactionId = 'cmp-1', error, shadowedSeqs = [4, 5, 6, 7], shadowedTokenCount = 4812 } = {}) {
  const listener = fake.listeners.get('session/event')[0]
  const session = fake.agent.session
  const seq = session.__events.length
  const summary = {
    type: 'compaction/summary',
    seq,
    time: TIME,
    data: { compactionId, summary: [text('Probe checkpoint summary.')], shadowedSeqs, shadowedTokenCount },
  }
  session.__events.push(summary)
  listener(session, summary)
  const end = {
    type: 'compaction/end',
    seq: seq + 1,
    time: TIME,
    data: { compactionId, turn: null, ...error === undefined ? {} : { error } },
  }
  session.__events.push(end)
  listener(session, end)
}

/** Every `(seq N)` marker a transcript page printed. */
function seqsIn(text) {
  return [...text.matchAll(/\(seq (\d+)\)/gu)].map(match => Number(match[1]))
}

/** Every `seq N |` position a span map printed. */
function mapSeqsIn(text) {
  return [...text.matchAll(/^seq (\d+) \|/gmu)].map(match => Number(match[1]))
}

/** The seqs a rendered search page reports. */
function seqsInSearch(text) {
  return [...text.matchAll(/^(\d+)\. seq (\d+) \|/gmu)].map(match => Number(match[2]))
}

// ---------------------------------------------------------------------------
// Lazy tool registration
// ---------------------------------------------------------------------------

/** The three model-visible tool names this plugin owns. */
const TOOL_NAMES = Object.freeze(['history_outline', 'history_read', 'history_search'])

await test('apply() registers no tools and exactly one event feed, so a session that condensed nothing pays no schema tokens', async () => {
  const fake = await unarmed()
  assert.deepEqual(fake.registered, [])
  assert.equal(fake.listeners.get('agent/created').length, 1)
  assert.equal(fake.listeners.get('session/event').length, 1)
  assert.equal(fake.effects.length, 1, 'the event feed is registered as one fiber effect')
})

await test('creating a session with no checkpoint registers nothing', async () => {
  const fake = await unarmed()
  create(fake)
  assert.deepEqual(fake.registered, [])
})

await test('a completed compaction arms exactly the three recall tools in the agent scope', async () => {
  const fake = await unarmed()
  compact(fake)
  assert.deepEqual(fake.registered.map(definition => definition.name), TOOL_NAMES)
  assert.equal(fake.listeners.get('session/event').length, 1)
})

await test('a failed compaction pass arms nothing and leaves the next pass free to arm', async () => {
  const fake = await unarmed()
  compact(fake, { error: 'summarize failed' })
  assert.deepEqual(fake.registered, [])
  compact(fake)
  assert.deepEqual(fake.registered.map(definition => definition.name), TOOL_NAMES)
})

await test('later compaction passes do not register a second copy', async () => {
  const fake = await unarmed()
  compact(fake)
  compact(fake, { compactionId: 'cmp-2', seq: 30 })
  assert.deepEqual(fake.registered.map(definition => definition.name), TOOL_NAMES)
  assert.equal(fake.visible.size, 3)
})

await test('creating an agent whose session already carries a checkpoint arms the tools', async () => {
  const fake = await unarmed({ events: LOG })
  assert.deepEqual(fake.registered, [])
  create(fake)
  assert.deepEqual(fake.registered.map(definition => definition.name), TOOL_NAMES)
})

await test('a compaction pass with no live agent arms nothing and does not throw', async () => {
  const injected = []
  const agent = callerAgent(injected, LOG)
  const fake = fakeContext({ agent, agents: { get: () => undefined } })
  await apply(fake.ctx, {})
  compact({ ...fake, agent })
  assert.deepEqual(fake.registered, [])
  assert.deepEqual(fake.warnings, [])
  assert.equal(injected.length, 0)
})

await test('every tool declares a raw JSON Schema and an object-rooted output', async () => {
  const h = await harness()
  assert.deepEqual(h.registered.map(definition => definition.name), TOOL_NAMES)
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

await test('history_outline takes no arguments and every other tool declares its own schema', async () => {
  const h = await harness()
  const outline = h.registered.find(entry => entry.name === 'history_outline')
  const read = h.registered.find(entry => entry.name === 'history_read')
  const search = h.registered.find(entry => entry.name === 'history_search')
  assert.deepEqual(Object.keys(outline.parameters.properties), [])
  assert.deepEqual(Object.keys(read.parameters.properties), ['checkpoint', 'seq', 'cursor', 'chars', 'events', 'view'])
  assert.deepEqual(read.parameters.properties.view.enum, ['transcript', 'map'])
  assert.deepEqual(search.parameters.required, ['query'])
  assert.deepEqual(Object.keys(search.parameters.properties), ['query', 'checkpoint', 'limit', 'context'])
})

await test('the agent scope owns the registration, and unwinding it removes only its own three tools', async () => {
  const h = await harness()
  const other = await harness()
  assert.deepEqual(h.registered.map(definition => definition.name), TOOL_NAMES)
  for (const definition of h.registered) {
    const disposer = h.disposers.get(definition.name)
    assert.equal(typeof disposer, 'function', `${definition.name} registration returned its own disposer`)
    disposer()
  }
  assert.equal(h.visible.size, 0)
  assert.deepEqual([...h.disposed].sort(), [...TOOL_NAMES].sort())
  assert.equal(other.visible.size, 3, 'another agent scope keeps its own tools')
})

await test('apply() is idempotent on the same fiber', async () => {
  const fake = await unarmed()
  await apply(fake.ctx, {})
  assert.equal(fake.listeners.get('agent/created').length, 1)
  assert.equal(fake.listeners.get('session/event').length, 1)
  assert.equal(fake.effects.length, 1)
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
  assert.match(text, /^history_read checkpoint c20 — shadowed seqs 4-10, 4 events, ~48210 tokens, superseded by c30/)
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

await test('history_read combines checkpoint and seq to start inside a span', async () => {
  const h = await harness()
  const text = await h.call('history_read', { checkpoint: 'c20', seq: 5 })
  assert.deepEqual(seqsIn(text), [5, 7, 10])
  const clamped = await h.call('history_read', { checkpoint: 'c20', seq: 2 })
  assert.deepEqual(seqsIn(clamped), CHECKPOINT_ONE_SEQS, 'a seq before the span starts at the span start')
  await rejects(
    () => h.call('history_read', { checkpoint: 'c20', seq: 30 }),
    /seq 30 is past the end of c20, whose span ends at seq 10/,
  )
})

await test('history_read pages a shadowed span with a working cursor and no duplicated or skipped events', async () => {
  const h = await harness()
  const seen = []
  let cursor
  let pages = 0
  do {
    const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c20', events: 2 } : { cursor })
    pages += 1
    seen.push(...seqsIn(text))
    cursor = /^cursor: (.+)$/mu.exec(text)?.[1]
    assert.ok(pages < 10, 'paging terminates')
  } while (cursor !== undefined)
  assert.equal(pages, 2)
  assert.deepEqual(seen, CHECKPOINT_ONE_SEQS)
})

await test('a cursor carries the budgets of the page it continues', async () => {
  const h = await harness()
  const first = await h.call('history_read', { checkpoint: 'c30', events: 2, chars: 4000 })
  const cursor = /^cursor: (.+)$/mu.exec(first)?.[1]
  assert.ok(cursor, 'the first page cuts')
  assert.match(cursor, /@4000@2$/u)
  const second = await h.call('history_read', { cursor })
  assert.match(second, /budget 4000 chars \/ 2 events/)
})

await test('history_read pages a span whose shadowed seqs are not ascending', async () => {
  const h = await harness()
  const seen = []
  let cursor
  do {
    const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c30', events: 2 } : { cursor })
    seen.push(...seqsIn(text))
    cursor = /^cursor: (.+)$/mu.exec(text)?.[1]
  } while (cursor !== undefined)
  assert.deepEqual(seen, [15, 16, 21, 25, 26])
  assert.deepEqual([...seen].sort((left, right) => left - right), [...CHECKPOINT_TWO_SEQS].sort((left, right) => left - right))
})

await test('history_read truncates one event explicitly when it cannot fit the page', async () => {
  const h = await harness()
  const text = await h.call('history_read', { seq: 7, chars: 1200 })
  assert.match(text, /Tool result \(seq 7\): export function retryBudget\(\) \{ return 3 \} \[e7\]/)
  assert.match(text, /… \[\+\d+ chars\]/)
  assert.ok(text.length <= 1200, `page is within budget (${text.length})`)
})

await test('history_read keeps every page inside the requested chars across budgets', async () => {
  for (const chars of [1200, 2000, 4000, 8000]) {
    const h = await harness()
    let cursor
    do {
      const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c30', chars } : { cursor, chars })
      assert.ok(text.length <= chars, `page of ${text.length} chars fits ${chars}`)
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

await test('history_read needs a selector, rejects a duplicate range, and validates the cursor', async () => {
  const h = await harness()
  await rejects(() => h.call('history_read', {}), /needs checkpoint .* seq .* or cursor/)
  await rejects(() => h.call('history_read', { cursor: 'not-a-cursor' }), /cursor must be the cursor line/)
  await rejects(
    () => h.call('history_read', { cursor: 'c20@4@24000@120', checkpoint: 'c20' }),
    /cursor already carries its position; omit checkpoint and seq/,
  )
})

await test('history_read refuses arguments outside its schema and a seq past the end', async () => {
  const h = await harness()
  await rejects(
    () => h.call('history_read', { offset: 3 }),
    /does not accept "offset" \(it accepts checkpoint, seq, cursor, chars, events, view\)/,
  )
  await rejects(() => h.call('history_read', { seq: 900 }), /seq 900 is past the end of this session, whose last recorded seq is 36/)
})

await test('history_read clamps an oversized or undersized budget instead of failing', async () => {
  const h = await harness()
  const small = await h.call('history_read', { checkpoint: 'c20', chars: 10 })
  assert.match(small, /budget 1200 chars \(capped from 10\)/)
  const large = await h.call('history_read', { checkpoint: 'c20', events: 9999 })
  assert.match(large, /budget 24000 chars \/ 1000 events \(capped from 9999\)/)
})

await test('history_read view "map" lists one line per navigation event and skips bulk results', async () => {
  const h = await harness()
  const text = await h.call('history_read', { checkpoint: 'c20', view: 'map' })
  assert.match(text, /^history_read map checkpoint c20 — shadowed seqs 4-10/)
  assert.deepEqual(mapSeqsIn(text), [4, 5, 10])
  assert.match(text, /^seq 5 \| Assistant \| \d+ \| I will inspect the retry helper first/mu)
  assert.equal(text.includes('(seq 7)'), false, 'a successful tool result is not a map entry')
})

await test('history_read map pages by its line budget with a working cursor', async () => {
  const h = await harness()
  const seen = []
  let cursor
  do {
    const text = await h.call('history_read', cursor === undefined ? { checkpoint: 'c20', view: 'map', events: 1 } : { cursor, view: 'map' })
    seen.push(...mapSeqsIn(text))
    cursor = /^cursor: (.+)$/mu.exec(text)?.[1]
  } while (cursor !== undefined)
  assert.deepEqual(seen, [4, 5, 10])
})

await test('history_read refuses to read into the executing step', async () => {
  const h = await harness()
  await rejects(() => h.call('history_read', { seq: 35 }), /belong to the step that is running now/)
  const capped = await h.call('history_read', { seq: 31 })
  assert.deepEqual(seqsIn(capped), [31])
})

// ---------------------------------------------------------------------------
// history_search
// ---------------------------------------------------------------------------

await test('history_search finds text that exists only inside a shadowed span and names its checkpoint', async () => {
  const h = await harness()
  const text = await h.call('history_search', { query: 'retryBudget' })
  assert.match(text, /^history_search "retryBudget" — \d+ events scanned, \d+ matched, showing \d+/)
  assert.match(text, /\n1\. seq 7 \| shadowed \| c20 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \| Tool result\n/)
  assert.match(text, /export function retryBudget\(\) \{ return 3 \}/)
  assert.match(text, /scanned \d+, matched \d+, truncated false/)
})

await test('history_search reports a currently visible hit as visible and names no checkpoint', async () => {
  const h = await harness({ stepStartSeq: 999 })
  const text = await h.call('history_search', { query: 'UNIQUE-CURRENT-STEP-MARKER' })
  assert.match(text, /1\. seq 35 \| visible \| \(visible\) \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \| User/)
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
  assert.match(narrow, /scanned 4, matched 1/)
  await rejects(() => h.call('history_search', { checkpoint: 'c7', query: 'x' }), /unknown checkpoint "c7"/)
})

await test('history_search clamps an oversized hit limit and says how to narrow', async () => {
  const h = await harness({ config: { searchMaxHits: 2 } })
  const text = await h.call('history_search', { query: 'retry', limit: 5 })
  assert.match(text, /showing 2 of \d+/)
  assert.match(text, /narrow with checkpoint or a more distinctive phrase \(limit max 2\)/)
})

await test('history_search widens each snippet to the requested context', async () => {
  const h = await harness()
  const narrow = await h.call('history_search', { query: 'retry budget', context: 100 })
  const snippet = /^   (.*)$/mu.exec(narrow)?.[1] ?? ''
  assert.ok(snippet.length <= 104, `snippet of ${snippet.length} chars respects context 100`)
})

await test('history_search with no matches explains the literal scan and points at the map', async () => {
  const h = await harness()
  const text = await h.call('history_search', { query: 'no-such-phrase-anywhere' })
  assert.match(text, /No matches\. The scan is a literal, case-insensitive text match/)
  assert.match(text, /Call history_outline to list the compaction checkpoints, then map or read/)
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

// ---------------------------------------------------------------------------
// Caller identity, the feed, and configuration
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

await test('a session without a materialized feed fails model-safely', async () => {
  const fake = await unarmed({ events: LOG, feedUnavailable: true })
  compact(fake)
  assert.deepEqual(fake.registered.map(definition => definition.name), TOOL_NAMES)
  const exec = { agent: fake.agent, signal: new AbortController().signal }
  await rejects(
    () => fake.registered.find(entry => entry.name === 'history_read').execute({ checkpoint: 'c20' }, exec),
    /history recall is not indexed for this session yet/,
  )
})

await test('a deployment without the projection service warns and registers no feed', async () => {
  const fake = await unarmed({ noProjections: true })
  assert.equal(fake.effects.length, 0)
  assert.match(fake.warnings.join('\n'), /no sessionProjections service is mounted/)
  create(fake)
  assert.deepEqual(fake.registered, [])
})

await test('configuration defaults apply and every field is validated at load', async () => {
  assert.deepEqual(normalizeConfig(undefined), {
    readDefaultChars: 24000,
    readMaxChars: 200000,
    readDefaultEvents: 120,
    readMaxEvents: 1000,
    searchMaxHits: 20,
    searchDefaultContext: 600,
    outlineMaxChars: 4000,
    pointer: 'inject',
  })
  assert.throws(() => normalizeConfig({ nope: 1 }), error => error instanceof ConfigError
    && /unknown configuration field "nope" \(known fields: readDefaultChars, readMaxChars, readDefaultEvents, readMaxEvents, searchMaxHits, searchDefaultContext, outlineMaxChars, pointer\)/.test(error.message))
  assert.throws(() => normalizeConfig({ readDefaultEvents: 0 }), /readDefaultEvents must be an integer between 1 and 1000 \(got 0\)/)
  assert.throws(() => normalizeConfig({ readDefaultEvents: 1.5 }), /readDefaultEvents must be an integer between 1 and 1000 \(got 1\.5\)/)
  assert.throws(() => normalizeConfig({ readMaxChars: 1000 }), /readMaxChars must be an integer between 1200 and 2000000/)
  assert.throws(() => normalizeConfig({ searchMaxHits: 5000 }), /searchMaxHits must be an integer between 1 and 200/)
  assert.throws(() => normalizeConfig({ pointer: 'yes' }), /pointer must be one of "inject", "off" \(got "yes"\)/)
  assert.throws(() => normalizeConfig('nope'), /configuration must be an object/)
  assert.throws(
    () => normalizeConfig({ readDefaultChars: 300000 }),
    /readDefaultChars must not exceed readMaxChars \(got 300000 > 200000\)/,
  )
  assert.throws(
    () => normalizeConfig({ readDefaultEvents: 500, readMaxEvents: 100 }),
    /readDefaultEvents must not exceed readMaxEvents \(got 500 > 100\)/,
  )
})

await test('the exported Config is a Standard Schema adapter reporting issues instead of throwing', async () => {
  const ok = Config['~standard'].validate({ readDefaultEvents: 5 })
  assert.equal(ok.value.readDefaultEvents, 5)
  const bad = Config['~standard'].validate({ readDefaultEvents: -1 })
  assert.equal(bad.value, undefined)
  assert.match(bad.issues[0].message, /readDefaultEvents must be an integer between 1 and 1000/)
  assert.deepEqual(bad.issues[0].path, ['readDefaultEvents'])
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

await test('pointer: off suppresses the pointer and still arms the tools', async () => {
  const h = await harness({ config: { pointer: 'off' } })
  const listener = h.listeners.get('session/event')[0]
  listener({ id: SESSION_ID }, { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-7', shadowedSeqs: [4], shadowedTokenCount: 10 } })
  listener({ id: SESSION_ID }, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-7', turn: null } })
  await Promise.resolve()
  assert.equal(h.injected.length, 0)
  assert.deepEqual(h.registered.map(definition => definition.name), TOOL_NAMES)
})

await test('an unavailable agent and a throwing injection never escape the listener', async () => {
  const silent = fakeContext({ agents: { get: () => undefined } })
  await apply(silent.ctx, {})
  const noAgent = silent.listeners.get('session/event')[0]
  noAgent({ id: SESSION_ID }, { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-1', shadowedSeqs: [4], shadowedTokenCount: 1 } })
  noAgent({ id: SESSION_ID }, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-1' } })
  assert.deepEqual(silent.registered, [], 'a pass with no live agent arms nothing')

  // The agent has its own context here, so the only warning left is the one the
  // injection itself raises when the inbox is gone.
  const injected = []
  const disposed = callerAgent(injected, LOG)
  disposed.inject = () => { throw new Error('agent disposed') }
  const throwing = fakeContext({ agent: disposed, agents: { get: () => disposed } })
  await apply(throwing.ctx, {})
  const failing = throwing.listeners.get('session/event')[0]
  failing({ id: SESSION_ID }, { type: 'compaction/summary', seq: 20, data: { compactionId: 'cmp-1', shadowedSeqs: [4], shadowedTokenCount: 1 } })
  failing({ id: SESSION_ID }, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-1' } })
  await Promise.resolve()
  assert.equal(throwing.warnings.length, 1)
  assert.match(throwing.warnings[0], /the post-compaction pointer was not delivered: Error: agent disposed/)
  assert.deepEqual(throwing.registered.map(definition => definition.name), TOOL_NAMES, 'a failed pointer still arms the tools')
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
