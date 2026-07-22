import { GEMINI_MODELS, TRANSCRIBE_MODELS } from './config';
import {
  loadModelState,
  recordUsage,
  saveModelState,
  type ModelStateRow,
  type ModelStatus,
} from './db';
import { fetchWithRetry } from './net';

const endpointFor = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const TRANSCRIBE_PROMPT = [
  'Transcribe this meeting recording verbatim, in the language actually spoken.',
  '',
  'A meeting has MORE THAN ONE speaker. Listen for changes in voice, pitch and',
  'speaking style and attribute each turn to the right person. Producing a single',
  'speaker for the whole recording is wrong unless it is genuinely a monologue.',
  '',
  'Return one segment per speaking turn:',
  '- startSeconds: when the turn begins, in whole seconds from the start of the audio.',
  '- speaker: 1 for the first person to talk, 2 for the next new voice, and so on.',
  '  Keep each number attached to the same voice for the whole recording.',
  '- text: exactly what was said, in the original language.',
  '',
  'Rules:',
  '- Start a new segment EVERY time the speaker changes, however briefly — including',
  '  short interjections like "hmm", "yes", "right".',
  '- If one person talks continuously for more than about 30 seconds, split at a',
  '  natural sentence boundary rather than emitting one enormous segment.',
  '- Transcribe only what was said. Do not summarise, translate, or add commentary.',
  '- Write [inaudible] for anything you cannot make out.',
].join('\n');

const SUMMARY_PROMPT = [
  'Below is a meeting transcript. Return a title for the meeting, and a summary.',
  '',
  'The title names what was actually discussed or decided, in 3 to 8 words.',
  'No date and no time — the app already records when the meeting happened — and',
  'no leading "Meeting" or "Call". Sentence case, no trailing full stop.',
  '',
  'Write the summary in the same language as the transcript, using these sections',
  'and nothing else:',
  '',
  'OVERVIEW — two or three sentences on what the meeting was about.',
  'KEY POINTS — bullets of the substantive things discussed.',
  'DECISIONS — bullets of what was actually decided. Write "None recorded" if nothing was.',
  'ACTION ITEMS — bullets as "owner — task — deadline". Use "unassigned" or "no deadline"',
  'where the transcript does not say. Write "None recorded" if there are none.',
  '',
  'Base every line strictly on the transcript. Do not infer decisions or owners that were',
  'not stated. Plain text only, no markdown symbols. Write the title in the same',
  'language as the transcript too.',
  '',
  'Formatting: the summary is a single string, but it must still contain real line',
  'breaks. Put each section heading on its own line, each bullet on its own line, and',
  'a blank line between sections. Do not run the sections together into one paragraph.',
].join('\n');

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

/** Raised only for 429 / RESOURCE_EXHAUSTED, the one case worth another key. */
class QuotaError extends Error {}

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
  outcome: 'trying' | 'ok' | 'quota' | 'unavailable' | 'busy' | 'rejected';
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
  // 404 is a property of the account, not of today — a model retired for this
  // key does not come back tomorrow, so it is remembered without an expiry.
  const day = status === 'unavailable' ? null : pacificDay();
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
  if (row.status === 'unavailable') return true;
  if (row.status === 'quota' || row.status === 'rejected') return row.day === today;
  return false;
}

/** Cache key: the same API key can resolve differently per model list. */
const cacheKey = (apiKey: string, models: string[]) => `${apiKey}::${models[0]}`;

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

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
 * Note the extra keys only help when they belong to different Google accounts —
 * quota is enforced per project, so several keys from one account share a single
 * pool and will all fail together.
 */
