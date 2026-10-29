/**
 * The read facade over one agent's derived recall index.
 *
 * No service, no I/O, no clock: every function here is a pure function of the
 * feed events and the index `lib/recall-index.js` advanced for this session.
 * Failures are model-safe messages, because a model that cannot name a valid
 * span should be told which spans exist rather than left with a stack trace.
 *
 * @module dsh-history-access/lib/query
 */

import { createMatcher, eventText, isErrorResult, isSurfaceType, roleLabel, snippetAround } from './event-text.js'
import { supersededBy } from './recall-index.js'
import { decodeCursor } from './render.js'

/** Thrown for every failure this module reports to a model. */
export class QueryError extends Error {
  /**
   * @param message - the model-facing explanation.
   */
  constructor(message) {
    super(message)
    this.name = 'QueryError'
  }
}

/**
 * Find the first index whose value is at least `value`.
 * @param sorted - ascending numeric array.
 * @param value - lower bound.
 * @returns the insertion point.
 */
export function lowerBound(sorted, value) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Find one checkpoint by the id `history_outline` reported.
 * @param index - the derived index.
 * @param requested - the id the model passed, with or without its `c` prefix.
 * @returns the checkpoint.
 * @throws {QueryError} listing every id that does exist.
 */
export function findCheckpoint(index, requested) {
  const wanted = String(requested).trim().replace(/^[cC]/u, '')
  const checkpoint = index.checkpoints.find(entry => entry.summarySeq === Number(wanted))
  if (checkpoint !== undefined) return checkpoint
  const known = index.checkpoints.length === 0
    ? 'this session has no compaction checkpoints'
    : `this session has ${index.checkpoints.map(entry => entry.id).join(', ')}`
  throw new QueryError(`unknown checkpoint "${requested}" — ${known}`)
}

/** Describe one checkpoint to the renderer. */
export function checkpointTarget(index, checkpoint) {
  const superseding = supersededBy(index, checkpoint)
  return {
    kind: 'checkpoint',
    ref: checkpoint.id,
    id: checkpoint.id,
    startSeq: checkpoint.startSeq,
    endSeq: checkpoint.endSeq,
    eventCount: checkpoint.eventCount,
    shadowedTokenCount: checkpoint.shadowedTokenCount,
    superseded: superseding !== undefined,
    supersededBy: superseding,
  }
}

/** Describe a forward read to the renderer. */
function seqTarget(events, from) {
  return {
    kind: 'seq',
    ref: `s${from}`,
    seq: from,
    firstSeq: events.length > 0 ? events[0].seq : 0,
    lastSeq: events.length > 0 ? events.at(-1).seq : -1,
  }
}

/** The inclusive candidate range of one checkpoint span. */
function checkpointRange(checkpoint) {
  return { fromSeq: checkpoint.startSeq, toSeq: checkpoint.endSeq, seqs: checkpoint.seqs }
}

/** The inclusive range of a forward read, bounded by the executing step. */
function seqRange(events, from, cap) {
  const lastSeq = events.length > 0 ? events.at(-1).seq : -1
  return { fromSeq: from, toSeq: Math.min(lastSeq, cap), seqs: undefined }
}

/**
 * Resolve one `history_read` request into a target, a candidate range, and the
 * position the page starts at.
 *
 * `checkpoint` and `seq` combine: a checkpoint restricts the range to the span
 * it replaced, and `seq` starts the page inside that span. A cursor carries the
 * range identity itself, so it never combines with either.
 * @param input - the normalized arguments.
 * @param index - the derived index.
 * @param events - the feed's event array.
 * @param cap - inclusive upper bound on readable seqs (the running step's start minus one).
 * @returns the target, range, and start position.
 * @throws {QueryError} when the span, position, or cursor cannot be resolved.
 */
export function resolveRead(input, index, events, cap) {
  let resolved
  if (input.cursor !== null) {
    const decoded = decodeCursor(input.cursor)
    if (decoded === null) throw new QueryError('history_read cursor must be the cursor line a previous page returned')
    if (decoded.ref.startsWith('c')) {
      const checkpoint = findCheckpoint(index, decoded.ref.slice(1))
      resolved = {
        target: checkpointTarget(index, checkpoint),
        range: checkpointRange(checkpoint),
        resumeSeq: decoded.nextSeq,
      }
    } else {
      const from = Number(decoded.ref.slice(1))
      resolved = { target: seqTarget(events, from), range: seqRange(events, from, cap), resumeSeq: decoded.nextSeq }
    }
  } else if (input.checkpoint !== null) {
    const checkpoint = findCheckpoint(index, input.checkpoint)
    if (input.seq !== null && input.seq > checkpoint.endSeq) {
      throw new QueryError(
        `seq ${input.seq} is past the end of ${checkpoint.id}, whose span ends at seq ${checkpoint.endSeq}`,
      )
    }
    resolved = {
      target: checkpointTarget(index, checkpoint),
      range: checkpointRange(checkpoint),
      resumeSeq: input.seq === null ? checkpoint.startSeq : Math.max(checkpoint.startSeq, input.seq),
    }
  } else {
    const lastSeq = events.length > 0 ? events.at(-1).seq : -1
    if (input.seq > lastSeq) {
      throw new QueryError(`seq ${input.seq} is past the end of this session, whose last recorded seq is ${lastSeq}`)
    }
    resolved = { target: seqTarget(events, input.seq), range: seqRange(events, input.seq, cap), resumeSeq: input.seq }
  }
  if (resolved.range.toSeq < resolved.range.fromSeq) {
    throw new QueryError(
      `seqs ${resolved.range.fromSeq} and later belong to the step that is running now; history_read reads history `
      + `recorded before this step, up to seq ${cap}`,
    )
  }
  return resolved
}

