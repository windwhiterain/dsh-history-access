/**
 * Pure transcript rendering, pagination, and outline composition.
 *
 * No I/O, no `ctx`, no clock: every function here is a pure function of the
 * values a caller already read from the durable log, so the same inputs always
 * produce the same page. The transcript is role-labeled — `User:`,
 * `Assistant:`, `Tool result:` — because the model reads what a model once saw,
 * never raw event JSON.
 *
 * @module dsh-history-access/lib/render
 */

/**
 * Event types that can join the model-visible surface
 * (`packages/core/session/src/surface.ts`, `SURFACE_EVENT_TYPES`).
 */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Longest first header line the transcript renderer emits. The page budget
 * reserves room for this header, the cut marker, and the cursor line, so a
 * page never exceeds its configured character budget.
 */
export const HEADER_MAX_CHARS = 160

/** Marks a page that stopped before the range ended. */
const CUT_MARKER = '… [page cut; more events follow — call history_read again with this cursor]'

/** Marks a page that reached the end of its range. */
const END_MARKER = '… [end of this range]'

/** Worst-case length of the trailing `cursor:` line, reserved from the budget. */
const CURSOR_RESERVE = 'cursor: c0000000000000000000@0000000000000000000'.length

/** Characters reserved for the trailer so it always fits after the body. */
const TRAILER_RESERVE = Math.max(CUT_MARKER.length, END_MARKER.length) + CURSOR_RESERVE + 2

/** Preview width for one outline line. */
const PREVIEW_CHARS = 80

/** Snippet width around one search match. */
const SNIPPET_CHARS = 180

/**
 * Format one epoch-millisecond timestamp as a UTC minute label.
 * @param time - event timestamp.
 * @returns a deterministic, timezone-independent label.
 */
export function formatTime(time) {
  if (!Number.isFinite(time)) return 'unknown time'
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/**
 * Collapse one text to a single-line preview.
 * @param text - arbitrary text.
 * @param max - maximum preview characters.
 * @returns the collapsed preview.
 */
export function previewOf(text, max = PREVIEW_CHARS) {
  const collapsed = String(text).replace(/\s+/gu, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(0, max - 1))}…`
}

/** Escape one literal for a regular expression, so a query is never syntax. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Locate one literal query in one text, case-insensitively.
 *
 * A literal substring wins; the whitespace-flexible phrase form is the same
 * second attempt the session-query service makes
 * (`packages/session-query/session-query/src/filters.ts`, `compileSessionTextFilter`).
 * @param text - text to search.
 * @param query - caller-supplied literal query.
 * @returns the match offset and length, or null when the text has no match.
 */
export function findMatch(text, query) {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return null
  const direct = text.toLowerCase().indexOf(needle)
  if (direct >= 0) return { index: direct, length: needle.length }
  const parts = query.trim().split(/\s+/u).map(escapeRegExp)
  const pattern = new RegExp(parts.join('\\s+'), 'iu')
  const match = pattern.exec(text)
  return match === null ? null : { index: match.index, length: match[0].length }
}

/**
 * Extract one single-line snippet around a match.
 * @param text - searched text.
 * @param query - caller-supplied literal query.
 * @param width - maximum snippet characters.
 * @returns the snippet, without surrounding whitespace.
 */
export function snippetOf(text, query, width = SNIPPET_CHARS) {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const match = findMatch(flat, query)
  if (match === null) return previewOf(flat, width)
  const half = Math.max(0, Math.floor((width - match.length) / 2))
  let start = Math.max(0, match.index - half)
  const end = Math.min(flat.length, start + width)
  if (end - start < width) start = Math.max(0, end - width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`.trim()
}

/**
 * Whether one event type can join the model-visible surface.
 * @param type - session event type.
 * @returns whether the type is a message-producing surface type.
 */
