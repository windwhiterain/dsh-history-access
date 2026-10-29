/**
 * Read-only decoding of DSH session logs for the offline probes.
 *
 * The log is a concatenation of zstd frames over JSONL records. This module is
 * shared by the acceptance inspector and the performance benchmark so both read
 * exactly the same way; it never writes and never expects a host.
 *
 * @module dsh-history-access/probe/session-log
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The zstd frame magic. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Split one concatenated zstd stream into frames and decompress each.
 * @param buffer - the raw log bytes.
 * @returns the decoded JSONL text.
 */
export function decompressFrames(buffer) {
  const starts = []
  let at = buffer.indexOf(MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(MAGIC, at + 4)
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

/**
 * Read one session log as JSONL text, compressed or plain.
 * @param path - the log file.
 * @returns the decoded text.
 */
export function readLog(path) {
  const bytes = readFileSync(path)
  return path.endsWith('.zstd') ? decompressFrames(bytes) : bytes.toString('utf8')
}

/**
 * Session logs under a sessions root, newest first.
 * @param root - a sessions root or one project directory.
 * @returns the log paths.
 */
export function logsUnder(root) {
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

/**
 * Every record of one session log, tolerating blank and torn lines.
 * @param text - decoded JSONL text.
 * @returns the parsed records.
 */
export function records(text) {
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

/**
 * The event each record carries, accepting both log shapes.
 * @param record - one parsed log record.
 * @returns the event.
 */
export function eventOf(record) {
  return record.event ?? record
}

/**
 * The contiguous event array of one session log.
 *
 * A log's first record may be a session header rather than an event, and every
 * event carries its own position as `seq`; the feed the plugin reads is
 * positional, so the array index and `seq` must agree. A gap means the log was
 * truncated and is refused rather than silently mis-indexed.
 * @param parsed - the parsed records.
 * @returns the events, indexed by seq.
 */
export function eventsOf(parsed) {
  const events = []
  for (const record of parsed) {
    const event = eventOf(record)
    if (!Number.isInteger(event.seq)) continue
    if (event.seq !== events.length) {
      throw new Error(`session log is not contiguous at seq ${event.seq} (position ${events.length})`)
    }
    events.push(event)
  }
  return events
}
