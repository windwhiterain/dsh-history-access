/**
 * Pure rendering of the outline, transcript pages, span maps, and search pages.
 *
 * No I/O, no `ctx`, no clock: every function here is a pure function of values
 * already read from the session feed, so the same inputs always produce the
 * same page. The transcript is role-labeled — `User:`, `Assistant:`,
 * `Tool result:` — because the model reads what a model once saw, never raw
 * event JSON.
 *
 * A page is composed in two phases: `renderTranscriptPage`/`renderSpanMap` fit
 * the body to a budget that reserves room for the header, the status line, and
 * the trailer; `finishPage` adds the exact counts and the continuation cursor.
 * That split lets the caller report how much remains in the range without
 * rendering it.
 *
 * @module dsh-history-access/lib/render
 */

import {
  HEADER_MAX_CHARS,
  MAP_PREVIEW_CHARS,
  eventSize,
  formatSize,
  previewOf,
  previewOfEvent,
  roleLabel,
} from './event-text.js'

/** Marks a page that stopped before the range ended. */
export const CUT_MARKER = '… [page cut; call history_read again with this cursor, or pass a larger chars for one bigger page]'

/** Marks a page that reached the end of its range. */
const END_MARKER = '… [end of this range]'

/** Worst-case length of the trailing `cursor:` line, reserved from the budget. */
const CURSOR_RESERVE = 'cursor: c0000000000000000000@0000000000000000000'.length

/** Characters reserved for the trailer (marker, newline, cursor). */
const TRAILER_RESERVE = CUT_MARKER.length + CURSOR_RESERVE + 2

/** Characters reserved for the status line. */
const STATUS_RESERVE = 220

/** Characters reserved for one outline preview line. */
const PREVIEW_CHARS = 80

/**
 * Format one epoch-millisecond timestamp as a UTC minute label.
 * @param time - event timestamp.
 * @returns a deterministic, timezone-independent label.
 */
