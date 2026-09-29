const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchWithRetry } = require('./net.cjs');

async function verifyDriveUrl(driveUrl) {
  const response = await fetchWithRetry(driveUrl, {}, { timeoutMs: 30000 });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Drive returned HTML instead of JSON. Deploy the script for “Anyone”.');
  }
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
}

async function uploadToDrive({ settings, meeting }) {
  if (!meeting.audioPath) throw new Error('The local recording is missing.');
  const audio = await fs.readFile(meeting.audioPath);
  const form = new URLSearchParams({
    fileName: `${meeting.title}${path.extname(meeting.audioPath)}`,
    mimeType: meeting.mimeType,
    audioBase64: audio.toString('base64'),
    transcript: meeting.transcript,
  });
  if (meeting.summary) form.set('summary', meeting.summary);
  if (settings.driveSecret) form.set('secret', settings.driveSecret);

  const response = await fetchWithRetry(
    settings.driveUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    { timeoutMs: 12 * 60 * 1000 }
  );
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Drive returned a non-JSON response. Check the Apps Script deployment.');
  }
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function meetingsEndpoint(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (base.endsWith('/api/meetings')) return base;
  base = base.replace(/\/meetings$/, '');
  return `${base}/api/meetings`;
}

async function verifyTaskNoteUrl(baseUrl) {
  const meetings = meetingsEndpoint(baseUrl);
  const health = `${meetings.replace(/\/meetings$/, '')}/health`;
  const healthResponse = await fetchWithRetry(health, {}, { timeoutMs: 30000 }).catch(() => null);
  if (healthResponse?.ok) return;
  const response = await fetchWithRetry(meetings, {}, { timeoutMs: 30000 });
  if (response.status === 401 || response.status === 403) return;
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) throw new Error('This does not look like TaskNote.');
}

async function postToTaskNote({ settings, meeting }) {
  if (!settings.taskNoteUrl) return null;
  const response = await fetchWithRetry(
    meetingsEndpoint(settings.taskNoteUrl),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalId: `voicetotext-desktop-${meeting.id}`,
        // TaskNote validates this against the same ingest source used by the
        // mobile app. The desktop-specific value was rejected by deployments
        // with the current schema.
        source: 'voicetotext',
        title: meeting.title,
        startsAt: new Date(meeting.createdAt).toISOString(),
        durationMinutes: Math.min(1440, Math.max(1, Math.round(meeting.durationSec / 60) || 1)),
        transcript: meeting.transcript,
        summary: meeting.summary,
        folderUrl: meeting.folderUrl || '',
        audioUrl: meeting.audioUrl || '',
        transcriptUrl: meeting.transcriptUrl || '',
      }),
    },
    { timeoutMs: 60000 }
  );
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('TaskNote returned a non-JSON response. Check the URL.');
  }
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (!payload?.id) throw new Error('TaskNote did not return a meeting id.');
  return String(payload.id);
}

module.exports = {
  postToTaskNote,
  uploadToDrive,
  verifyDriveUrl,
  verifyTaskNoteUrl,
};
