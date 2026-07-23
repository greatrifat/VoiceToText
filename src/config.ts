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
  // Best first. The top three are served to every account (verified with a live
  // generateContent probe); the 2.5 pair 404s on newer accounts but still works
  // on older keys, where it adds real fallback, so it stays last.
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  // The AI Studio console labels this "Gemini 3 Flash", but the API id keeps the
  // -preview suffix (verified against GET /v1beta/models). The plain
  // 'gemini-3-flash' does not exist and 404s.
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

/**
 * How long one Gemini attempt may run before it is abandoned as stalled.
 *
 * These are hang detectors, kept generous on purpose. A slow request is usually
 * a slow *network* — a real 12-minute summary happened on a 0.33 KB/s link — not
 * a slow model (a summary generates in 3–5s). Cutting a working-but-crawling
 * request off early just wastes it and, worse, spends another of the day's ~20
 * requests retrying. So the fix for the runaway walk is NOT a short timeout; it
 * is `MAX_TIMEOUTS = 1` in the walk, which stops after the first genuine stall
 * instead of trying every model on a dead connection.
 */
export const TEXT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Transcription cannot use a flat deadline: the work scales with the recording.
 * A half-hour meeting is ~9.6MB once base64-encoded — a minute or more just to
 * upload on a mobile uplink — and the model must then listen to all of it and
 * generate thousands of tokens of transcript. A fixed six minutes would abort
 * that mid-answer and blame the network.
 *
 * Roughly twenty seconds of budget per minute of audio, over a floor covering the
 * model's spin-up, capped so a corrupt duration cannot make the app wait all day.
 * Generous like the text timeout, and for the same reason: a slow uplink, not a
 * slow model, is the usual cause, and the walk's `MAX_TIMEOUTS = 1` — not a tight
 * deadline — is what keeps a stall from marching through every model.
 */
const TRANSCRIBE_TIMEOUT_FLOOR_MS = 90 * 1000;
const TRANSCRIBE_TIMEOUT_PER_AUDIO_MINUTE_MS = 20 * 1000;
const TRANSCRIBE_TIMEOUT_CAP_MS = 20 * 60 * 1000;

/**
 * `durationSec` of 0 means unknown — an imported file whose duration could not
 * be probed. The cap is the safe answer there: too long merely delays an error
 * on a broken connection, while too short destroys a working transcription.
 */
export function transcribeTimeoutMs(durationSec?: number): number {
  if (!durationSec) return TRANSCRIBE_TIMEOUT_CAP_MS;
  const budget =
    TRANSCRIBE_TIMEOUT_FLOOR_MS +
    (durationSec / 60) * TRANSCRIBE_TIMEOUT_PER_AUDIO_MINUTE_MS;
  return Math.min(TRANSCRIBE_TIMEOUT_CAP_MS, Math.round(budget));
}

/**
 * Deadline for uploading the audio to the Files API, which scales with the file
 * rather than the recording length — it is the number of bytes on the wire that
 * a stalled uplink leaves hanging. The generate call that follows keeps its own
 * (duration-based) deadline, since with the file already uploaded that request
 * carries only a URL, but the model still has to listen to the whole recording.
 */
const UPLOAD_TIMEOUT_FLOOR_MS = 60 * 1000;
const UPLOAD_TIMEOUT_PER_MB_MS = 30 * 1000;
const UPLOAD_TIMEOUT_CAP_MS = 12 * 60 * 1000;

export function uploadTimeoutMs(sizeBytes: number): number {
  const mb = sizeBytes / (1024 * 1024);
  return Math.min(
    UPLOAD_TIMEOUT_CAP_MS,
    Math.round(UPLOAD_TIMEOUT_FLOOR_MS + mb * UPLOAD_TIMEOUT_PER_MB_MS)
  );
}
