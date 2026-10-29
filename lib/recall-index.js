/**
 * The per-session recall index.
 *
 * Two layers, deliberately separate:
 *
 * 1. The **event feed** is a registered `sessionProjections` unit with no wire
 *    view. Its only work is to append each committed event reference to a
 *    per-session array — the projection service already folds that array from
 *    the in-memory log on first materialization and drives it per append, so the
 *    feed costs O(1) per event and never clones a message.
 * 2. The **index** is plugin-owned and advanced lazily by the first tool call
 *    that needs it: checkpoints, the shadowed-owner map, turns, and per-turn
 *    surface counts. Advancing it over events appended since the previous call
 *    is O(new events), so a recall tool never re-derives the whole session.
 *
 * The prior data path asked `sessionQuery` for the structure on every call;
 * each of its calls deep-clones the entire live log (`snapshotLive`), which
 * measured 0.9 s and ~1 GB of heap for a 58k-event session and made one recall
 * tool call cost ~20 s. See `docs/notes/recall-v2.md`.
 *
 * @module dsh-history-access/lib/recall-index
 */

import { isSurfaceType, previewOf, surfaceText } from './event-text.js'

/** Projection key of the event feed. Bump only when the feed's state shape changes. */
export const FEED_KEY = 'history-access.events.v1'

/** State version registered with the projection service. */
export const FEED_STATE_VERSION = 1

/**
 * Register the event feed into one projection registry.
 * @param projections - the `sessionProjections` service.
 * @returns the registration disposer.
 */
export function registerEventFeed(projections) {
  return projections.register({
    key: FEED_KEY,
    stateVersion: FEED_STATE_VERSION,
    init: () => ({ events: [] }),
    apply: (state, event) => {
      state.events.push(event)
      return state
    },
  })
}

/** One empty derived index, before any event is folded. */
export function createIndex() {
  return {
    checkpoints: [],
    owner: new Map(),
    turns: [],
    current: null,
  }
}

/**
 * Build one per-session reader over the projection feed.
 *
 * A reader caches the derived index per `Session` and remembers which feed state
 * it folded, so a hot reload that re-registers the feed refolds once instead of
 * mixing two states.
 * @returns the reader with its `read` method.
 */
export function createIndexReader() {
  const entries = new WeakMap()
  return {
    /**
     * Fold any feed events appended since the previous call.
     * @param session - the calling agent's own live session.
     * @param feed - the projection state that session's feed materialized.
     * @returns the current derived index.
     */
    read(session, feed) {
      let entry = entries.get(session)
      if (entry === undefined || entry.feed !== feed || entry.folded > feed.events.length) {
        entry = { feed, folded: 0, index: createIndex() }
        entries.set(session, entry)
      }
      for (let seq = entry.folded; seq < feed.events.length; seq += 1) {
        foldEvent(entry.index, feed.events, feed.events[seq])
      }
      entry.folded = feed.events.length
      return entry.index
    },
  }
}

/**
 * Fold one committed event into the derived index.
 * @param index - the index being advanced.
 * @param events - the feed's event array, for shadowed-position lookback.
 * @param event - the committed event.
 */
function foldEvent(index, events, event) {
  if (event.type === 'turn/start') {
    const turn = {
      index: index.turns.length + 1,
      startSeq: event.seq,
      endSeq: event.seq,
      eventCount: 0,
      surfaceCount: 0,
      shadowedSurface: 0,
      preview: null,
    }
    index.turns.push(turn)
    index.current = turn
  }
  const current = index.current
  if (current !== null) {
    current.endSeq = event.seq
    current.eventCount += 1
    if (isSurfaceType(event.type)) current.surfaceCount += 1
  }
  if (event.type === 'turn/end') {
    index.current = null
    return
  }
  if (event.type === 'user/message') {
    if (current !== null && current.preview === null) {
      current.preview = previewOf(surfaceText(event))
    }
    return
  }
  if (event.type === 'compaction/summary') addCheckpoint(index, events, event)
}

/**
 * Record one compaction checkpoint and the positions it shadowed.
 * @param index - the index receiving the checkpoint.
 * @param events - the feed's event array.
 * @param event - the `compaction/summary` event.
 */
function addCheckpoint(index, events, event) {
  const data = event.data ?? {}
  const seqs = Array.isArray(data.shadowedSeqs)
    ? data.shadowedSeqs.filter(seq => Number.isInteger(seq)).sort((left, right) => left - right)
    : []
  const checkpoint = {
    id: `c${event.seq}`,
    summarySeq: event.seq,
    seqs,
    startSeq: seqs.length > 0 ? seqs[0] : event.seq,
    endSeq: seqs.length > 0 ? seqs.at(-1) : event.seq,
    eventCount: seqs.length,
    shadowedTokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0,
    time: event.time,
    preview: previewOf(summaryText(data.summary)),
  }
  index.checkpoints.push(checkpoint)
  for (const seq of seqs) {
    // First checkpoint wins: a position is shadowed exactly once, and a later
    // checkpoint that cites an already-shadowed position does not re-own it.
    if (index.owner.has(seq)) continue
    index.owner.set(seq, checkpoint.id)
    const target = events[seq]
    if (target === undefined || !isSurfaceType(target.type)) continue
    const turn = turnAt(index, seq)
    if (turn !== null) turn.shadowedSurface += 1
  }
}

/** Concatenated text of one summary's content blocks. */
function summaryText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
}

/**
 * Find the turn whose raw-seq range contains one position.
 * @param index - the derived index.
 * @param seq - raw event position.
 * @returns the owning turn, or null when the position is outside every turn.
 */
function turnAt(index, seq) {
  let low = 0
  let high = index.turns.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const turn = index.turns[middle]
    if (seq < turn.startSeq) high = middle - 1
    else if (seq > turn.endSeq) low = middle + 1
    else return turn
  }
  return null
}

/**
 * Whether a later checkpoint shadowed one checkpoint's replacement node.
 * @param index - the derived index.
 * @param checkpoint - the checkpoint to test.
 * @returns the superseding checkpoint id, or undefined.
 */
export function supersededBy(index, checkpoint) {
  // The replacement node is the first event after the summary; the log is
  // contiguous, so its position is `summarySeq + 1`.
  const owner = index.owner.get(checkpoint.summarySeq + 1)
  return owner !== undefined && owner !== checkpoint.id ? owner : undefined
}

/**
 * Build the model-facing structure map from the index.
 * @param index - the derived index.
 * @param events - the feed's event array.
 * @returns the structure map `lib/render.js` renders.
 */
export function structureOf(index, events) {
  const checkpoints = index.checkpoints.map((checkpoint) => {
    const superseding = supersededBy(index, checkpoint)
    return {
      ...checkpoint,
      superseded: superseding !== undefined,
      supersededBy: superseding,
    }
  })
  const turns = index.turns.map(turn => ({
    index: turn.index,
    startSeq: turn.startSeq,
    endSeq: turn.endSeq,
    eventCount: turn.eventCount,
    visible: turn.surfaceCount > turn.shadowedSurface,
    preview: turn.preview ?? '(no user message)',
  }))
  return {
    totalEvents: events.length,
    firstSeq: events.length > 0 ? events[0].seq : 0,
    lastSeq: events.length > 0 ? events.at(-1).seq : -1,
    checkpoints,
    turns,
    shadowedOwner: index.owner,
  }
}
