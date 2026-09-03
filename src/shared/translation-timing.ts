/**
 * How long a single clause may take before the pipeline gives up on it.
 *
 * Both sides of the extension need this bound and they must agree on it. The
 * offscreen engine uses it to expire an attempt; the content script uses it to
 * stop one stuck translator call from holding the queue behind it. Keeping one
 * copy is the point: a bound defined twice drifts, and the half that drifts
 * goes quiet rather than failing.
 */
export const LANGUAGE_MODEL_PROMPT_TIMEOUT_MS = 10_000;

export const TRANSLATION_DEADLINE_MS =
  LANGUAGE_MODEL_PROMPT_TIMEOUT_MS + 2_000;