/**
 * Collect the transcript candidates one page may render.
 *
 * One extra candidate is returned when it exists, so the renderer can tell a
 * cut caused by its own budget from the end of the range. A checkpoint span is
 * read through its sorted shadowed positions, because the span is a set of
 * positions rather than a numeric interval.
 * @param events - the feed's event array.
 * @param range - the candidate range.
 * @param resumeSeq - first raw seq the page may show.
 * @param maxEvents - page event budget.
 * @returns the candidates and whether more exist beyond them.
 */
export function collectTranscript(events, range, resumeSeq, maxEvents) {
  const wanted = maxEvents + 1
  const candidates = []
  if (range.seqs !== undefined) {
    let at = lowerBound(range.seqs, Math.max(resumeSeq, range.fromSeq))
    while (at < range.seqs.length && candidates.length < wanted) {
      const event = events[range.seqs[at]]
      at += 1
      if (event === undefined) continue
      candidates.push(event)
    }
    return { events: candidates, moreBeyondBuffer: at < range.seqs.length }
  }
  let seq = Math.max(resumeSeq, range.fromSeq)
  while (seq <= range.toSeq && candidates.length < wanted) {
    const event = events[seq]
    seq += 1
    if (event === undefined || !isSurfaceType(event.type)) continue
    candidates.push(event)
  }
  return { events: candidates, moreBeyondBuffer: candidates.length > maxEvents }
}

/**
 * Whether one event earns a line in a span map.
 *
 * The map is a navigation view: prose, tool calls, user requests, error results,
 * and nested checkpoint summaries are signposts; a successful tool result is
 * bulk content that only the transcript should render.
 * @param event - event as recorded.
 * @returns whether the map lists it.
 */
export function isMapEntry(event) {
  if (event.type === 'user/message' || event.type === 'assistant/message') return true
  if (event.type === 'compaction/summary') return true
  return event.type === 'tool/result' && isErrorResult(event)
}

/**
 * Collect the span-map candidates one page may list.
 * @param events - the feed's event array.
 * @param range - the candidate range.
 * @param resumeSeq - first raw seq the page may map.
 * @param maxLines - page line budget.
 * @returns the candidates and whether more exist beyond them.
 */
export function collectMap(events, range, resumeSeq, maxLines) {
  const wanted = maxLines + 1
  const entries = []
  if (range.seqs !== undefined) {
    let at = lowerBound(range.seqs, Math.max(resumeSeq, range.fromSeq))
    while (at < range.seqs.length && entries.length < wanted) {
      const event = events[range.seqs[at]]
      at += 1
      if (event === undefined || !isMapEntry(event)) continue
      entries.push(event)
    }
    return { events: entries, moreBeyondBuffer: at < range.seqs.length }
  }
  let seq = Math.max(resumeSeq, range.fromSeq)
  while (seq <= range.toSeq && entries.length < wanted) {
    const event = events[seq]
    seq += 1
    if (event === undefined || !isMapEntry(event)) continue
    entries.push(event)
  }
  return { events: entries, moreBeyondBuffer: entries.length > maxLines }
}

/**
 * How many candidates one range still holds from a given position.
 * @param range - the candidate range.
 * @param seq - the position after the page's last shown event.
 * @returns the exact count for a checkpoint span, or null when it is a numeric range.
 */
export function remainingInRange(range, seq) {
  if (range.seqs === undefined) return null
  return range.seqs.length - lowerBound(range.seqs, seq)
}

/**
 * Run one literal text scan over this session's model-visible history.
 * @param index - the derived index, for the owning checkpoint of each hit.
 * @param events - the feed's event array.
 * @param request - the matcher query, the range, the hit limit, and the snippet width.
 * @returns the matching hits, the scanned count, and the total match count.
 */
export function searchIn(index, events, request) {
  const matcher = createMatcher(request.query)
  if (matcher === null) throw new QueryError('history_search needs a non-empty literal query')
  const members = request.seqs === undefined ? null : new Set(request.seqs)
  const hits = []
  let scanned = 0
  let matched = 0
  /** Consider one event. */
  function consider(event) {
    if (event === undefined) return
    const text = eventText(event)
    if (text.length === 0) return
    scanned += 1
    if (!matcher.test(text)) return
    matched += 1
    if (hits.length >= request.limit) return
    const owner = index.owner.get(event.seq)
    hits.push({
      seq: event.seq,
      surface: owner === undefined ? 'visible' : 'shadowed',
      owner: owner ?? '(visible)',
      time: event.time,
      label: roleLabel(event),
      snippet: snippetAround(text, matcher.locate, request.context),
    })
  }
  if (request.seqs !== undefined) {
    for (const seq of request.seqs) {
      if (seq < request.fromSeq || seq > request.toSeq) continue
      consider(events[seq])
    }
  } else {
    for (let seq = request.fromSeq; seq <= request.toSeq; seq += 1) consider(events[seq])
  }
  return { hits, scanned, matched }
}
