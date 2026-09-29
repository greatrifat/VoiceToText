import { File, UploadType } from 'expo-file-system';

import {
  GEMINI_MODELS,
  TEXT_TIMEOUT_MS,
  TRANSCRIBE_MODELS,
  transcribeTimeoutMs,
  uploadTimeoutMs,
} from './config';
import {
  loadModelState,
  recordUsage,
  saveModelState,
  type ModelStateRow,
  type ModelStatus,
} from './db';
import { fetchWithRetry, TimeoutError } from './net';

const endpointFor = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const TRANSCRIBE_PROMPT = [
  'Transcribe this meeting verbatim in the language spoken. One segment per',
  'speaking turn, each with:',
  '- startSeconds: whole seconds from the start of the audio when the turn begins.',
  '- speaker: 1 for the first voice, 2 for the next new voice, and so on; keep each',
  '  number tied to the same voice throughout.',
  '- text: exactly what was said, original language.',
  '',
  'Meetings usually have several speakers — track changes in voice and split on',
  'every speaker change, including short interjections ("hmm", "yes"). Split a turn',
  'longer than ~30s at a sentence boundary. Do not summarise, translate, or comment.',
  'Write [inaudible] for anything unclear.',
].join('\n');

const SUMMARY_PROMPT = `From the meeting transcript below, generate a title and summary.

LANGUAGE — Preserve the transcript's language mix exactly. Write narrative in the transcript's primary language (usually Bengali), while keeping all technical terms, product names, APIs, code identifiers, parameter names, error codes, and English jargon exactly as spoken (e.g. access token, refresh token, force renew, React, Native, API, OMR, HTTP 401). Do not translate these terms into Bengali, and do not rewrite the summary entirely in English unless the transcript itself is entirely English.

CONTENT — Base every statement on the transcript; do not fabricate decisions, deadlines, or conclusions that were not discussed. You MAY attribute an action item's owner when the transcript makes clear who will do it — someone volunteers, is asked and agrees, or is plainly the one handling that work — not only when it is a formal assignment. If something was discussed but not agreed upon, include it under KEY POINTS, not DECISIONS.

TITLE
- 3–8 words.
- Describe the meeting's primary topic or main outcome.
- Sentence case.
- No "Meeting", date, time, or trailing punctuation.

SUMMARY

Return plain text only (no markdown) using exactly the following sections, with one blank line between each section:

OVERVIEW
2–3 sentences describing what the meeting was about.

KEY POINTS
One bullet per substantive discussion point.

DECISIONS
One bullet per explicit decision.
If none were recorded, write exactly:
None recorded

ACTION ITEMS
One bullet per concrete follow-up task discussed, even if assigned only informally, using:
owner — task — deadline
Name the owner whenever the transcript makes clear who will do it; use "unassigned" only when ownership is genuinely unclear, and "no deadline" when none was stated.
If none were recorded, write exactly:
None recorded

Preserve the original names of methods, parameters, APIs, payload fields, and status codes exactly as spoken (e.g. force renew, success, data, message, 401, refresh token). Prefer completeness over brevity while avoiding repetition.`;

/**
 * The title rides along with the summary rather than costing its own request.
 * Free-tier quota is roughly 20 requests per model per day, so a separate call
 * just to name the meeting would come straight out of the recording budget.
 */
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    summary: { type: 'STRING' },
  },
  required: ['title', 'summary'],
};

/** Raised only when a 429 explicitly identifies a daily quota limit. */
class QuotaError extends Error {}

/**
 * Raised for short-window or ambiguous 429s. Unlike a daily quota failure this
 * must not be remembered until midnight: RPM/TPM limits recover on their own,
 * and a bare RESOURCE_EXHAUSTED response does not prove which limit fired.
 */
class RateLimitError extends Error {}

/** Raised when this account cannot use the model — worth another model. */
class ModelUnavailableError extends Error {}

/**
 * Raised when a model is overloaded (503 "high demand") and still overloaded
 * after `net.ts` has exhausted its short retries. Load is per model, so a
 * sibling is usually answering fine — worth another model, but not another key.
 */
class ModelBusyError extends Error {}

