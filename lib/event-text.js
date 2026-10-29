/**
 * Event classification, message-text extraction, and literal matching.
 *
 * Pure and host-free: the same text serves the transcript renderer, the search
 * scan, and the span map, so a phrase a model searches for is exactly a phrase
 * a page would have shown. Reasoning blocks contribute no text, because the
 * transcript never carries a thinking trace.
 *
 * @module dsh-history-access/lib/event-text
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

/** Longest first header line the transcript renderer emits. */
export const HEADER_MAX_CHARS = 160

/** Default one-line preview width used by the outline and the span map. */
export const PREVIEW_CHARS = 80

/** Widest span-map preview, so one map line stays navigable. */
export const MAP_PREVIEW_CHARS = 120

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

/** The content blocks one event contributes, in order. */
function blocksOf(event) {
  const message = messageOf(event)
  return Array.isArray(message?.content) ? message.content : []
}

/** The searchable text one block contributes, or an empty string. */
function blockText(block) {
  if (block?.type === 'text' && typeof block.text === 'string') return block.text
  if (block?.type === 'tool-call') {
    const name = String(block.name ?? '')
    const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '')
    return `${name} ${args}`.trim()
  }
  return ''
}

/**
 * Extract one event's full searchable text.
 *
 * Only `user/message`, `assistant/message`, and `tool/result` contribute text;
 * `system` and `developer` nodes are injected context rather than something the
 * model authored or read, so a scan for a remembered phrase skips them.
 * @param event - event as recorded.
 * @returns the text, or an empty string when the event is not searchable.
 */
export function eventText(event) {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      return blocksOf(event)
        .map(blockText)
        .map(part => part.trim())
        .filter(part => part.length > 0)
        .join('\n')
    default:
      return ''
  }
}

/**
 * Extract one event's full text without the trimming work search needs.
 * @param event - surface event.
 * @returns the joined text, possibly empty.
 */
export function surfaceText(event) {
  return blocksOf(event)
    .map(blockText)
    .filter(part => part.length > 0)
    .join('\n')
}

/**
 * Measure one event's rendered text, without materializing it.
 * @param event - surface event.
 * @returns the character count of its text and tool-call arguments.
 */
export function eventSize(event) {
  let total = 0
  for (const block of blocksOf(event)) total += blockText(block).length
  return total
}

/**
 * Compose a bounded one-line preview of one event.
 * Blocks are consumed only until the preview is full, so a multi-megabyte tool
 * result is never joined just to print its first line.
 * @param event - surface event.
 * @param max - maximum preview characters.
 * @returns the collapsed preview.
 */
export function previewOfEvent(event, max = MAP_PREVIEW_CHARS) {
  let collected = ''
  for (const block of blocksOf(event)) {
    const part = blockText(block)
    if (part.length === 0) continue
    collected += (collected.length > 0 ? ' ' : '') + part.slice(0, max + 1 - Math.min(collected.length, max))
    if (collected.length > max) break
  }
  return previewOf(collected, max)
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

/**
 * Format a character count for one index line.
 * @param chars - character count.
 * @returns a compact label such as `840` or `2.1k`.
 */
export function formatSize(chars) {
  if (chars < 1000) return String(chars)
  if (chars < 10_000) return `${(chars / 1000).toFixed(1)}k`
  if (chars < 1_000_000) return `${Math.round(chars / 1000)}k`
  return `${(chars / 1_000_000).toFixed(1)}M`
}

/** Escape one literal for a regular expression, so a query is never syntax. */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Compile one case-insensitive literal matcher.
 *
 * A literal substring wins; the whitespace-flexible phrase form is the same
 * second attempt the session-query service makes
 * (`packages/session-query/session-query/src/filters.ts`). Matching through a
 * case-insensitive expression rather than `toLowerCase()` keeps a scan over a
 * large log allocation-free.
 * @param query - caller-supplied literal query.
 * @returns the matcher, or null for an empty query.
 */
export function createMatcher(query) {
  const needle = String(query).trim()
  if (needle.length === 0) return null
  const literal = new RegExp(escapeRegExp(needle), 'iu')
  const parts = needle.split(/\s+/u)
  const spaced = parts.length > 1
    ? new RegExp(parts.map(escapeRegExp).join('\\s+'), 'iu')
    : null
  /** @param text - text to match. @returns the match offset and length, or null. */
  function locate(text) {
    let match = literal.exec(text)
    if (match !== null) return { index: match.index, length: match[0].length }
    if (spaced !== null) {
      match = spaced.exec(text)
      if (match !== null) return { index: match.index, length: match[0].length }
    }
    return null
  }
  return {
    /**
     * Whether one text contains the query.
     * @param text - text to match.
     * @returns whether it matches.
     */
    test: text => locate(text) !== null,
    locate,
  }
}

/**
 * Extract one single-line snippet around a match.
 * @param text - searched text.
 * @param locate - the matcher's locator.
 * @param width - maximum snippet characters.
 * @returns the snippet, without surrounding whitespace.
 */
export function snippetAround(text, locate, width) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  const match = locate(flat)
  if (match === null) return previewOf(flat, width)
  const half = Math.max(0, Math.floor((width - match.length) / 2))
  let start = Math.max(0, match.index - half)
  const end = Math.min(flat.length, start + width)
  if (end - start < width) start = Math.max(0, end - width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`.trim()
}

/**
 * Whether one tool result reports an error.
 * @param event - `tool/result` event.
 * @returns whether the result is an error result.
 */
export function isErrorResult(event) {
  return event.data?.error !== undefined || event.data?.message?.isError === true
}

/**
 * The role label one surface event renders under.
 * @param event - surface or checkpoint event.
 * @returns the label a transcript line or map entry uses.
 */
export function roleLabel(event) {
  switch (event.type) {
    case 'user/message':
      return 'User'
    case 'assistant/message':
      return 'Assistant'
    case 'tool/result':
      return isErrorResult(event) ? 'Tool result (error)' : 'Tool result'
    case 'system/message':
      return 'System'
    case 'developer/message':
      return 'Developer'
    case 'compaction/summary':
      return 'Checkpoint'
    default:
      return 'Event'
  }
}
