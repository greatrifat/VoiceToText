/**
 * Tried in order, for two independent reasons:
 *
 * 1. Availability — Google retires models for new sign-ups while grandfathering
 *    existing accounts, so one hardcoded model works for some keys and not others.
 *
 * 2. Quota — free-tier requests-per-day is metered PER MODEL, not per account.
 *    Each entry below carries its own daily allowance (20/day at time of
 *    writing), so exhausting one leaves the rest untouched. Deliberately listed
 *    as distinct concrete models: aliases like `gemini-flash-latest` resolve to
 *    one of these and share its bucket, adding no headroom.
 */
export const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

/**
 * Transcription uses the same order. Measured over repeated runs against a real
 * 2:37 recording, no model was reliably better at timestamps: 2.5-flash landed
 * at 02:30 once and 03:54 twice, 3.5-flash at 03:54 and 03:59. Preferring one
 * on a single good sample would be fitting to noise.
 */
export const TRANSCRIBE_MODELS = GEMINI_MODELS;

/**
 * Gemini accepts inline audio up to ~20MB per request, and base64 inflates
 * bytes by ~33%. We refuse anything above this so the user gets a clear error
 * instead of an opaque 400 from the API.
 */
export const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;
