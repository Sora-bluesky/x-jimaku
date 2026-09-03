/**
 * A serialized queue whose head cannot hold the rest of the line.
 *
 * Content-side translations run one at a time, chained onto a tail promise.
 * That is deliberate: the built-in Translator is a single session and the
 * clauses arrive in order. But `TranslatorInstance.translate()` takes no abort
 * signal, so a call that never settles cannot be cancelled, and chaining alone
 * means one stuck call stalls every clause behind it. A capture then ships the
 * rest of its audio untranslated.
 *
 * So the tail advances on a deadline even when the operation has not settled.
 * The stuck call is abandoned, not aborted: it keeps running and may still
 * deliver its own result later, which is safe because every reply carries the
 * id of the request it answers. What the deadline buys is that the clause
 * behind it gets to start.
 *
 * Overlap is therefore possible, but only in the case where the alternative is
 * a stall.
 */

export interface TranslationQueue {
  /** Runs `operation` after the ones already queued. */
  enqueue(operation: () => Promise<void>): void;
  /** How many operations were released by the deadline rather than settling. */
  abandonedCount(): number;
  /**
   * Drops the queued chain so the next operation starts immediately.
   *
   * Used when the translator session is replaced: anything still queued was
   * for the old session and its result would be discarded anyway.
   */
  reset(): void;
}

export interface TranslationQueueOptions {
  /** How long the queue waits for one operation before moving on. */
  deadlineMs: number;
  /** Reports an abandoned operation, for the dev log. */
  onAbandoned?: () => void;
}

export function createTranslationQueue(
  options: TranslationQueueOptions,
): TranslationQueue {
  let tail: Promise<void> = Promise.resolve();
  let abandoned = 0;

  return {
    enqueue(operation) {
      const started = tail
        .catch(() => undefined)
        .then(operation)
        .catch((error: unknown) => {
          console.error(
            "[cs]",
            "content translation operation failed",
            error,
          );
        });

      let settled = false;
      void started.then(() => {
        settled = true;
      });

      tail = Promise.race([
        started,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!settled) {
              abandoned += 1;
              options.onAbandoned?.();
            }
            resolve();
          }, options.deadlineMs);
        }),
      ]);
    },

    abandonedCount() {
      return abandoned;
    },

    reset() {
      tail = Promise.resolve();
    },
  };
}
