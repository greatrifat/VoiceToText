const fs = require('node:fs/promises');
const { fetchWithRetry } = require('./net.cjs');

const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

const TEXT_TIMEOUT_MS = 2 * 60 * 1000;
const FILES_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: { title: { type: 'STRING' }, summary: { type: 'STRING' } },
  required: ['title', 'summary'],
};

const TRANSCRIBE_PROMPT = `Transcribe this meeting verbatim in the language spoken. Return one JSON item per speaking turn.
Each item must contain startSeconds (whole seconds from the beginning), speaker (1 for the first distinct voice, 2 for the next, and so on), and text (exactly what was said in the original language).
Keep each speaker number attached to the same voice. Split on every speaker change, including short interjections. Split turns longer than about 30 seconds at a sentence boundary. Do not summarize, translate, or comment. Write [inaudible] for unclear speech.`;

const SUMMARY_PROMPT = `Create a concise title and a faithful structured summary of the meeting transcript.
Preserve the transcript's primary language and keep technical terms, product names, APIs, code identifiers, error codes, and English jargon exactly as spoken. Do not invent decisions, owners, or deadlines.
The title must be 3-8 words, sentence case, and have no date, time, trailing punctuation, or the word "Meeting".
The summary must be plain text with these exact sections separated by blank lines:
OVERVIEW
2-3 sentences.

KEY POINTS
Bullets for substantive points.

DECISIONS
Bullets for explicit decisions, or exactly "None recorded".

ACTION ITEMS
Bullets formatted as "owner - task - deadline", or exactly "None recorded".`;

class GeminiFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function classify(status, message, details) {
  const text = String(message || '');
  const quotaText = JSON.stringify(details || {});
  if (status === 429) {
    const daily = /per day|daily|requests per day|RPD|GenerateRequestsPerDay/i.test(`${text} ${quotaText}`);
    return new GeminiFailure(daily ? 'quota' : 'rate-limit', text || `HTTP ${status}`);
  }
  if (status === 404) return new GeminiFailure('unavailable', text || `HTTP ${status}`);
  if (status >= 500 || /high demand|overloaded|try again later/i.test(text)) {
    return new GeminiFailure('busy', text || `HTTP ${status}`);
  }
  if (status === 401 || status === 403 || /api key not valid|invalid api key|permission denied/i.test(text)) {
    return new GeminiFailure('rejected', text || `HTTP ${status}`);
  }
  return status >= 400 ? new GeminiFailure('error', text || `HTTP ${status}`) : null;
}

function thinkingConfig(model) {
  if (/^gemini-3\.(8|7)-flash$/.test(model)) return { thinkingLevel: 'low' };
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'minimal' };
  return null;
}

function transcribeTimeout(durationSec) {
  if (!durationSec) return 20 * 60 * 1000;
  return Math.min(20 * 60 * 1000, Math.round(90_000 + (durationSec / 60) * 20_000));
}

function uploadTimeout(sizeBytes) {
  return Math.min(12 * 60 * 1000, Math.round(60_000 + (sizeBytes / 1024 / 1024) * 30_000));
}

async function parseError(response) {
  const payload = await response.json().catch(() => null);
  return classify(response.status, payload?.error?.message, payload?.error) ||
    new Error(`Gemini request failed: HTTP ${response.status}`);
}

async function uploadAudio({ apiKey, audioPath, mimeType, onProgress }) {
  const stat = await fs.stat(audioPath);
  const sizeBytes = stat.size;
  onProgress?.(0, sizeBytes);
  const start = await fetchWithRetry(
    FILES_URL,
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
      body: JSON.stringify({ file: { display_name: 'desktop-recording' } }),
    },
    { timeoutMs: TEXT_TIMEOUT_MS }
  );
  if (!start.ok) throw await parseError(start);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini Files API did not return an upload URL.');

  const buffer = await fs.readFile(audioPath);
  const response = await fetchWithRetry(
    uploadUrl,
    {
      method: 'PUT',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Type': mimeType,
      },
      body: buffer,
    },
    { attempts: 1, timeoutMs: uploadTimeout(sizeBytes) }
  );
  if (!response.ok) throw await parseError(response);
  onProgress?.(sizeBytes, sizeBytes);
  let file = (await response.json().catch(() => null))?.file;
  if (!file) throw new Error('Gemini Files API returned invalid file metadata.');

  const deadline = Date.now() + TEXT_TIMEOUT_MS;
  while (file.state === 'PROCESSING') {
    if (Date.now() >= deadline) throw new Error('Gemini audio processing timed out.');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await fetchWithRetry(`${API_URL}/${file.name}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!poll.ok) throw await parseError(poll);
    file = (await poll.json().catch(() => null))?.file;
  }
  if (file?.state !== 'ACTIVE' || !file?.uri) {
    throw new Error(`Gemini file did not become active (${file?.state || 'unknown'}).`);
  }
  return file.uri;
}

async function callOnce({ apiKey, model, parts, temperature, responseSchema, timeoutMs }) {
  const thinking = thinkingConfig(model);
  const response = await fetchWithRetry(
    `${API_URL}/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature,
          ...(thinking ? { thinkingConfig: thinking } : {}),
          ...(responseSchema
            ? { responseMimeType: 'application/json', responseSchema }
            : {}),
        },
      }),
    },
    { timeoutMs: timeoutMs || TEXT_TIMEOUT_MS }
  );
  if (!response.ok) throw await parseError(response);
  const payload = await response.json().catch(() => null);
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

