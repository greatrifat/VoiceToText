const fs = require('node:fs/promises');
const store = require('./store.cjs');
const gemini = require('./gemini.cjs');
const integrations = require('./integrations.cjs');

const inFlight = new Set();

function emitSafely(emit, event) {
  try { emit?.(event); } catch { /* window may have closed */ }
}

function attemptEmitter(meetingId, stage, emit) {
  return (attempt) => emitSafely(emit, { meetingId, stage, ...attempt });
}

async function processMeeting(id, emit) {
  if (inFlight.has(id)) return store.getMeeting(id);
  inFlight.add(id);
  try {
    const settings = await store.loadSettings();
    const apiKeys = settings.apiKeys.map((entry) => entry.key).filter(Boolean);
    if (!apiKeys.length) throw new Error('Add at least one Gemini API key in Settings.');
    if (!settings.driveUrl) throw new Error('Add the Google Drive Apps Script URL in Settings.');

    let meeting = await store.getMeeting(id);
    if (!meeting) throw new Error('Meeting not found.');

    if (!meeting.transcript) {
      if (!meeting.audioPath) throw new Error('The local recording is missing.');
      emitSafely(emit, { meetingId: id, stage: 'transcribing', message: 'Transcribing audio' });
      meeting = await store.updateMeeting(id, { status: 'transcribing', lastError: null });
      const started = Date.now();
      const transcript = await gemini.transcribeAudio({
        apiKeys,
        audioPath: meeting.audioPath,
        mimeType: meeting.mimeType,
        durationSec: meeting.durationSec,
        onAttempt: attemptEmitter(id, 'transcribing', emit),
      });
      meeting = await store.updateMeeting(id, {
        transcript,
        timings: { ...meeting.timings, transcribeMs: Date.now() - started },
      });
    }

    if (!meeting.summary) {
      emitSafely(emit, { meetingId: id, stage: 'summarizing', message: 'Creating summary' });
      meeting = await store.updateMeeting(id, { status: 'summarizing' });
      const started = Date.now();
      try {
        const result = await gemini.summarizeTranscript({
          apiKeys,
          transcript: meeting.transcript,
          onAttempt: attemptEmitter(id, 'summarizing', emit),
        });
        meeting = await store.updateMeeting(id, {
          title: result.title || meeting.title,
          summary: result.summary,
          timings: { ...meeting.timings, summaryMs: Date.now() - started },
        });
      } catch (error) {
        emitSafely(emit, { meetingId: id, stage: 'summarizing', outcome: 'warning', message: error.message });
      }
    }

    if (!meeting.audioUrl || !meeting.transcriptUrl) {
      emitSafely(emit, { meetingId: id, stage: 'uploading', message: 'Saving to Google Drive' });
      meeting = await store.updateMeeting(id, { status: 'uploading' });
      const started = Date.now();
      const result = await integrations.uploadToDrive({ settings, meeting });
      meeting = await store.updateMeeting(id, {
        audioUrl: result.audioUrl || result.audioFileUrl || null,
        transcriptUrl: result.transcriptUrl || result.transcriptFileUrl || null,
        folderUrl: result.folderUrl || null,
        timings: { ...meeting.timings, uploadMs: Date.now() - started },
      });
      if (meeting.audioPath) {
        await fs.rm(meeting.audioPath, { force: true }).catch(() => undefined);
        meeting = await store.updateMeeting(id, { audioPath: null });
      }
    }

    let taskNoteError = null;
    if (settings.taskNoteUrl && !meeting.taskNoteId) {
      emitSafely(emit, { meetingId: id, stage: 'posting', message: 'Sending to TaskNote' });
      meeting = await store.updateMeeting(id, { status: 'posting' });
      try {
        const taskNoteId = await integrations.postToTaskNote({ settings, meeting });
        meeting = await store.updateMeeting(id, { taskNoteId, lastError: null });
      } catch (error) {
        taskNoteError = `TaskNote: ${error instanceof Error ? error.message : String(error)}`;
        meeting = await store.updateMeeting(id, { lastError: taskNoteError });
        emitSafely(emit, { meetingId: id, stage: 'posting', outcome: 'warning', message: taskNoteError });
      }
    }

    meeting = await store.updateMeeting(id, {
      status: 'done',
      // A TaskNote failure is non-destructive—the transcript and Drive copy are
      // safe—but must remain visible so the TaskNote-only retry can run later.
      lastError: taskNoteError,
    });
    emitSafely(emit, {
      meetingId: id,
      stage: 'done',
      outcome: taskNoteError ? 'warning' : 'ok',
      message: taskNoteError ? 'Saved; TaskNote needs retry' : 'Meeting is ready',
    });
    return meeting;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateMeeting(id, { status: 'error', lastError: message }).catch(() => undefined);
    emitSafely(emit, { meetingId: id, stage: 'error', message });
    throw error;
  } finally {
    inFlight.delete(id);
  }
}

async function askMeeting(id, question, emit) {
  const meeting = await store.getMeeting(id);
  if (!meeting?.transcript) throw new Error('This meeting has no transcript yet.');
  const settings = await store.loadSettings();
  return gemini.askAboutTranscript({
    apiKeys: settings.apiKeys.map((entry) => entry.key),
    transcript: meeting.transcript,
    question: String(question || '').trim(),
    onAttempt: attemptEmitter(id, 'asking', emit),
  });
}

module.exports = {
  askMeeting,
  isProcessing: (id) => inFlight.has(id),
  processMeeting,
};