export function formatTime(time) {
  if (!Number.isFinite(time)) return 'unknown time'
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/** Render one content block as transcript lines. */
function blockLines(block) {
  switch (block.type) {
    case 'text':
      return String(block.text).split('\n')
    case 'reasoning':
      // Reasoning is a thinking trace, not something the transcript carries.
      return []
    case 'tool-call':
      return [`[tool call] ${block.name} ${block.arguments}`]
    case 'image':
      return ['[image attachment]']
    case 'file':
      return ['[file attachment]']
    default:
      return [`[${String(block.type)} block]`]
  }
}

/** The message one surface event carries. */
function messageOf(event) {
  switch (event.type) {
    case 'user/message':
      return event.data
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return event.data.message
    default:
      return null
  }
}

/**
 * Render one surface event as role-labeled transcript text.
 * @param event - surface event as recorded.
 * @returns the labeled text, or null when the event shows the model nothing.
 */
export function renderEvent(event) {
  const message = messageOf(event)
  if (message === null || !Array.isArray(message.content)) return null
  const label = roleLabel(event)
  const lines = []
  for (const block of message.content) {
    for (const line of blockLines(block)) lines.push(line)
  }
  while (lines.length > 0 && lines.at(-1).trim().length === 0) lines.pop()
  if (lines.length === 0) return null
  return lines
    .map((line, index) => index === 0 ? `${label} (seq ${event.seq}): ${line}` : `  ${line}`)
    .join('\n')
}

/**
 * Validate one cursor continuation string.
 *
 * A cursor carries the page budgets it was produced under as well as the range
 * identity and the resume position, so continuing a page keeps the size the
 * caller chose instead of silently falling back to the deployment default.
 * @param text - the cursor the model passed back.
 * @returns the decoded range reference, resume seq, and budgets, or null when malformed.
 */
export function decodeCursor(text) {
  if (typeof text !== 'string') return null
  const match = /^(c\d+|s\d+)@(\d+)(?:@(\d+)@(\d+))?$/u.exec(text.trim())
  if (match === null) return null
  return {
    ref: match[1],
    nextSeq: Number(match[2]),
    chars: match[3] === undefined ? undefined : Number(match[3]),
    events: match[4] === undefined ? undefined : Number(match[4]),
  }
}

/**
 * Compose the continuation cursor one page hands back.
 * @param ref - the range reference, `c<summarySeq>` for a checkpoint or `s<seq>` for a forward read.
 * @param nextSeq - the first raw seq the next page reads.
 * @param chars - the character budget this page used.
 * @param events - the event or line budget this page used.
 * @returns the cursor string.
 */
export function encodeCursor(ref, nextSeq, chars, events) {
  return `${ref}@${nextSeq}@${chars}@${events}`
}

/** Bound the header line, so the budget reservation always holds. */
function boundedHeader(title) {
  return title.length <= HEADER_MAX_CHARS ? title : `${title.slice(0, HEADER_MAX_CHARS - 1)}…`
}

/** Compose the first line of one transcript page. */
function transcriptTitle(target, view) {
  const prefix = view === 'map' ? 'history_read map' : 'history_read'
  if (target.kind === 'checkpoint') {
    const superseded = target.superseded
      ? target.supersededBy === undefined ? ', superseded' : `, superseded by ${target.supersededBy}`
      : ''
    return boundedHeader(
      `${prefix} checkpoint ${target.id} — shadowed seqs ${target.startSeq}-${target.endSeq}, `
      + `${target.eventCount} events, ~${target.shadowedTokenCount} tokens${superseded}`,
    )
  }
  return boundedHeader(
    `${prefix} from seq ${target.seq} — this session's history, seqs ${target.firstSeq}-${target.lastSeq}`,
  )
}

/** Fit one truncation marker into the remaining room, shrinking it if needed. */
function fitMarker(room, removedChars) {
  const full = `… [+${removedChars} chars]`
  if (full.length <= room) return full
  return room >= 1 ? '…' : ''
}

/**
 * Cut one event's rendering to the room left, marking the removed characters.
 *
 * The marker's width is reserved before the head is taken, so the page keeps
 * the count it dropped rather than degrading to a bare ellipsis.
 * @param rendered - the event's complete transcript text.
 * @param room - characters available for the head, its newline, and the marker.
 * @returns the head and marker lines.
 */
function truncateEvent(rendered, room) {
  const reserved = `… [+${rendered.length} chars]`.length
  if (room >= reserved + 1) {
    const head = rendered.slice(0, room - reserved - 1)
    return [head, `… [+${rendered.length - head.length} chars]`]
  }
  const head = rendered.slice(0, Math.max(0, room - 4))
  const marker = fitMarker(Math.max(0, room - head.length - 1), rendered.length - head.length)
  return [head, marker].filter(line => line.length > 0)
}

/**
 * Render one transcript page body, within the caller's budgets.
 *
 * `events` holds the candidate surface events of the range, in seq order, with
 * at most one more than `maxEvents` so a cut can be detected. The returned
 * `cutSeq` resumes at the first candidate the page did not show — or one past a
 * truncated event — so no event is duplicated or skipped across pages.
 * @param input - the range identity, its candidate events, and the page bounds.
 * @returns the page title, body lines, shown seqs, cut position, and cursor.
 */
export function renderTranscriptPage(input) {
  const { target, events, maxEvents, maxChars, moreBeyondBuffer } = input
  const title = transcriptTitle(target, 'transcript')
  const bodyBudget = Math.max(0, maxChars - title.length - 1 - STATUS_RESERVE - 1 - TRAILER_RESERVE - 1)
  const body = []
  const shownSeqs = []
  let used = 0
  let shown = 0
  let cutSeq = null
  for (const event of events) {
    const rendered = renderEvent(event)
    if (rendered === null) continue
    if (shown >= maxEvents) {
      cutSeq = event.seq
      break
    }
    const cost = rendered.length + 1
    if (used + cost > bodyBudget) {
      if (shown === 0) {
        const room = Math.max(0, bodyBudget - used - 1)
        body.push(truncateEvent(rendered, room).join('\n'))
        shown = 1
        shownSeqs.push(event.seq)
        cutSeq = event.seq + 1
      } else {
        cutSeq = event.seq
      }
      break
    }
    body.push(rendered)
    used += cost
    shown += 1
    shownSeqs.push(event.seq)
  }
  if (cutSeq === null && moreBeyondBuffer && events.length > 0) cutSeq = events.at(-1).seq + 1
  const cursor = cutSeq === null ? null : encodeCursor(target.ref, cutSeq, maxChars, maxEvents)
  return { title, body, shownSeqs, cutSeq, cursor }
}

/**
 * Compose the status line of one page.
 * @param input - the page, the view, how many candidates remain, and the effective budgets.
 * @returns one bounded status line.
 */
function statusLine(input) {
  const { page, view, remaining, budgets, cut } = input
  const unit = view === 'map' ? 'lines' : 'events'
  const shown = page.shownSeqs.length
  const range = shown === 0
    ? 'no events'
    : `seqs ${page.shownSeqs[0]}-${page.shownSeqs.at(-1)}`
  let tail
  if (!cut) tail = 'end of this range'
  else if (remaining === null) tail = 'more events follow'
  else tail = `${remaining} more in this range`
  const charsCapped = budgets.charsRequested !== undefined && budgets.charsRequested !== budgets.chars
    ? ` (capped from ${budgets.charsRequested})`
    : ''
  const eventsCapped = budgets.eventsRequested !== undefined && budgets.eventsRequested !== budgets.events
    ? ` (capped from ${budgets.eventsRequested})`
    : ''
  return `showing ${shown} ${unit} (${range}); ${tail}; budget ${budgets.chars} chars${charsCapped} / `
    + `${budgets.events} ${view === 'map' ? 'lines' : 'events'}${eventsCapped}`
}

/**
 * Build the model-facing text of one transcript page.
 * @param input - the rendered page, its remaining count, and the effective budgets.
 * @returns the page text.
 */
export function finishTranscriptPage(input) {
  return finishPage({ ...input, view: 'transcript' })
}

/** Render one map entry line. */
function mapLine(event) {
  const label = roleLabel(event)
  const size = formatSize(eventSize(event))
  return `seq ${event.seq} | ${label} | ${size} | ${previewOfEvent(event, MAP_PREVIEW_CHARS)}`
}

/**
 * Render one span-map page body, within the caller's budgets.
 * @param input - the range identity, its candidate events, and the page bounds.
 * @returns the page title, body lines, shown seqs, cut position, and cursor.
 */
export function renderSpanMap(input) {
  const { target, events, maxEvents, maxChars, moreBeyondBuffer } = input
  const title = transcriptTitle(target, 'map')
  const bodyBudget = Math.max(0, maxChars - title.length - 1 - STATUS_RESERVE - 1 - TRAILER_RESERVE - 1)
  const body = []
  const shownSeqs = []
  let used = 0
  let shown = 0
  let cutSeq = null
  for (const event of events) {
    const line = mapLine(event)
    if (shown >= maxEvents) {
      cutSeq = event.seq
      break
    }
    const cost = line.length + 1
    if (used + cost > bodyBudget) {
      if (shown === 0) {
        body.push(line.slice(0, Math.max(0, bodyBudget)))
        shownSeqs.push(event.seq)
        cutSeq = event.seq + 1
      } else {
        cutSeq = event.seq
      }
      break
    }
    body.push(line)
    used += cost
    shown += 1
    shownSeqs.push(event.seq)
  }
  if (cutSeq === null && moreBeyondBuffer && events.length > 0) cutSeq = events.at(-1).seq + 1
  const cursor = cutSeq === null ? null : encodeCursor(target.ref, cutSeq, maxChars, maxEvents)
  return { title, body, shownSeqs, cutSeq, cursor }
}

/**
 * Build the model-facing text of one span-map page.
 * @param input - the rendered page, its remaining count, and the effective budgets.
 * @returns the page text.
 */
export function finishSpanMapPage(input) {
  return finishPage({ ...input, view: 'map' })
}

/** Compose one page from its title, status, body, and trailer. */
function finishPage(input) {
  const { page, remaining, budgets } = input
  const cut = page.cutSeq !== null
  const status = statusLine({ page, view: input.view, remaining, budgets, cut }).slice(0, STATUS_RESERVE)
  const lines = [page.title, status, ...page.body, cut ? CUT_MARKER : END_MARKER]
  if (page.cursor !== null) lines.push(`cursor: ${page.cursor}`)
  return lines.join('\n')
}

/** Compose one checkpoint line for the outline. */
function checkpointLine(checkpoint) {
  const owner = !checkpoint.superseded
    ? 'current'
    : checkpoint.supersededBy === undefined ? 'superseded' : `superseded by ${checkpoint.supersededBy}`
  return `  ${checkpoint.id} | summary at seq ${checkpoint.summarySeq} | shadows ${checkpoint.eventCount} events `
    + `(seqs ${checkpoint.startSeq}-${checkpoint.endSeq}) | ~${checkpoint.shadowedTokenCount} tokens | `
    + `${formatTime(checkpoint.time)} | ${owner} | "${checkpoint.preview}"`
}

/** Compose one turn line for the outline. */
function turnLine(turn) {
  const visibility = turn.visible ? 'visible' : 'shadowed'
  return `  #${turn.index} seqs ${turn.startSeq}-${turn.endSeq} (${turn.eventCount} events, ${visibility}) — "${turn.preview}"`
}

/** The elision marker left in place of the turns the outline budget cannot hold. */
const ELISION_MARKER = '  … [+0 turns elided to stay within the outline budget; use history_read or history_search to reach them]'

/**
 * Render the session structure map.
 *
 * The checkpoint list is always complete; when the budget cannot hold the turn
 * list as well, turns are elided behind an explicit marker rather than silently
 * dropped, because a checkpoint a model cannot see is one it cannot read.
 * @param structure - the structure map `lib/recall-index.js` built.
 * @param maxChars - the outline character budget.
 * @returns the outline text.
 */
export function renderOutline(structure, maxChars) {
  const checkpoints = structure.checkpoints
  const lines = [
    `history_outline — ${structure.totalEvents} events, ${checkpoints.length} compaction checkpoint(s), ${structure.turns.length} turn(s)`,
    'checkpoints:',
    ...(checkpoints.length === 0
      ? ['  none — nothing has been condensed in this session yet']
      : checkpoints.map(checkpointLine)),
    'turns:',
  ]
  let elided = 0
  let used = lines.join('\n').length
  for (const turn of structure.turns) {
    const line = turnLine(turn)
    if (used + line.length + 1 > maxChars - ELISION_MARKER.length - 8) {
      elided = structure.turns.length - turn.index + 1
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  if (elided > 0) lines.push(ELISION_MARKER.replace('[+0 turns', `[+${elided} turns`))
  return lines.join('\n')
}

/**
 * Render one literal-search page.
 * @param input - the query, its hits, the coverage counts, and the requested limit.
 * @returns the search text, within the caller's hit and character bounds.
 */
export function renderSearchPage(input) {
  const { query, hits, scanned, matched, truncated, hitLimit } = input
  const coverage = `scanned ${scanned}, matched ${matched}, truncated ${truncated}`
  const lines = [
    `history_search "${previewOf(query, 80)}" — ${scanned} events scanned, ${matched} matched, showing ${hits.length}`,
  ]
  if (hits.length === 0) {
    lines.push(
      'No matches. The scan is a literal, case-insensitive text match over this session\'s own message text '
      + `(scanned ${scanned} events). Call history_outline to list the compaction checkpoints, then map or read `
      + 'one with history_read (checkpoint "c…", optionally view "map" to see its events), or search a shorter '
      + 'distinctive phrase.',
      coverage,
    )
    return lines.join('\n')
  }
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. seq ${hit.seq} | ${hit.surface} | ${hit.owner} | ${formatTime(hit.time)} | ${hit.label}`)
    lines.push(`   ${hit.snippet}`)
  })
  lines.push(truncated
    ? `${coverage} — showing ${hits.length} of ${matched}; narrow with checkpoint or a more distinctive phrase `
      + `(limit max ${hitLimit}).`
    : coverage)
  return lines.join('\n')
}