async function callGemini(params: {
  apiKeys: string[];
  parts: Part[];
  temperature: number;
  disableThinking?: boolean;
  responseSchema?: unknown;
  /** Model order for this call; transcription prefers a different one. */
  models?: string[];
}): Promise<string> {
  const candidates = params.models ?? GEMINI_MODELS;
  const keys = params.apiKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('No Gemini API key configured. Add one in Settings.');
  }

  let exhausted = 0;
  let lastModelError: Error | null = null;
  let lastBusyError: Error | null = null;
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

      try {
        emit({ ...where, model, outcome: 'trying' });
        const result = await callOnce({ ...params, apiKey, model });
        resolvedModel.set(cacheKey(apiKey, candidates), model);
        await rememberModel(keyHash, model, 'ok');
        emit({ ...where, model, outcome: 'ok' });
        return result;
      } catch (err) {
        if (err instanceof ModelUnavailableError) {
          // This account has no access to this model; another key may well have.
          emit({ ...where, model, outcome: 'unavailable' });
          await rememberModel(keyHash, model, 'unavailable');
          lastModelError = err;
          continue;
        }
        if (err instanceof ModelBusyError) {
          // Overload is a property of the model itself, so the same model on a
          // different key is overloaded too. This is the one case that gives up
          // on the model rather than working through the keys — trying them all
          // would re-upload the recording for a predictable failure.
          emit({ ...where, model, outcome: 'busy' });
          lastBusyError = err;
          break;
        }
        if (err instanceof InvalidKeyError) {
          // No model will accept a rejected key — rule it out for every round.
          emit({ ...where, model, outcome: 'rejected' });
          await rememberModel(keyHash, model, 'rejected');
          lastKeyError = err;
          deadKeys.add(apiKey);
          badKeys += 1;
          continue;
        }
        if (err instanceof QuotaError) {
          // Requests-per-day is metered per key and per model, so the next key
          // still has its own untouched allowance for this same model.
          emit({ ...where, model, outcome: 'quota' });
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
      ? `Daily quota is used up on all ${modelCount} models for all ${keys.length} keys. Free-tier limits reset at midnight Pacific time. If the keys share a Google account they share the same limits — a key from a different account would add headroom.`
      : `Daily quota is used up on all ${modelCount} models for this key. Free-tier limits reset at midnight Pacific time, or add a key from a different Google account in Settings.`
  );
}

async function callOnce(params: {
  apiKey: string;
  model: string;
  parts: Part[];
  temperature: number;
  disableThinking?: boolean;
  responseSchema?: unknown;
}): Promise<string> {
  // No in-place 5xx retry: the model list below is the recovery path, and each
  // retry would resend the whole recording to a model already saying it is busy.
  const response = await fetchWithRetry(
    endpointFor(params.model),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': params.apiKey },
      body: JSON.stringify({
        contents: [{ parts: params.parts }],
        generationConfig: {
          temperature: params.temperature,
          ...(params.disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          ...(params.responseSchema
            ? { responseMimeType: 'application/json', responseSchema: params.responseSchema }
            : {}),
        },
      }),
    },
    { retryServerErrors: false }
  );

  const payload = await response.json().catch(() => null);

  if (response.status === 429) {
    throw new QuotaError(payload?.error?.message ?? 'Quota exceeded');
  }

  const message: string = payload?.error?.message ?? '';
  // Retired-for-new-accounts models answer 404, but 400 also carries the
  // "no longer available" wording, so match on the text as well as the status.
  if (
    response.status === 404 ||
    /no longer available|not found|not supported|does not exist/i.test(message)
  ) {
    throw new ModelUnavailableError(message || `HTTP ${response.status}`);
  }

  // 500/502/504 land here too. These are not retried in place — the next model
  // is both faster and likelier to work, since overload is per model.
  if (response.status >= 500 || /high demand|overloaded|try again later/i.test(message)) {
    throw new ModelBusyError(message || `HTTP ${response.status}`);
  }

  if (
    response.status === 401 ||
    response.status === 403 ||
    /api key not valid|api key expired|invalid api key|permission denied/i.test(message)
  ) {
    throw new InvalidKeyError(message || `HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${message || `HTTP ${response.status}`}`);
  }

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
  base64Audio: string;
  mimeType: string;
  /** True recording length, used to pull drifting timestamps back into range. */
  durationSec?: number;
}): Promise<string> {
  const raw = await callGemini({
    apiKeys: params.apiKeys,
    temperature: 0,
    models: TRANSCRIBE_MODELS,
    responseSchema: TRANSCRIPT_SCHEMA,
    parts: [
      { text: TRANSCRIBE_PROMPT },
      { inline_data: { mime_type: params.mimeType, data: params.base64Audio } },
    ],
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

export async function summarizeTranscript(params: {
  apiKeys: string[];
  transcript: string;
}): Promise<{ title: string; summary: string }> {
  const raw = await callGemini({
    apiKeys: params.apiKeys,
    temperature: 0.2,
    responseSchema: SUMMARY_SCHEMA,
    parts: [{ text: `${SUMMARY_PROMPT}\n\n---TRANSCRIPT---\n${params.transcript}` }],
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