async function callGemini({ apiKeys, parts, temperature, responseSchema, timeoutMs, audio, onAttempt }) {
  const keys = apiKeys.map((key) => String(key).trim()).filter(Boolean);
  if (!keys.length) throw new Error('No Gemini API key configured. Add one in Settings.');
  const uploadedByKey = new Map();
  const deadKeys = new Set();
  let lastError = null;

  for (const model of MODELS) {
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const apiKey = keys[keyIndex];
      if (deadKeys.has(apiKey)) continue;
      const info = { model, keyNumber: keyIndex + 1, keyCount: keys.length };
      try {
        let actualParts = parts;
        if (audio) {
          let uri = uploadedByKey.get(apiKey);
          if (!uri) {
            onAttempt?.({ ...info, outcome: 'uploading' });
            uri = await uploadAudio({
              apiKey,
              audioPath: audio.audioPath,
              mimeType: audio.mimeType,
              onProgress: (sentBytes, totalBytes) =>
                onAttempt?.({ ...info, outcome: 'uploading', sentBytes, totalBytes }),
            });
            uploadedByKey.set(apiKey, uri);
          }
          actualParts = [...parts, { file_data: { mime_type: audio.mimeType, file_uri: uri } }];
        }
        onAttempt?.({ ...info, outcome: 'trying' });
        const text = await callOnce({
          apiKey,
          model,
          parts: actualParts,
          temperature,
          responseSchema,
          timeoutMs,
        });
        onAttempt?.({ ...info, outcome: 'ok' });
        return text;
      } catch (error) {
        lastError = error;
        const kind = error instanceof GeminiFailure ? error.kind : 'error';
        onAttempt?.({ ...info, outcome: kind, message: error.message });
        if (kind === 'rejected') deadKeys.add(apiKey);
        if (kind === 'busy') break;
        if (!['quota', 'rate-limit', 'unavailable', 'rejected', 'busy'].includes(kind)) throw error;
      }
    }
  }

  if (deadKeys.size === keys.length) {
    throw new Error('Every Gemini API key was rejected. Check the keys in Settings.');
  }
  throw new Error(`No Gemini model succeeded. ${lastError?.message || 'All fallbacks were exhausted.'}`);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${String(hours).padStart(2, '0')}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

function renderSegments(segments, durationSec) {
  const last = Math.max(...segments.map((item) => Number(item.startSeconds) || 0), 0);
  const scale = durationSec > 0 && last > durationSec * 1.05 ? (durationSec * 0.98) / last : 1;
  return segments
    .filter((item) => String(item?.text || '').trim())
    .map((item) =>
      `[${formatClock((Number(item.startSeconds) || 0) * scale)}] Speaker ${Number(item.speaker) || 1}: ${String(item.text).trim()}`
    )
    .join('\n');
}

async function transcribeAudio({ apiKeys, audioPath, mimeType, durationSec, onAttempt }) {
  const raw = await callGemini({
    apiKeys,
    parts: [{ text: TRANSCRIBE_PROMPT }],
    temperature: 0,
    responseSchema: TRANSCRIPT_SCHEMA,
    timeoutMs: transcribeTimeout(durationSec),
    audio: { audioPath, mimeType },
    onAttempt,
  });
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? renderSegments(parsed, durationSec) : raw;
  } catch {
    return raw;
  }
}

function sanitizeTitle(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '')
    .slice(0, 80)
    .trim();
}

async function summarizeTranscript({ apiKeys, transcript, onAttempt }) {
  const raw = await callGemini({
    apiKeys,
    parts: [{ text: `${SUMMARY_PROMPT}\n\n---TRANSCRIPT---\n${transcript}\n---END TRANSCRIPT---` }],
    temperature: 0,
    responseSchema: SUMMARY_SCHEMA,
    onAttempt,
  });
  try {
    const parsed = JSON.parse(raw);
    return { title: sanitizeTitle(parsed?.title), summary: String(parsed?.summary || '').trim() };
  } catch {
    return { title: '', summary: raw.trim() };
  }
}

async function askAboutTranscript({ apiKeys, transcript, question, onAttempt }) {
  return callGemini({
    apiKeys,
    temperature: 0.2,
    onAttempt,
    parts: [{
      text: `Answer only from this transcript. If the answer is absent, say so. Cite relevant timestamps. Answer in the question's language.\n\n---TRANSCRIPT---\n${transcript}\n---END TRANSCRIPT---\n\nQUESTION: ${question}`,
    }],
  });
}

async function verifyApiKey(apiKey) {
  const response = await fetchWithRetry(`${API_URL}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': String(apiKey).trim() },
  }, { timeoutMs: 30000 });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json();
  return (payload.models || [])
    .filter((model) => (model.supportedGenerationMethods || []).includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//, ''))
    .filter((name) => /gemini.*flash/i.test(name));
}

module.exports = {
  MODELS,
  askAboutTranscript,
  summarizeTranscript,
  transcribeAudio,
  verifyApiKey,
};
