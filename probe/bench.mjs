/**
 * Offline performance benchmark for `dsh-history-access`.
 *
 * Replays one real session log through the same projection feed state and the
 * same tool path the host uses, and reports the millisecond cost of the first
 * fold, an outline, a transcript page, a span map, and a literal search. It also
 * reports what one `sessionQuery` structure read used to cost, by timing a deep
 * clone of the same event array, so the improvement stays measurable.
 *
 * Read-only, no host: `node probe/bench.mjs <session-log|sessions-root> [limit]`
 *
 * @module dsh-history-access/probe/bench
 */

import { statSync } from 'node:fs'
import { eventsOf, logsUnder, readLog, records } from './session-log.mjs'
import { createIndexReader, structureOf } from '../lib/recall-index.js'
import { collectMap, collectTranscript, remainingInRange, resolveRead, searchIn } from '../lib/query.js'
import {
  finishSpanMapPage,
  finishTranscriptPage,
  renderOutline,
  renderSpanMap,
  renderTranscriptPage,
} from '../lib/render.js'

/** Run one measured call and return its elapsed milliseconds. */
function measure(run) {
  const started = performance.now()
  const value = run()
  return { ms: performance.now() - started, value }
}

/** Fail loudly when a rendered page exceeds its budget. */
function assertWithin(text, budget) {
  if (text.length > budget) throw new Error(`page of ${text.length} chars exceeds its ${budget}-char budget`)
}

/** Format one millisecond reading. */
function ms(value) {
  if (value < 1) return `${(value * 1000).toFixed(0)} µs`
  if (value < 100) return `${value.toFixed(1)} ms`
  return `${Math.round(value)} ms`
}

/**
 * Render one page exactly the way `history_read` does.
 * @param input - the index, events, checkpoint id, view, and budgets.
 * @returns the page text.
 */
function renderPage(input) {
  const { index, events, checkpoint, cursor = null, view, chars, lines } = input
  const cap = events.length - 1
  const { target, range, resumeSeq } = resolveRead(
    { checkpoint: checkpoint ?? null, seq: null, cursor },
    index,
    events,
    cap,
  )
  const collected = view === 'map'
    ? collectMap(events, range, resumeSeq, lines)
    : collectTranscript(events, range, resumeSeq, lines)
  const pageInput = {
    target,
    events: collected.events,
    maxEvents: lines,
    maxChars: chars,
    moreBeyondBuffer: collected.moreBeyondBuffer,
  }
  const page = view === 'map' ? renderSpanMap(pageInput) : renderTranscriptPage(pageInput)
  const remaining = page.cutSeq === null ? 0 : remainingInRange(range, page.cutSeq)
  const budgets = { chars, events: lines }
  return view === 'map'
    ? finishSpanMapPage({ page, remaining, budgets })
    : finishTranscriptPage({ page, remaining, budgets })
}

/**
 * Benchmark one session log.
 * @param path - the log file.
 */
function run(path) {
  const text = readLog(path)
  const events = eventsOf(records(text))
  console.log(`\n== ${path}`)
  console.log(`events=${events.length} decompressedMB=${(text.length / 1_048_576).toFixed(1)}`)

  const session = { id: path }
  const reader = createIndexReader()
  const feed = { events }

  const first = measure(() => reader.read(session, feed))
  const again = measure(() => reader.read(session, feed))
  const index = first.value
  console.log(`index fold (first call): ${ms(first.ms)}   subsequent call: ${ms(again.ms)}`)
  console.log(`checkpoints=${index.checkpoints.length} turns=${index.turns.length} shadowed=${index.owner.size}`)

  const outline = measure(() => {
    const structure = structureOf(index, events)
    return renderOutline(structure, 4000)
  })
  console.log(`history_outline: ${ms(outline.ms)} (${outline.value.length} chars)`)

  const target = [...index.checkpoints].sort((left, right) => right.eventCount - left.eventCount)[0]
  if (target === undefined) {
    console.log('no checkpoint to page')
  } else {
    console.log(`checkpoint ${target.id}: ${target.eventCount} events, ~${target.shadowedTokenCount} tokens`)
    const cases = [
      { label: 'read 24k', view: 'transcript', chars: 24_000, lines: 120 },
      { label: 'read 100k', view: 'transcript', chars: 100_000, lines: 400 },
      { label: 'map 24k', view: 'map', chars: 24_000, lines: 120 },
    ]
    for (const entry of cases) {
      const result = measure(() => renderPage({
        index,
        events,
        checkpoint: target.id,
        view: entry.view,
        chars: entry.chars,
        lines: entry.lines,
      }))
      const text = result.value
      const shut = text.length > entry.chars ? 'OVER BUDGET' : 'within budget'
      console.log(`${entry.label}: ${ms(result.ms)} (${text.length} chars, ${shut})`)
    }
  }

  const query = process.argv[4] ?? 'the'
  const search = measure(() => searchIn(index, events, {
    query,
    fromSeq: 0,
    toSeq: events.length - 1,
    seqs: undefined,
    limit: 20,
    context: 600,
  }))
  console.log(`history_search "${query}": ${ms(search.ms)} (scanned ${search.value.scanned}, matched ${search.value.matched})`)

  const clone = measure(() => structuredClone(events))
  console.log(`reference: one deep clone of this log = ${ms(clone.ms)} (the old per-call cost of one sessionQuery read)`)

  if (target !== undefined) {
    const sample = renderPage({ index, events, checkpoint: target.id, view: 'transcript', chars: 24_000, lines: 120 })
    console.log(`\n--- read sample ---\n${sample.split('\n').slice(0, 6).join('\n')}`)
    const map = renderPage({ index, events, checkpoint: target.id, view: 'map', chars: 24_000, lines: 120 })
    console.log(`\n--- map sample ---\n${map.split('\n').slice(0, 6).join('\n')}`)

    // Walk the whole span and prove the paging contract on real data: every
    // page inside its budget, and no position shown twice.
    const seen = new Set()
    let duplicates = 0
    let cursor = null
    let pages = 0
    const walkStarted = performance.now()
    do {
      const page = renderPage({
        index,
        events,
        checkpoint: target.id,
        cursor,
        view: 'transcript',
        chars: 100_000,
        lines: 400,
      })
      assertWithin(page, 100_000)
      for (const match of page.matchAll(/\(seq (\d+)\)/gu)) {
        const seq = Number(match[1])
        if (seen.has(seq)) duplicates += 1
        seen.add(seq)
      }
      pages += 1
      cursor = /^cursor: (.+)$/mu.exec(page)?.[1] ?? null
    } while (cursor !== null && pages < 500)
    const walkMs = performance.now() - walkStarted
    console.log(
      `paging walk: ${pages} pages, ${seen.size} positions, ${duplicates} duplicates, ${ms(walkMs)} total `
      + `(${ms(walkMs / Math.max(1, pages))}/page)`,
    )
  }
}

const requested = process.argv[2]
if (requested === undefined) {
  console.error('usage: node probe/bench.mjs <session-log|sessions-root> [limit] [query]')
  process.exit(2)
}
const paths = statSync(requested).isDirectory()
  ? logsUnder(requested).slice(0, Number(process.argv[3] ?? 1))
  : [requested]
for (const path of paths) run(path)