/**
 * Raised when the key itself is rejected — revoked, deleted, mistyped. Another
 * model cannot help, but the next key can, which is the whole point of keeping
 * a backup.
 */
class InvalidKeyError extends Error {}

/**
 * What the fallback walk is currently doing. Without this a 404-then-retry is
 * invisible from the UI — the screen simply says "Transcribing" for longer, and
 * a run that quietly burned through three models looks identical to a fast one.
 */
export type GeminiAttempt = {
  model: string;
  /** 1-based, so it can be shown as "key 2 of 3" without arithmetic at the UI. */
  keyNumber: number;
  keyCount: number;
  outcome:
    | 'trying'
    | 'ok'
    | 'quota'
    | 'rate-limit'
    | 'unavailable'
    | 'busy'
    | 'rejected'
    | 'timeout'
    | 'uploading';
  /** Bytes sent so far, only on 'uploading' — lets the UI show "1.2 / 3.1 MB". */
  sentBytes?: number;
  totalBytes?: number;
  /** Wall-clock this attempt took, on terminal outcomes — for the timing log. */
  ms?: number;
};

const attemptListeners = new Set<(attempt: GeminiAttempt) => void>();

/**
 * Reports each model/key the fallback walk tries. A listener registry rather
 * than a callback parameter: the walk lives three layers below the screen, and
 * threading one through `transcribeAudio` and `processMeeting` would put a
 * progress concern into every signature between here and there.
 *
 * Returns an unsubscribe function.
 */
export function onGeminiAttempt(listener: (attempt: GeminiAttempt) => void): () => void {
  attemptListeners.add(listener);
  return () => attemptListeners.delete(listener);
}

function emit(attempt: GeminiAttempt): void {
  for (const listener of attemptListeners) {
    try {
      listener(attempt);
    } catch {
      // A broken listener must never take down a transcription.
    }
  }
}

/**
 * Once a model answers for a given key we keep using it, so the fallback walk
 * costs at most one wasted request per key per app session.
 */
const resolvedModel = new Map<string, string>();

/**
 * Google's free-tier daily quota resets at midnight US Pacific, not local
 * midnight — in Dhaka that lands around 1pm. Keying exhaustion to the local date
 * would keep a model marked spent for the eleven hours after it had actually
 * come back, so the Pacific date is what we record.
 *
 * Fixed -7 rather than real timezone handling: Hermes' Intl support for named
 * zones is not something to depend on here, and the error is confined to a
 * one-hour window twice a year when US daylight saving shifts. The cost of
 * being wrong is one wasted probe, not a failure.
 */
