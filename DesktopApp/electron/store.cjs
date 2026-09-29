const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const EMPTY_SETTINGS = {
  apiKeys: [],
  driveUrl: '',
  driveSecret: '',
  taskNoteUrl: '',
};

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

async function ensureDataDirs() {
  await fs.mkdir(dataPath('recordings'), { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function loadSettings() {
  try {
    const encrypted = await fs.readFile(dataPath('settings.bin'));
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.');
    }
    return { ...EMPTY_SETTINGS, ...JSON.parse(safeStorage.decryptString(encrypted)) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...EMPTY_SETTINGS };
    throw error;
  }
}

async function saveSettings(settings) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is unavailable.');
  }
  const normalized = {
    apiKeys: Array.isArray(settings.apiKeys)
      ? settings.apiKeys
          .map((entry, index) => ({
            name: String(entry?.name || `Key ${index + 1}`).trim() || `Key ${index + 1}`,
            key: String(entry?.key || '').trim(),
          }))
          .filter((entry) => entry.key)
      : [],
    driveUrl: String(settings.driveUrl || '').trim(),
    driveSecret: String(settings.driveSecret || '').trim(),
    taskNoteUrl: String(settings.taskNoteUrl || '').trim(),
  };
  const encrypted = safeStorage.encryptString(JSON.stringify(normalized));
  await fs.writeFile(dataPath('settings.bin'), encrypted);
  return normalized;
}

async function listMeetings() {
  const rows = await readJson(dataPath('meetings.json'), []);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

async function saveMeetings(meetings) {
  await writeJson(dataPath('meetings.json'), meetings);
}

async function getMeeting(id) {
  return (await listMeetings()).find((meeting) => meeting.id === id) || null;
}

async function updateMeeting(id, fields) {
  const rows = await listMeetings();
  const index = rows.findIndex((meeting) => meeting.id === id);
  if (index < 0) throw new Error('Meeting not found.');
  rows[index] = { ...rows[index], ...fields };
  await saveMeetings(rows);
  return rows[index];
}

function safeExtension(originalName, mimeType) {
  const extension = path.extname(String(originalName || '')).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(extension)) return extension;
  if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a') return '.m4a';
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return '.mp3';
  if (mimeType === 'audio/wav') return '.wav';
  return '.webm';
}

async function createMeetingFromAudio({ bytes, mimeType, durationSec, originalName }) {
  await ensureDataDirs();
  const buffer = Buffer.from(bytes);
  const maxBytes = 30 * 1024 * 1024;
  if (!buffer.length) throw new Error('The recording is empty.');
  if (buffer.length > maxBytes) {
    throw new Error(`Audio is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, above the 30MB limit.`);
  }

  const id = randomUUID();
  const createdAt = Date.now();
  const extension = safeExtension(originalName, mimeType);
  const audioPath = dataPath(path.join('recordings', `${id}${extension}`));
  await fs.writeFile(audioPath, buffer);
  const title = `Meeting ${new Date(createdAt).toLocaleString()}`;
  const meeting = {
    id,
    title,
    createdAt,
    durationSec: Math.max(0, Math.round(Number(durationSec) || 0)),
    mimeType: String(mimeType || 'audio/webm'),
    audioPath,
    transcript: '',
    summary: '',
    audioUrl: null,
    transcriptUrl: null,
    folderUrl: null,
    taskNoteId: null,
    lastError: null,
    status: 'saved',
    timings: {},
  };
  const rows = await listMeetings();
  rows.unshift(meeting);
  await saveMeetings(rows);
  return meeting;
}

async function deleteMeeting(id) {
  const rows = await listMeetings();
  const target = rows.find((meeting) => meeting.id === id);
  if (!target) return;
  if (target.audioPath) {
    await fs.rm(target.audioPath, { force: true }).catch(() => undefined);
  }
  await saveMeetings(rows.filter((meeting) => meeting.id !== id));
}

module.exports = {
  EMPTY_SETTINGS,
  createMeetingFromAudio,
  deleteMeeting,
  getMeeting,
  listMeetings,
  loadSettings,
  saveSettings,
  updateMeeting,
};
