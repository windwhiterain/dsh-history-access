/**
 * The only module that talks to `ctx.sessionQuery`.
 *
 * Recall is a pure function of the durable log: this module reads the session's
 * own event records, a bounded raw-event window, and the service's literal text
 * scan. It never writes, never indexes, and never reads a session file. Service
 * failures are translated into messages a model can act on, while cancellation
 * is preserved exactly — an aborted call rethrows the caller's own abort reason
 * instead of a translated message.
 *
 * @module dsh-history-access/lib/query
 */

import { isSurfaceType, previewOf } from './render.js'

/** Largest raw-event window the first attempt asks the service for. */
const WINDOW_MAX = 50

/** Smallest raw-event window an adapted read falls back to. */
const WINDOW_MIN = 1

/** Stable, model-safe sentence for each session-query failure code. */
const SERVICE_FAILURES = Object.freeze({
  SESSION_QUERY_ABORTED: 'the history read was cancelled',
  SESSION_QUERY_CORRUPT_SESSION: 'this session\'s recorded history is corrupt and cannot be read',
  SESSION_QUERY_EVENT_NOT_FOUND: 'that position does not exist in this session\'s recorded history',
  SESSION_QUERY_INDEX_FAILED: 'session search is unavailable in this deployment',
  SESSION_QUERY_INVALID_CONFIG: 'session history could not be read because the session-query service is misconfigured',
  SESSION_QUERY_INVALID_CURSOR: 'that history cursor is no longer valid; start the read again',
  SESSION_QUERY_INVALID_FILTER: 'the history scan was rejected as invalid',
  SESSION_QUERY_INVALID_LIMIT: 'that result limit was not accepted',
  SESSION_QUERY_INVALID_QUERY: 'that search query was not accepted',
  SESSION_QUERY_INVALID_LINEAGE: 'this session\'s recorded history is invalid',
  SESSION_QUERY_INVALID_SURFACE: 'this session\'s recorded history is invalid',
  SESSION_QUERY_INVALID_WINDOW: 'the history read window was rejected',
  SESSION_QUERY_PERSISTENCE_FAILED: 'session history storage is unavailable',
  SESSION_QUERY_SEARCH_DISABLED: 'session search is disabled in this deployment',
  SESSION_QUERY_SESSION_NOT_FOUND: 'this session is not available for history reads',
  SESSION_QUERY_STALE_CURSOR: 'this session changed while it was being read; start the read again',
  SESSION_QUERY_SOURCE_CONFLICT: 'this session\'s recorded history sources disagree',
})

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

/** The stable `code` of one thrown service failure, when it carries one. */
function codeOf(error) {
  return typeof error?.code === 'string' ? error.code : undefined
}

/**
 * Translate one session-query failure into a model-safe error.
 * @param error - the failure the service raised.
 * @returns the error a tool should surface.
 */
export function translateServiceError(error) {
  const code = codeOf(error)
  const known = code === undefined ? undefined : SERVICE_FAILURES[code]
  if (known !== undefined) return new QueryError(known)
  const detail = error instanceof Error && error.message.length > 0 ? error.message : String(error)
  return new QueryError(`session history could not be read (${detail})`)
}

/** Read one message's text blocks as flat text. */
function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
}

/**
 * Build the read facade over one plugin context.
 *
 * The service is resolved per call through `ctx.get`, so a service that
 * activates after this plugin still serves later reads, and the raw-event
 * window adapts once to whatever `readWindowMax` the deployment configured.
 * @param ctx - the plugin context.
 * @returns the facade used by every tool.
 */