function pacificDay(now = Date.now()): string {
  return new Date(now - 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Identifies a key in the database without storing it. Not a security boundary
 * — the key itself never leaves SecureStore — just a stable name for a cache row.
 */
function fingerprint(apiKey: string): string {
  let hash = 5381;
  for (let i = 0; i < apiKey.length; i++) {
    hash = ((hash << 5) + hash + apiKey.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Disk-backed view of what each key/model did, loaded once per app session. */
let modelState: Map<string, ModelStateRow> | null = null;

const stateKey = (keyHash: string, model: string) => `${keyHash}::${model}`;

async function getModelState(): Promise<Map<string, ModelStateRow>> {
  if (!modelState) {
    try {
      const rows = await loadModelState();
      modelState = new Map(rows.map((r) => [stateKey(r.keyHash, r.model), r]));
    } catch {
      // A cache that cannot be read must not stop transcription.
      modelState = new Map();
    }
  }
  return modelState;
}

async function rememberModel(
  keyHash: string,
  model: string,
  status: ModelStatus
): Promise<void> {
  // Availability can differ between projects and can change as Google rolls a
  // model out or grants access. Remember a 404 for this key today so retries do
  // not repeat a known failure, but probe it again after the Pacific-day reset.
  const day = pacificDay();
  const row: ModelStateRow = { keyHash, model, status, day };
  (await getModelState()).set(stateKey(keyHash, model), row);
  try {
    await saveModelState(row);
  } catch {
    // In-memory copy still applies for this session.
  }
}

/** True when a remembered failure still applies and the model is worth skipping. */
function isSpent(row: ModelStateRow | undefined, today: string): boolean {
  if (!row) return false;
  if (
    row.status === 'unavailable' ||
    row.status === 'quota' ||
    row.status === 'rejected'
  ) {
    return row.day === today;
  }
  return false;
}

/** Cache key: the same API key can resolve differently per model list. */
const cacheKey = (apiKey: string, models: string[]) => `${apiKey}::${models[0]}`;

type Part =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { mime_type: string; file_uri: string } };

/**
 * Forcing an array of segments makes the failure we actually hit — one
 * undifferentiated block covering the whole meeting — impossible by
 * construction. Free-text output only *asks* for line breaks; a schema
 * guarantees them.
 */
const TRANSCRIPT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      startSeconds: { type: 'INTEGER' },
      speaker: { type: 'INTEGER' },
      text: { type: 'STRING' },
    },
    required: ['startSeconds', 'speaker', 'text'],
  },
};

type Segment = { startSeconds: number; speaker: number; text: string };

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${String(hh).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Models routinely place timestamps past the end of the audio — a real 2:37
 * recording came back with a last segment at 03:54, repeatedly, across models.
 * The drift is proportional rather than random, and we know the true length
 * from the recorder, so scaling the whole series back is both safe and enough.
 *
 * Only applied when the overshoot is real (>5%), so an already-accurate
 * transcript is left alone.
 */
function rescaleToDuration(segments: Segment[], durationSec?: number): Segment[] {
  if (!durationSec || durationSec <= 0 || segments.length === 0) return segments;

  const last = Math.max(...segments.map((s) => Number(s.startSeconds) || 0));
  if (last <= durationSec * 1.05) return segments;

  // Map the reported span onto the real one; the final turn cannot begin at the
  // very last instant, so leave a small tail.
  const factor = (durationSec * 0.98) / last;
  return segments.map((s) => ({
    ...s,
    startSeconds: Math.round((Number(s.startSeconds) || 0) * factor),
  }));
}

/**
 * Segments are rendered back into the `[MM:SS] Speaker N: …` text the rest of
 * the app already stores, uploads to Drive and posts to TaskNote. The schema is
 * a transport detail; nothing downstream needs to change.
 */
function segmentsToTranscript(segments: Segment[]): string {
  return segments
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map(
      (s) =>
        `[${formatClock(Number(s.startSeconds) || 0)}] Speaker ${
          Number(s.speaker) || 1
        }: ${s.text.trim()}`
    )
    .join('\n');
}

/**
 * Walks keys within a model, not models within a key: the first model in the
 * list is the best one available, so every key gets a chance at it before the
 * quality is downgraded. Both orders eventually reach the same set of key/model
 * pairs — this one just spends the good model's allowance first.
 *
 * Extra keys add quota only when they belong to different Google Cloud projects.
 * Multiple keys for one project share the same limits and will fail together.
 */
async function callGemini(params: {
  apiKeys: string[];
  parts: Part[];
  temperature: number;
  responseSchema?: unknown;
  /** Model order for this call; transcription prefers a different one. */
  models?: string[];
  /** Deadline for one attempt. See the timeout constants in config.ts. */
  timeoutMs?: number;
  /**
   * When set, the audio is uploaded to the Files API once per key and appended
   * to `parts` as a file reference, instead of being inlined. This is what makes
   * a stalled retry cheap — the bytes are already up.
   */
  audio?: { audioPath: string; mimeType: string; sizeBytes: number };
}): Promise<string> {
  const candidates = params.models ?? GEMINI_MODELS;
  const keys = params.apiKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('No Gemini API key configured. Add one in Settings.');
  }

  let exhausted = 0;
  let lastModelError: Error | null = null;
  let lastBusyError: Error | null = null;
  let lastRateLimitError: Error | null = null;
  let lastKeyError: Error | null = null;
  let badKeys = 0;

  const state = await getModelState();
  const today = pacificDay();

  // Skipping is only safe while something is left to try. If every combination
  // is remembered as spent the memory is either right — in which case one probe
  // costs little — or stale, and refusing to probe would lock the user out until
  // the date changed. Probing wins in both cases.
  const anyLive = keys.some((apiKey) =>
    candidates.some((model) => !isSpent(state.get(stateKey(fingerprint(apiKey), model)), today))
  );

  // Keys a rejection has already ruled out. Held across the model rounds below,
  // since a key the API refuses is refused for every model.
  const deadKeys = new Set<string>();
  let quotaSeen = false;

  // A stall is the connection, not the model, so a second attempt on a dead link
  // stalls too — and each attempt is one of the day's ~20 requests. So the first
  // genuine stall stops the whole walk rather than marching through every model
  // and key. Quota (429) and availability (404) still fall through normally,
  // because those are instant and genuinely per key/model.
  let timeouts = 0;
  const MAX_TIMEOUTS = 1;

  // Audio uploaded to the Files API, one entry per key. Held for the whole walk
  // so later model rounds on a key reuse its upload instead of sending again.
  const uploadedByKey = new Map<string, string>();

  for (const model of candidates) {
    // The key that last answered for this model goes first, so a working
    // combination is re-found immediately instead of re-walking the rejects.
    const preferred = keys.find(
      (apiKey) => state.get(stateKey(fingerprint(apiKey), model))?.status === 'ok'
    );
    const ordered = preferred ? [preferred, ...keys.filter((k) => k !== preferred)] : keys;

    for (const apiKey of ordered) {
      if (deadKeys.has(apiKey)) continue;

      const keyHash = fingerprint(apiKey);
      const where = { keyNumber: keys.indexOf(apiKey) + 1, keyCount: keys.length };

      // Anything this key is known to have spent today is skipped without a
      // request, which is the whole point: each attempt re-uploads the audio.
      if (anyLive && isSpent(state.get(stateKey(keyHash, model)), today)) {
        const status = state.get(stateKey(keyHash, model))!.status;
        if (status === 'quota') quotaSeen = true;
        if (status === 'rejected') {
          lastKeyError = lastKeyError ?? new Error('rejected earlier today');
          if (!deadKeys.has(apiKey)) {
            deadKeys.add(apiKey);
            badKeys += 1;
          }
        }
        continue;
      }

      // Wall-clock for this one attempt, reported on the terminal event so the
      // Diagnostics panel can show where a slow stage's seconds actually went.
      const attemptStart = Date.now();
      const since = () => Date.now() - attemptStart;
      try {
        let parts = params.parts;
        if (params.audio) {
          // Upload once per key; a stalled generate below then costs only the
          // reference call, not the recording, when it moves to the next key.
          let fileUri = uploadedByKey.get(keyHash);
          if (!fileUri) {
            emit({ ...where, model, outcome: 'uploading', sentBytes: 0, totalBytes: params.audio.sizeBytes });
            fileUri = await uploadAudioToGemini({
              apiKey,
              audioPath: params.audio.audioPath,
              mimeType: params.audio.mimeType,
              sizeBytes: params.audio.sizeBytes,
              onProgress: (sentBytes, totalBytes) =>
                emit({ ...where, model, outcome: 'uploading', sentBytes, totalBytes }),
            });
            uploadedByKey.set(keyHash, fileUri);
          }
          parts = [...params.parts, { file_data: { mime_type: params.audio.mimeType, file_uri: fileUri } }];
        }

        emit({ ...where, model, outcome: 'trying' });
        const result = await callOnce({ ...params, parts, apiKey, model });
        resolvedModel.set(cacheKey(apiKey, candidates), model);
        await rememberModel(keyHash, model, 'ok');
        emit({ ...where, model, outcome: 'ok', ms: since() });
        return result;
      } catch (err) {
        if (err instanceof TimeoutError) {
          emit({ ...where, model, outcome: 'timeout', ms: since() });
          timeouts += 1;
          if (timeouts >= MAX_TIMEOUTS) {
            // One stall is enough: the link, not the model, is the problem, so
            // the next attempt would stall the same way and cost another request.
            throw new Error(
              `The connection stalled with no response from Gemini. ` +
                `Your recording is saved — tap Try now once you are back on a stable network.`
            );
          }
          continue;
        }
        if (err instanceof ModelUnavailableError) {
          emit({ ...where, model, outcome: 'unavailable', ms: since() });
          // Model access is scoped to the key's Google Cloud project. A 404 for
          // this project says nothing about the next configured key/project, so
          // cache only this pair and let the inner loop try the same model with
          // the remaining keys.
          await rememberModel(keyHash, model, 'unavailable');
          lastModelError = err;
          continue;
        }
        if (err instanceof ModelBusyError) {
          // Overload is a property of the model itself, so the same model on a
          // different key is overloaded too. This is the one case that gives up
          // on the model rather than working through the keys — trying them all
          // would re-upload the recording for a predictable failure.
          emit({ ...where, model, outcome: 'busy', ms: since() });
          lastBusyError = err;
          break;
        }
        if (err instanceof RateLimitError) {
          // A short-window 429 may clear in seconds, while another configured
          // key belongs to a different project and may work immediately. Keep
          // walking, but do not poison this pair's disk cache for the whole day.
          emit({ ...where, model, outcome: 'rate-limit', ms: since() });
          lastRateLimitError = err;
          continue;
        }
        if (err instanceof InvalidKeyError) {
          // No model will accept a rejected key — rule it out for every round.
          emit({ ...where, model, outcome: 'rejected', ms: since() });
          await rememberModel(keyHash, model, 'rejected');
          lastKeyError = err;
          deadKeys.add(apiKey);
          badKeys += 1;
          continue;
        }
        if (err instanceof QuotaError) {
          // Quota is per project and model. A key from another configured
          // project can still have untouched allowance for this same model.
          emit({ ...where, model, outcome: 'quota', ms: since() });
          await rememberModel(keyHash, model, 'quota');
          quotaSeen = true;
          resolvedModel.delete(cacheKey(apiKey, candidates));
          continue;
        }
        throw err;
      }
    }
  }

  if (quotaSeen) exhausted = keys.length;

  // Naming which key failed matters when several are configured.
  if (lastKeyError && badKeys === keys.length) {
    throw new Error(
      keys.length > 1
        ? `All ${keys.length} API keys were rejected: ${lastKeyError.message}`
        : `API key rejected: ${lastKeyError.message}`
    );
  }

  // Short-window throttling is temporary and was deliberately not cached.
  if (lastRateLimitError && exhausted === 0) {
    throw new Error(
      'Gemini is temporarily rate-limiting requests. No daily quota limit was confirmed, ' +
        'so this was not cached; wait a minute and tap Try now again.'
    );
  }

  // Overload is temporary, so say so rather than blaming the key or the quota.
  if (lastBusyError && exhausted === 0) {
    throw new Error(
      'Gemini is busy right now — every model returned "high demand". ' +
        'Your recording is saved; tap Try now again in a minute.'
    );
  }

  if (lastModelError && exhausted === 0) {
    throw new Error(
      `No usable Gemini model for this key. Last error: ${lastModelError.message}`
    );
  }

  const modelCount = candidates.length;
  throw new Error(
    keys.length > 1
      ? `Daily quota is used up on all ${modelCount} models for all ${keys.length} keys. Free-tier limits reset at midnight Pacific time. Keys from the same Google Cloud project share limits; a key from another project adds headroom.`
      : `Daily quota is used up on all ${modelCount} models for this key. Free-tier limits reset at midnight Pacific time, or add a key from another Google Cloud project in Settings.`
  );
}

/**
 * Turns an HTTP status + error text into the taxonomy the walk understands, so
 * an upload and a generate call classify a 429 or a dead key the same way. Null
 * means the response is fine. Shared to keep the two call sites from drifting.
 */
type GeminiErrorBody = {
  code?: number | string;
  message?: string;
  status?: string;
  details?: unknown[];
};

/** True only when Google's response names a per-day limit. */
function isDailyQuota(message: string, error?: GeminiErrorBody | null): boolean {
  const evidence = [String(error?.code ?? ''), message, JSON.stringify(error?.details ?? [])].join(
    ' '
  );
  return /quota_exceeded|daily quota|per[\s_-]*day|perday/i.test(evidence);
}

function classifyError(
  status: number,
  message: string,
  error?: GeminiErrorBody | null
): Error | null {
  if (status === 429) {
    return isDailyQuota(message, error)
      ? new QuotaError(message || 'Daily quota exceeded')
      : new RateLimitError(message || 'Temporarily rate limited');
  }
  if (
    status === 404 ||
    /no longer available|not found|not supported|does not exist/i.test(message)
  ) {
    return new ModelUnavailableError(message || `HTTP ${status}`);
  }
  if (status >= 500 || /high demand|overloaded|try again later/i.test(message)) {
    return new ModelBusyError(message || `HTTP ${status}`);
  }
  if (
    status === 401 ||
    status === 403 ||
    /api key not valid|api key expired|invalid api key|permission denied/i.test(message)
  ) {
    return new InvalidKeyError(message || `HTTP ${status}`);
  }
  if (status < 200 || status >= 300) {
    return new Error(`Gemini request failed: ${message || `HTTP ${status}`}`);
  }
  return null;
}

const UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const FILE_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Uploads an audio file to the Files API for one key and returns its file URI.
 *
 * The whole point over inline base64: the bytes go up ONCE per key, streamed
 * off disk rather than held in memory, and every model attempt for that key then
 * references the URI instead of re-sending the recording. A stalled generate no
 * longer re-uploads megabytes; only the tiny reference call is retried.
 *
 * Errors are mapped onto the same taxonomy as a generate call, so a dead key or
 * an exhausted quota during upload drives the same fallback.
 */
async function uploadAudioToGemini(params: {
  apiKey: string;
  audioPath: string;
  mimeType: string;
  sizeBytes: number;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}): Promise<string> {
  const { apiKey, audioPath, mimeType } = params;

  // The declared length MUST match the bytes actually sent, or the resumable
  // upload is rejected, so it is read from the file rather than trusted from the
  // caller — a 0 here would corrupt every upload silently.
  const audioFile = new File(audioPath);
  const sizeBytes = params.sizeBytes || audioFile.size || 0;
  if (!sizeBytes) throw new Error('Could not determine the audio file size to upload.');

  // 1) Start a resumable session. Small request, so the standard retry applies.
  const start = await fetchWithRetry(
    UPLOAD_BASE,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'recording' } }),
    },
    { timeoutMs: TEXT_TIMEOUT_MS }
  );
  if (!start.ok) {
    const payload = await start.json().catch(() => null);
    const error: GeminiErrorBody | null = payload?.error ?? null;
    const msg = error?.message ?? '';
    throw (
      classifyError(start.status, msg, error) ??
      new Error(`Upload start failed: HTTP ${start.status}`)
    );
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API did not return an upload URL.');

  // 2) Send the bytes, streamed from disk with a size-scaled deadline. A stall
  // here aborts via the signal and surfaces as a TimeoutError, same as generate.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), uploadTimeoutMs(sizeBytes));
  let result;
  try {
    result = await audioFile.upload(uploadUrl, {
      httpMethod: 'PUT',
      uploadType: UploadType.BINARY_CONTENT,
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      onProgress: ({ bytesSent, totalBytes }) =>
        params.onProgress?.(bytesSent, totalBytes || sizeBytes),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(`Upload stalled after ${Math.round(uploadTimeoutMs(sizeBytes) / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Status is checked on the RAW body first: the upload endpoint can answer with
  // plain text or HTML rather than JSON (a transient Google error/notice), and
  // parsing before this check crashed with an opaque "unexpected character: C…"
  // instead of a usable error. The raw snippet is carried into the message so a
  // recurrence shows what actually came back.
  const body = (result.body || '').toString();
  if (result.status < 200 || result.status >= 300) {
    let message = body.slice(0, 300);
    let error: GeminiErrorBody | null = null;
    try {
      error = JSON.parse(body)?.error ?? null;
      message = error?.message ?? message;
    } catch {
      // Non-JSON error body — keep the raw snippet as the message.
    }
    throw (
      classifyError(result.status, message, error) ??
      new Error(`Upload failed: HTTP ${result.status} — ${message}`)
    );
  }

  let meta: { file?: { state?: string; name?: string; uri?: string } };
  try {
    meta = JSON.parse(body || '{}');
  } catch {
    throw new Error(
      `Files API returned a non-JSON upload response (HTTP ${result.status}): ${body.slice(0, 200)}`
    );
  }
  let file = meta.file ?? {};

  // 3) Audio arrives PROCESSING and cannot be referenced until ACTIVE; a small
  // file is usually ready at once, a long one needs a few seconds.
  const deadline = Date.now() + TEXT_TIMEOUT_MS;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new TimeoutError('File stuck in PROCESSING.');
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetchWithRetry(
      `${FILE_BASE}/${file.name}`,
      { headers: { 'x-goog-api-key': apiKey } },
      { timeoutMs: TEXT_TIMEOUT_MS }
    );
    const payload = await poll.json().catch(() => null);
    if (!poll.ok) {
      const error: GeminiErrorBody | null = payload?.error ?? null;
      const message = error?.message ?? '';
      throw (
        classifyError(poll.status, message, error) ??
        new Error(`File status failed: HTTP ${poll.status}`)
      );
    }
    file = payload?.file ?? {};
  }
  if (file.state !== 'ACTIVE' || !file.uri) {
    throw new Error(`File did not become ACTIVE (state: ${file.state ?? 'unknown'}).`);
  }
  return file.uri as string;
}

/**
 * Neither transcription nor summarization is a reasoning task, so the model's
 * default "thinking" is pure latency and wasted tokens. Gemini 3.8 and 3.7 no
 * longer accept `minimal`, so they use their lowest supported level (`low`).
 * Earlier Gemini 3 models use `minimal`; sending `thinkingLevel` to a 2.5 model
 * 400s, so the legacy fallbacks are left at their default.
 */
function thinkingConfigFor(model: string): { thinkingLevel: string } | null {
  if (/^gemini-3\.(8|7)-flash$/.test(model)) return { thinkingLevel: 'low' };
  return /^gemini-3/.test(model) ? { thinkingLevel: 'minimal' } : null;
}

async function callOnce(params: {
  apiKey: string;
  model: string;
  parts: Part[];
  temperature: number;
  responseSchema?: unknown;
  timeoutMs?: number;
}): Promise<string> {
  const thinking = thinkingConfigFor(params.model);
  // A 5xx is temporary service trouble, not quota. The shared request helper
  // retries it with bounded exponential backoff before the model walk moves on.
  // Audio is already in the Files API, so this does not re-upload the recording.
  const response = await fetchWithRetry(
    endpointFor(params.model),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': params.apiKey },
      body: JSON.stringify({
        contents: [{ parts: params.parts }],
        generationConfig: {
          temperature: params.temperature,
          ...(thinking ? { thinkingConfig: thinking } : {}),
          ...(params.responseSchema
            ? { responseMimeType: 'application/json', responseSchema: params.responseSchema }
            : {}),
        },
      }),
    },
    { timeoutMs: params.timeoutMs }
  );

  const payload = await response.json().catch(() => null);
  const message: string = payload?.error?.message ?? '';
  const classified = classifyError(response.status, message, payload?.error);
  if (classified) throw classified;

  const total = payload?.usageMetadata?.totalTokenCount;
  if (typeof total === 'number') {
    // Best-effort accounting; never let a bookkeeping failure break the call.
    recordUsage(total).catch(() => undefined);
  }

  const candidate = payload?.candidates?.[0];
  const text: string = (candidate?.content?.parts ?? [])
    .map((part: { text?: string }) => part.text ?? '')
    .join('')
    .trim();

  if (!text) {
    const reason = candidate?.finishReason;
    throw new Error(
      reason && reason !== 'STOP'
        ? `Gemini returned nothing (finishReason: ${reason})`
        : 'Gemini returned an empty response.'
    );
  }
  return text;
}

export async function transcribeAudio(params: {
  apiKeys: string[];
  /** Local file, uploaded to the Files API and streamed from disk. */
  audioPath: string;
  mimeType: string;
  sizeBytes: number;
  /** True recording length, used to pull drifting timestamps back into range. */
  durationSec?: number;
}): Promise<string> {
  const raw = await callGemini({
    apiKeys: params.apiKeys,
    temperature: 0,
    models: TRANSCRIBE_MODELS,
    responseSchema: TRANSCRIPT_SCHEMA,
    timeoutMs: transcribeTimeoutMs(params.durationSec),
    parts: [{ text: TRANSCRIBE_PROMPT }],
    audio: {
      audioPath: params.audioPath,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
    },
  });

  let segments: Segment[] | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) segments = parsed as Segment[];
  } catch {
    segments = null;
  }

  // Falling back to the raw response keeps a usable transcript if the model
  // ever answers with prose instead of JSON — losing formatting beats losing
  // the recording.
  return segments
    ? segmentsToTranscript(rescaleToDuration(segments, params.durationSec))
    : raw.trim();
}

/**
 * Cleans a generated title into something safe to use as a Drive folder and
 * file name, since that is exactly what the upload stage does with it. The
 * stripped characters are the ones Drive and Android both dislike; quotes and a
 * trailing full stop are just tidying up after the model.
 */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim()
    .slice(0, 80)
    .trim();
}

/**
 * The summary is *generated*, not echoed like the transcript, so the model
 * chooses its language — and generating JSON behind a long English prompt it
 * defaults to English even when told to match the transcript. Naming the
 * language concretely (not "the transcript's language") and repeating it right
 * before generation is what actually holds. Detected from the script rather
 * than trusting the model to notice: Bengali text lives in U+0980–U+09FF, so if
 * it outweighs the Latin letters (the English technical terms), the transcript
 * is Bengali-primary.
 */
function summaryLanguageReminder(transcript: string): string {
  const bengali = (transcript.match(/[ঀ-৿]/g) || []).length;
  const latin = (transcript.match(/[A-Za-z]/g) || []).length;
  if (bengali > latin) {
    return (
      'LANGUAGE REMINDER — The transcript above is in Bengali. Write the entire ' +
      'summary (and the title) in Bengali, keeping technical terms, product names ' +
      'and English jargon in English exactly as spoken. Do NOT write the summary ' +
      'in English.'
    );
  }
  return 'LANGUAGE REMINDER — Write the entire summary in the same language as the transcript above.';
}

export async function summarizeTranscript(params: {
  apiKeys: string[];
  transcript: string;
}): Promise<{ title: string; summary: string }> {
  const prompt = [
    SUMMARY_PROMPT,
    '',
    '---TRANSCRIPT---',
    params.transcript,
    '---END TRANSCRIPT---',
    '',
    // Placed after the transcript on purpose: an instruction at the end, right
    // before generation, is followed far more reliably than one at the top.
    summaryLanguageReminder(params.transcript),
  ].join('\n');

  const raw = await callGemini({
    apiKeys: params.apiKeys,
    // Deterministic (was 0.2): sampling variance was letting the same transcript
    // summarise in Bengali one run and English the next.
    temperature: 0,
    responseSchema: SUMMARY_SCHEMA,
    timeoutMs: TEXT_TIMEOUT_MS,
    parts: [{ text: prompt }],
  });

  // A model that answers with prose instead of JSON still produced a usable
  // summary; keeping it unnamed beats discarding it.
  try {
    const parsed = JSON.parse(raw);
    const summary = String(parsed?.summary ?? '').trim();
    if (summary) {
      return { title: sanitizeTitle(String(parsed?.title ?? '')), summary };
    }
  } catch {
    // fall through
  }
  return { title: '', summary: raw.trim() };
}

export async function askAboutTranscript(params: {
  apiKeys: string[];
  transcript: string;
  question: string;
}): Promise<string> {
  const prompt = [
    'Answer the question using only the meeting transcript below.',
    'If the transcript does not contain the answer, say so plainly rather than guessing.',
    'Quote the relevant line when it helps, and cite its [MM:SS] timestamp so the moment',
    'can be found in the recording. Answer in the language of the question.',
    '',
    '---TRANSCRIPT---',
    params.transcript,
    '---END TRANSCRIPT---',
    '',
    `QUESTION: ${params.question}`,
  ].join('\n');

  return callGemini({
    apiKeys: params.apiKeys,
    temperature: 0.2,
    timeoutMs: TEXT_TIMEOUT_MS,
    parts: [{ text: prompt }],
  });
}

/** Cheap round-trip used by the Settings screen to check one pasted key. */
export async function verifyApiKey(apiKey: string): Promise<void> {
  const response = await fetchWithRetry('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }
}
