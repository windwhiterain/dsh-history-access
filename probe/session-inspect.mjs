/**
 * Read-only acceptance inspector for dsh-history-access.
 *
 * Decodes one zstd-framed session log (or the newest logs under a sessions
 * root) and reports the evidence that matters for recall: the compaction
 * passes, the pointer each pass injected, the calls this plugin's tools
 * received, and the tool count of the last request header.
 *
 * Usage: node probe/session-inspect.mjs <session-log|sessions-root> [limit]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const TOOL_NAMES = ['history_outline', 'history_read', 'history_search']
const POINTER_PREFIX = 'Context was condensed into checkpoint'

/** Split one concatenated zstd stream into frames and decompress each. */
function decompressFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = buffer.indexOf(magic)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(magic, at + 4)
  }
  const chunks = []
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A trailing partial frame (a write in flight) is simply not read.
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read one session log as JSONL text, compressed or plain. */
function readLog(path) {
  const bytes = readFileSync(path)
  return path.endsWith('.zstd') ? decompressFrames(bytes) : bytes.toString('utf8')
}

/** Session logs under a sessions root, newest first. */
function logsUnder(root) {
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir, session.name)
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('session.v')) continue
        const path = join(dir, file)
        found.push({ path, time: statSync(path).mtimeMs })
      }
    }
  }
  return found.sort((left, right) => right.time - left.time).map(entry => entry.path)
}

/** Concatenated text of one message's content blocks. */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** Every record of one session log, tolerating blank and torn lines. */
function records(text) {
  const parsed = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      parsed.push(JSON.parse(line))
    } catch {
      // A torn trailing line is not a record.
    }
  }
  return parsed
}

/** Report the recall evidence carried by one session log. */
function inspect(path) {
  const all = records(readLog(path))
  const counts = new Map()
  const passes = new Map()
  const pointers = []
  const injections = []
  const calls = []
  let toolNames = []

  for (const record of all) {
    const event = record.event ?? record
    const type = event.type
    if (typeof type !== 'string') continue
    counts.set(type, (counts.get(type) ?? 0) + 1)

    if (type === 'request/header') {
      const names = (event.data?.header?.tools ?? [])
        .map(tool => tool?.name ?? tool?.function?.name)
        .filter(name => typeof name === 'string')
      if (names.length > 0) toolNames = names
    }
    if (type === 'compaction/start') {
      passes.set(event.data?.compactionId, { started: true, finished: false, error: undefined })
    }
    if (type === 'compaction/summary') {
      const pass = passes.get(event.data?.compactionId) ?? {}
      passes.set(event.data?.compactionId, {
        ...pass,
        seq: event.seq,
        shadowed: event.data?.shadowedSeqs?.length ?? 0,
        shadowedTokens: event.data?.shadowedTokenCount ?? 0,
      })
    }
    if (type === 'compaction/end') {
      const pass = passes.get(event.data?.compactionId) ?? {}
      passes.set(event.data?.compactionId, { ...pass, finished: true, error: event.data?.error })
    }
    if (type === 'tool/call' && TOOL_NAMES.includes(event.data?.name)) {
      calls.push({ name: event.data.name, arguments: event.data.arguments, seq: event.seq })
    }
    if (type === 'tool/result') {
      const call = calls.at(-1)
      if (call !== undefined && call.resultChars === undefined) {
        call.resultChars = messageText(event.data?.message).length
      }
    }
    if (type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) && injections.length < 24) {
      for (const inserted of event.data.inserted) {
        injections.push({
          seq: event.seq,
          target: event.data?.target,
          kind: inserted?.source?.kind ?? '?',
          text: messageText(inserted).trim(),
        })
      }
    }
    if (type === 'user/message' && pointers.length < 8) {
      const text = messageText(event.data)
      const kind = event.data?.source?.kind ?? '?'
      // The plugin's own pointer is one injected user message whose source kind
      // it declares itself; a checkpoint or the task prompt may merely mention
      // the tool names, so identity comes from the source, not the text.
      if (kind === 'history-access' || text.startsWith(POINTER_PREFIX)) {
        pointers.push({ seq: event.seq, kind, text: text.trim() })
      }
    }
  }

  const histogram = [...counts.entries()].sort((left, right) => right[1] - left[1])
  return { path, total: all.length, histogram, passes: [...passes.values()], pointers, injections, calls, toolNames }
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node probe/session-inspect.mjs <session-log|sessions-root> [limit]')
  process.exit(2)
}
const isDirectory = statSync(target).isDirectory()
const paths = isDirectory ? logsUnder(target).slice(0, Number(process.argv[3] ?? 3)) : [target]

for (const path of paths) {
  const report = inspect(path)
  console.log(`\n== ${report.path}`)
  console.log(`events=${report.total}  requestHeaderTools=${report.toolNames.length}  historyTools=${TOOL_NAMES.filter(name => report.toolNames.includes(name)).join(',') || '(none)'}`)
  console.log(`types: ${report.histogram.slice(0, 12).map(([type, count]) => `${type}=${count}`).join(' ')}`)
  for (const [index, pass] of report.passes.entries()) {
    console.log(`compaction[${index}] summarySeq=${pass.seq} shadowed=${pass.shadowed} shadowedTokens=${pass.shadowedTokens} finished=${pass.finished} error=${pass.error ?? 'none'}`)
  }
  for (const injection of report.injections) {
    console.log(`injected pointer seq=${injection.seq} target=${injection.target} source=${injection.kind}: ${injection.text.split('\n').join(' | ').slice(0, 300)}`)
  }
  for (const pointer of report.pointers) {
    console.log(`pointer seq=${pointer.seq} source=${pointer.kind}: ${pointer.text.split('\n').join(' | ').slice(0, 400)}`)
  }
  for (const call of report.calls) {
    console.log(`call ${call.name} seq=${call.seq} args=${String(call.arguments).slice(0, 160)} resultChars=${call.resultChars ?? '?'}`)
  }
}
