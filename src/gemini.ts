import { GEMINI_MODEL } from './config';
import { recordUsage } from './db';

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const TRANSCRIBE_PROMPT = [
  'This is a recording of a meeting. Transcribe it verbatim in the language spoken.',
  'Separate speakers as "Speaker 1:", "Speaker 2:" and so on when you can tell them apart.',
  'Put each speaker turn on its own line. Do not summarise, comment, or add anything',
  'that was not said. If a stretch is inaudible, write [inaudible].',
].join(' ');

const SUMMARY_PROMPT = [
  'Below is a meeting transcript. Write a summary in the same language as the transcript,',
  'using these sections and nothing else:',
  '',
  'OVERVIEW — two or three sentences on what the meeting was about.',
  'KEY POINTS — bullets of the substantive things discussed.',
  'DECISIONS — bullets of what was actually decided. Write "None recorded" if nothing was.',
  'ACTION ITEMS — bullets as "owner — task — deadline". Use "unassigned" or "no deadline"',
  'where the transcript does not say. Write "None recorded" if there are none.',
  '',
  'Base every line strictly on the transcript. Do not infer decisions or owners that were',
  'not stated. Plain text only, no markdown symbols.',
].join('\n');

/** Raised only for 429 / RESOURCE_EXHAUSTED, the one case worth another key. */
class QuotaError extends Error {}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

/**
 * Tries each key in order, moving on only when one is out of quota.
 *
 * Note this helps only when the keys belong to different Google accounts —
 * quota is enforced per project, so several keys from one account share a
 * single pool and will all fail together.
 */
async function callGemini(params: {
  apiKeys: string[];
  parts: Part[];
  temperature: number;
  disableThinking?: boolean;
}): Promise<string> {
  const keys = params.apiKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('No Gemini API key configured. Add one in Settings.');
  }

  let exhausted = 0;
  for (const apiKey of keys) {
    try {
      return await callOnce({ ...params, apiKey });
    } catch (err) {
      if (err instanceof QuotaError) {
        exhausted += 1;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    exhausted === keys.length && keys.length > 1
      ? `All ${keys.length} API keys are out of quota. If they belong to the same Google account they share one limit — add a key from a different account.`
      : 'API key is out of quota. Try again later or add another key in Settings.'
  );
}

async function callOnce(params: {
  apiKey: string;
  parts: Part[];
  temperature: number;
  disableThinking?: boolean;
}): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': params.apiKey },
    body: JSON.stringify({
      contents: [{ parts: params.parts }],
      generationConfig: {
        temperature: params.temperature,
        ...(params.disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  });

  const payload = await response.json().catch(() => null);

  if (response.status === 429) {
    throw new QuotaError(payload?.error?.message ?? 'Quota exceeded');
  }
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${payload?.error?.message ?? `HTTP ${response.status}`}`);
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
}): Promise<string> {
  return callGemini({
    apiKeys: params.apiKeys,
    temperature: 0,
    disableThinking: true,
    parts: [
      { text: TRANSCRIBE_PROMPT },
      { inline_data: { mime_type: params.mimeType, data: params.base64Audio } },
    ],
  });
}

export async function summarizeTranscript(params: {
  apiKeys: string[];
  transcript: string;
}): Promise<string> {
  return callGemini({
    apiKeys: params.apiKeys,
    temperature: 0.2,
    parts: [{ text: `${SUMMARY_PROMPT}\n\n---TRANSCRIPT---\n${params.transcript}` }],
  });
}

export async function askAboutTranscript(params: {
  apiKeys: string[];
  transcript: string;
  question: string;
}): Promise<string> {
  const prompt = [
    'Answer the question using only the meeting transcript below.',
    'If the transcript does not contain the answer, say so plainly rather than guessing.',
    'Quote the relevant line when it helps. Answer in the language of the question.',
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
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }
}
