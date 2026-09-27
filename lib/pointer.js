/**
 * Pointer text and delivery dedupe for one completed compaction pass.
 *
 * Pure and host-free on purpose: the text a model reads after a compaction is
 * part of the plugin's contract, so it is composed here where an offline probe
 * can pin it.
 *
 * @module dsh-history-access/lib/pointer
 */

/** Bounded number of delivered compaction ids retained by one dedupe policy. */
const DEDUPE_LIMIT = 256

/**
 * Compose the post-compaction pointer, the one piece of context this plugin
 * adds without being asked.
 * @param checkpoint - the completed checkpoint's identity and size.
 * @returns two lines naming the checkpoint, what it condensed, and how to recover the originals.
 */
export function pointerText(checkpoint) {
  return [
    `Context was condensed into checkpoint ${checkpoint.id}: `
    + `${checkpoint.eventCount} earlier events (~${checkpoint.shadowedTokenCount} tokens) were replaced by its summary.`,
    `The originals are still recorded in this session — call history_read (checkpoint "${checkpoint.id}") `
    + 'or history_search to retrieve them; do not read or decompress session files.',
  ].join('\n')
}

/**
 * Create the per-compaction delivery policy.
 *
 * One pointer per compaction pass: a redelivered pointer would repeat context
 * the model already has, and a later pass always carries its own id.
 * @param limit - maximum retained ids before the oldest is forgotten.
 * @returns the dedupe policy.
 */
export function createPointerDedupe(limit = DEDUPE_LIMIT) {
  const delivered = new Set()
  return {
    /**
     * Whether one completed pass still owes its pointer.
     * @param compactionId - identity of the completed pass.
     * @returns whether the pointer has not been delivered for this id.
     */
    shouldDeliver(compactionId) {
      return !delivered.has(compactionId)
    },
    /**
     * Record one delivered pointer.
     * @param compactionId - identity of the completed pass.
     */
    markDelivered(compactionId) {
      delivered.delete(compactionId)
      delivered.add(compactionId)
      while (delivered.size > limit) {
        const oldest = delivered.values().next().value
        delivered.delete(oldest)
      }
    },
    /** @returns how many compaction ids are currently remembered. */
    size() {
      return delivered.size
    },
  }
}