export function createQuery(ctx) {
  let windowSize = WINDOW_MAX

  /** Resolve the optional service, or fail with a message a model can act on. */
  function requireService() {
    const service = ctx.get('sessionQuery')
    if (service === undefined) {
      throw new QueryError('session history recall is unavailable: this deployment mounts no session query service')
    }
    return service
  }

  /** Run one service call, preserving cancellation and translating failures. */
  async function call(signal, invoke) {
    signal.throwIfAborted()
    try {
      const value = await invoke()
      signal.throwIfAborted()
      return value
    } catch (error) {
      signal.throwIfAborted()
      throw translateServiceError(error)
    }
  }

  /**
   * Read one bounded raw-event window, adapting to the service's window cap.
   * @param sessionId - session to read.
   * @param seq - anchor seq; the window starts there.
   * @param wanted - desired number of following events.
   * @param signal - caller cancellation.
   * @returns the service window.
   */
  async function readWindow(sessionId, seq, wanted, signal) {
    const service = requireService()
    for (;;) {
      const after = Math.max(WINDOW_MIN, Math.min(windowSize, wanted))
      signal.throwIfAborted()
      try {
        return { window: await service.readEvent({ sessionId, seq, before: 0, after }, signal), after }
      } catch (error) {
        signal.throwIfAborted()
        if (codeOf(error) === 'SESSION_QUERY_INVALID_WINDOW' && after > WINDOW_MIN) {
          windowSize = Math.max(WINDOW_MIN, Math.floor(after / 2))
          continue
        }
        throw translateServiceError(error)
      }
    }
  }

  return {
    /**
     * Build this session's structure map: its event count, checkpoints, and turns.
     * @param sessionId - the calling agent's own session.
     * @param signal - caller cancellation.
     * @returns the structure map `lib/render.js` renders.
     */
    async structure(sessionId, signal) {
      const service = requireService()
      const records = await call(signal, () => service.listEvents(sessionId))
      const bySeq = new Map(records.map(record => [record.seq, record]))
      let firstSeq = Number.POSITIVE_INFINITY
      let lastSeq = Number.NEGATIVE_INFINITY
      for (const record of records) {
        firstSeq = Math.min(firstSeq, record.seq)
        lastSeq = Math.max(lastSeq, record.seq)
      }
      if (records.length === 0) {
        firstSeq = 0
        lastSeq = -1
      }
      const checkpoints = []
      for (const record of records) {
        if (record.type !== 'compaction/summary') continue
        const { window } = await readWindow(sessionId, record.seq, 1, signal)
        const data = window.target?.data ?? {}
        const replacement = window.events?.find(event => event.seq > record.seq)
        const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? [...data.shadowedSeqs] : []
        // The retrievable range is the shadowed seq set's own bounds: `shadowedRange`
        // is a surface-POSITION span, so after an earlier replace landed a
        // high-seq node at an older position its `start` can exceed its `end`.
        let startSeq = data.shadowedRange?.start ?? record.seq
        let endSeq = data.shadowedRange?.end ?? record.seq
        if (shadowedSeqs.length > 0) {
          startSeq = shadowedSeqs[0]
          endSeq = shadowedSeqs[0]
          for (const seq of shadowedSeqs) {
            startSeq = Math.min(startSeq, seq)
            endSeq = Math.max(endSeq, seq)
          }
        }
        checkpoints.push({
          id: `c${record.seq}`,
          summarySeq: record.seq,
          replacementSeq: replacement?.seq,
          startSeq,
          endSeq,
          shadowedSeqs,
          shadowedTokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0,
          time: record.time,
          preview: previewOf(contentText(data.summary)) || '(summary text unavailable)',
          superseded: false,
          supersededBy: undefined,
        })
      }
      const owner = new Map()
      for (const checkpoint of checkpoints) {
        for (const seq of checkpoint.shadowedSeqs) {
          if (!owner.has(seq)) owner.set(seq, checkpoint.id)
        }
      }
      for (const checkpoint of checkpoints) {
        const replacementSeq = checkpoint.replacementSeq
        const supersededBy = replacementSeq === undefined ? undefined : owner.get(replacementSeq)
        if (supersededBy !== undefined && supersededBy !== checkpoint.id) {
          checkpoint.superseded = true
          checkpoint.supersededBy = supersededBy
        } else if (replacementSeq !== undefined && bySeq.get(replacementSeq)?.surface === 'shadowed') {
          checkpoint.superseded = true
        }
      }
      const userText = new Map()
      const documents = await call(signal, () => service.filterEvents(sessionId, [
        { kind: 'type', values: ['user/message'] },
      ]))
      for (const document of documents) userText.set(document.seq, document.text)
      const turns = []
      let current = null
      let index = 0
      for (const record of records) {
        if (record.type === 'turn/start') {
          index += 1
          current = { index, startSeq: record.seq, endSeq: record.seq, eventCount: 0, visible: false, preview: '(no user message)' }
          turns.push(current)
        }
        if (current !== null) {
          current.endSeq = record.seq
          current.eventCount += 1
          if (record.surface === 'current') current.visible = true
          if (record.type === 'turn/end') current = null
        }
      }
      for (const turn of turns) {
        for (let seq = turn.startSeq; seq <= turn.endSeq; seq += 1) {
          const text = userText.get(seq)
          if (text === undefined) continue
          turn.preview = previewOf(text)
          break
        }
      }
      return {
        sessionId,
        totalEvents: records.length,
        firstSeq,
        lastSeq,
        checkpoints,
        turns,
        shadowedOwner: owner,
      }
    },

    /**
     * Read the candidate surface events of one range, starting at `resumeSeq`.
     * @param sessionId - session to read.
     * @param range - inclusive raw-seq bounds and an optional subset restriction.
     * @param resumeSeq - first raw seq to read.
     * @param maxEvents - page event budget; one extra candidate is read to detect a cut.
     * @param signal - caller cancellation.
     * @returns the candidates, whether more exist beyond them, and the resume seq.
     */
    async readPage(sessionId, range, resumeSeq, maxEvents, signal) {
      const wanted = maxEvents + 1
      const events = []
      let seq = Math.max(range.fromSeq, resumeSeq)
      let stoppedAtWanted = false
      while (events.length < wanted && seq <= range.toSeq) {
        const { window, after } = await readWindow(sessionId, seq, range.toSeq - seq + 1, signal)
        for (const event of window.events ?? []) {
          if (event.seq > range.toSeq) break
          if (range.seqs !== undefined && !range.seqs.has(event.seq)) continue
          if (!isSurfaceType(event.type)) continue
          events.push(event)
          if (events.length >= wanted) {
            stoppedAtWanted = true
            break
          }
        }
        if (stoppedAtWanted) break
        if (window.endSeq >= range.toSeq) break
        if (window.endSeq < seq + after) break
        seq = window.endSeq + 1
      }
      return { events, moreBeyondBuffer: stoppedAtWanted }
    },

    /**
     * Run one literal text scan over this session's model-visible history.
     * @param sessionId - session to scan.
     * @param request - the literal query, the seq bounds to scan, and the hit limit.
     * @param signal - caller cancellation.
     * @returns the matching documents, the scanned count, and the total match count.
     */
    async search(sessionId, request, signal) {
      const service = requireService()
      const filters = [{ kind: 'surface', values: ['current', 'shadowed'] }]
      if (request.fromSeq !== undefined) {
        filters.push({ kind: 'seq', from: request.fromSeq, to: request.toSeq })
      }
      const scanned = await call(signal, () => service.filterEvents(sessionId, filters))
      const matched = await call(signal, () => service.filterEvents(sessionId, [
        ...filters,
        { kind: 'text', text: request.query },
      ]))
      // A checkpoint scope is its shadowed seq set, not the numeric interval
      // that contains it, so both counts stay exact for the reported scope.
      const inScope = request.seqs === undefined
        ? documents => documents
        : documents => documents.filter(document => request.seqs.has(document.seq))
      const scope = inScope(scanned)
      const hits = inScope(matched)
      return {
        scanned: scope.length,
        matched: hits.length,
        documents: hits.slice(0, request.limit),
      }
    },
  }
}