export function isSurfaceType(type) {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * Read the message one surface event carries.
 * @param event - surface event as recorded.
 * @returns the message object, or null for a non-surface event.
 */
export function messageOf(event) {
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

/** The role label one surface event renders under. */
function labelOf(event) {
  switch (event.type) {
    case 'user/message':
      return 'User'
    case 'assistant/message':
      return 'Assistant'
    case 'tool/result':
      return event.data.error === undefined && event.data.message?.isError !== true
        ? 'Tool result'
        : 'Tool result (error)'
    case 'system/message':
      return 'System'
    case 'developer/message':
      return 'Developer'
    default:
      return 'Event'
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
  const label = labelOf(event)
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
 * @param text - the cursor the model passed back.
 * @returns the decoded range reference and resume seq, or null when malformed.
 */
export function decodeCursor(text) {
  if (typeof text !== 'string') return null
  const match = /^(c\d+|s\d+)@(\d+)$/u.exec(text.trim())
  if (match === null) return null
  return { ref: match[1], nextSeq: Number(match[2]) }
}

/**
 * Compose the continuation cursor one page hands back.
 * @param ref - the range reference, `c<summarySeq>` for a checkpoint or `s<seq>` for a forward read.
 * @param nextSeq - the first raw seq the next page reads.
 * @returns the cursor string.
 */
export function encodeCursor(ref, nextSeq) {
  return `${ref}@${nextSeq}`
}

/** Bound the header line, so the budget reservation always holds. */
function boundedHeader(title) {
  return title.length <= HEADER_MAX_CHARS ? title : `${title.slice(0, HEADER_MAX_CHARS - 1)}…`
}

/** Compose the first line of one transcript page. */
function transcriptTitle(target) {
  if (target.kind === 'checkpoint') {
    const superseded = target.superseded ? ', superseded' : ''
    return boundedHeader(
      `history_read checkpoint ${target.id} — shadowed seqs ${target.startSeq}-${target.endSeq}, `
      + `${target.eventCount} events, ~${target.shadowedTokenCount} tokens${superseded}`,
    )
  }
  return boundedHeader(
    `history_read from seq ${target.seq} — this session's history, seqs ${target.firstSeq}-${target.lastSeq}`,
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
 * Render one page of a role-labeled transcript.
 *
 * `events` holds the candidate surface events of the range, in seq order, with
 * at most one more than `maxEvents` so a cut can be detected. The returned
 * `cursor` resumes at the first candidate the page did not show — or one past a
 * truncated event — so no event is duplicated or skipped across pages.
 * @param input - the range identity, its candidate events, and the page bounds.
 * @returns the page text, its continuation cursor, and the events it showed.
 */
export function renderTranscriptPage(input) {
  const { target, events, maxEvents, maxChars, moreBeyondBuffer } = input
  const title = transcriptTitle(target)
  const bodyBudget = Math.max(0, maxChars - title.length - 1 - TRAILER_RESERVE)
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
  const lastBufferSeq = events.length === 0 ? null : events.at(-1).seq
  if (cutSeq === null && moreBeyondBuffer && lastBufferSeq !== null) cutSeq = lastBufferSeq + 1
  const cursor = cutSeq === null ? null : encodeCursor(target.ref, cutSeq)
  const lines = [title, ...body, cursor === null ? END_MARKER : CUT_MARKER]
  if (cursor !== null) lines.push(`cursor: ${cursor}`)
  return { text: lines.join('\n'), cursor, shownSeqs }
}

/** Compose one checkpoint line for the outline. */
function checkpointLine(checkpoint) {
  const owner = !checkpoint.superseded
    ? 'current'
    : checkpoint.supersededBy === undefined ? 'superseded' : `superseded by ${checkpoint.supersededBy}`
  return `  ${checkpoint.id} | summary at seq ${checkpoint.summarySeq} | shadows ${checkpoint.shadowedSeqs.length} events `
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
 * @param structure - the structure map `lib/query.js` built.
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
      + `(scanned ${scanned} events). Call history_outline to list the compaction checkpoints, then history_read a `
      + 'checkpoint id to read its original text directly, or search a shorter distinctive phrase.',
      coverage,
    )
    return lines.join('\n')
  }
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. seq ${hit.seq} | ${hit.surface} | ${hit.owner} | ${formatTime(hit.time)}`)
    lines.push(`   ${hit.snippet}`)
  })
  lines.push(truncated
    ? `${coverage} — showing ${hits.length} of ${matched}; raise limit (max ${hitLimit}) or narrow the search with checkpoint.`
    : coverage)
  return lines.join('\n')
}
