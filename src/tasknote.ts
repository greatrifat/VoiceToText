/**
 * Posts a finished meeting to a TaskNote instance so the transcript, summary
 * and Drive folder link are visible from the web app as well as the phone.
 *
 * TaskNote is a separate deployment the user points the app at, so the base URL
 * is a setting rather than a constant. A blank setting disables this entirely —
 * the recorder still works without TaskNote.
 */
import { fetchWithRetry } from './net';


/**
 * Normalises whatever the user pasted into the real endpoint. The obvious thing
 * to copy from a browser is the meetings *page* (`/meetings`), which would
 * otherwise become `/meetings/api/meetings` and 404, so that suffix is stripped.
 */
function meetingsEndpoint(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/api/meetings')) return base;
  base = base.replace(/\/meetings$/, '');
  return `${base}/api/meetings`;
}

/**
 * TaskNote requires a whole number of minutes between 1 and 1440. A 20-second
 * recording is still a meeting, so round up rather than rejecting it.
 */
function toDurationMinutes(durationSec: number): number {
  return Math.min(1440, Math.max(1, Math.round(durationSec / 60) || 1));
}

export async function postMeetingToTaskNote(params: {
  taskNoteUrl: string;
  /** Stable per-device id; TaskNote upserts on it so a retry cannot duplicate. */
  externalId: string;
  title: string;
  createdAt: number;
  durationSec: number;
  transcript: string;
  summary: string;
  folderUrl: string | null;
  audioUrl: string | null;
  transcriptUrl: string | null;
}): Promise<{ id: string }> {
  const response = await fetchWithRetry(meetingsEndpoint(params.taskNoteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      externalId: params.externalId,
      source: 'voicetotext',
      title: params.title,
      // The recording start is the only time we know; TaskNote requires one.
      startsAt: new Date(params.createdAt).toISOString(),
      durationMinutes: toDurationMinutes(params.durationSec),
      transcript: params.transcript,
      summary: params.summary,
      folderUrl: params.folderUrl ?? '',
      audioUrl: params.audioUrl ?? '',
      transcriptUrl: params.transcriptUrl ?? '',
    }),
  });

  const raw = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A wrong host or a Next.js error page answers with HTML, often on a 200.
    throw new Error('TaskNote returned a non-JSON response — check the URL.');
  }

  if (!response.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  if (!payload?.id) {
    throw new Error('TaskNote did not return a meeting id.');
  }

  return { id: String(payload.id) };
}

/**
 * Cheap GET used by the Settings screen to check a pasted TaskNote URL.
 *
 * Tries the public health endpoint first. Older TaskNote deployments do not
 * have one, so a 404 falls back to listing meetings — and a password-protected
 * instance answers that with 401, which is a *pass*: the URL is right, the
 * server is up, and posting a meeting still works because ingest is exempt from
 * the gate. Treating that as failure told the user their working setup was
 * broken.
 */
export async function verifyTaskNoteUrl(taskNoteUrl: string): Promise<void> {
  const meetings = meetingsEndpoint(taskNoteUrl);
  const health = `${meetings.replace(/\/meetings$/, '')}/health`;

  const healthResponse = await fetchWithRetry(health).catch(() => null);
  if (healthResponse?.ok) {
    const payload = await healthResponse.json().catch(() => null);
    if (payload?.ok) return;
    throw new Error('Unexpected response — this does not look like TaskNote.');
  }

  const response = await fetchWithRetry(meetings);
  if (response.status === 401 || response.status === 403) return;

  const raw = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Not a JSON response — check the URL points at TaskNote.');
  }
  if (!response.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error('Unexpected response — this does not look like TaskNote.');
  }
}
