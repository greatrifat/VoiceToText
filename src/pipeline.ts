import { Directory, File, Paths } from 'expo-file-system';

import { getMeeting, updateMeeting, type Meeting } from './db';
import { MAX_INLINE_AUDIO_BYTES } from './config';
import { extensionOf, mimeForPath } from './audioFile';
import { uploadToDrive } from './drive';
import { onGeminiAttempt, summarizeTranscript, transcribeAudio } from './gemini';
import { apiKeyValues, type Settings } from './settings';
import { postMeetingToTaskNote } from './tasknote';

export type PipelineStage =
  | 'transcribing'
  | 'summarizing'
  | 'uploading'
  | 'posting'
  | 'done';

const RECORDINGS_DIR = 'recordings';

/**
 * Per-stage timing, persisted on the meeting so the numbers are readable on the
 * device itself — a sideloaded release build has no Metro console to look at.
 * Every field optional because a retry fills in only the stages it re-ran; the
 * object is merged onto whatever a previous pass already recorded.
 */
/** One line of the model-walk log: what a single attempt did and how long it took. */
export type AttemptLogRow = { model: string; key: number; outcome: string; ms: number };

export type Timings = {
  durationSec?: number;
  audioBytes?: number;
  /** Reading the file off disk and base64-encoding it, before any network. */
  base64Ms?: number;
  transcribeMs?: number;
  /** Which of the fallback models actually answered, and after how many tries. */
  transcribeModel?: string | null;
  transcribeAttempts?: number;
  /** Per-attempt walk log, so a slow stage shows where its seconds went. */
  transcribeLog?: AttemptLogRow[];
  summaryMs?: number;
  summaryModel?: string | null;
  summaryLog?: AttemptLogRow[];
  uploadMs?: number;
  postMs?: number;
  /** When this timing was last written, so a stale run is obvious. */
  updatedAt?: number;
};

/** Times one awaited operation without changing what it returns. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const result = await fn();
  return [result, Date.now() - t0];
}

function parseTimings(raw: string | null): Timings {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Timings;
  } catch {
    return {};
  }
}

/**
 * Runs `fn` while listening to the Gemini fallback walk, so the timing can
 * record which model answered and how many attempts it cost. The walk is
 * sequential within a pipeline, so a single global listener cannot cross wires
 * between two overlapping calls.
 */
async function withAttemptCapture<T>(
  fn: () => Promise<T>
): Promise<[T, { model: string | null; attempts: number; log: AttemptLogRow[] }]> {
  let model: string | null = null;
  let attempts = 0;
  const log: AttemptLogRow[] = [];
  const unsub = onGeminiAttempt((a) => {
    if (a.outcome === 'trying') attempts += 1;
    else if (a.outcome === 'ok') model = a.model;
    // Terminal events carry `ms`; each becomes one line of the walk log.
    if (a.ms != null) log.push({ model: a.model, key: a.keyNumber, outcome: a.outcome, ms: a.ms });
  });
  try {
    const result = await fn();
    return [result, { model, attempts, log }];
  } finally {
    unsub();
  }
}

/**
 * Moves a just-finished recording out of the cache directory, which the OS is
 * free to purge, into document storage where it survives until we no longer
 * need it. Without this a failed transcription loses the audio outright.
 */
export async function persistRecording(cacheUri: string, id: string): Promise<string> {
  const dir = new Directory(Paths.document, RECORDINGS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });

  const source = new File(cacheUri);
  const destination = new File(dir, `${id}.m4a`);
  await source.move(destination);
  return destination.uri;
}

/**
 * A recording starts out named after the clock, e.g. "Meeting 2026-07-21 08:33".
 * That is a placeholder to be replaced once we know what the meeting was about;
 * anything the user has since typed themselves is a decision, and is kept.
 *
 * Anchored to the exact generated shape, so a title someone wrote that merely
 * begins with the word "Meeting" is left alone.
 */
function isPlaceholderTitle(title: string): boolean {
  const value = title.trim();
  if (!value) return true;
  return /^meeting\s*\d[\d\s:/.-]*$/i.test(value);
}

/** Removes the local copy once Drive holds it; ignores an already-gone file. */
function discardLocalAudio(path: string | null): void {
  if (!path) return;
  try {
    const file = new File(path);
    if (file.exists) file.delete();
  } catch {
    // A leftover file is harmless; failing here would be worse.
  }
}

/**
 * Runs only the stages a meeting still needs, so this doubles as the retry
 * path: a meeting that transcribed but failed to upload re-uploads without
 * paying for transcription again.
 */
export async function processMeeting(params: {
  meetingId: number;
  settings: Settings;
  onStage?: (stage: PipelineStage) => void;
}): Promise<Meeting> {
  const { settings, onStage } = params;

  let meeting = await getMeeting(params.meetingId);
  if (!meeting) throw new Error('Meeting not found.');

  // Merged onto whatever a previous pass recorded, then written after each stage.
  // Keyed off params.meetingId, not `meeting`, so this closure does not capture a
  // reassigned local — which would cost `meeting` its non-null narrowing below.
  const timings = parseTimings(meeting.timings);
  timings.durationSec = meeting.durationSec;
  const saveTimings = async () => {
    timings.updatedAt = Date.now();
    await updateMeeting(params.meetingId, { timings: JSON.stringify(timings) });
  };

  try {
    // --- transcript -------------------------------------------------------
    if (!meeting.transcript) {
      if (!meeting.audioPath) {
        throw new Error('The audio for this meeting is no longer on the device.');
      }
      const file = new File(meeting.audioPath);
      if (!file.exists) {
        throw new Error('The audio file is missing from storage.');
      }
      if (file.size && file.size > MAX_INLINE_AUDIO_BYTES) {
        throw new Error(
          `Recording is ${(file.size / 1024 / 1024).toFixed(1)}MB, above the ` +
            `${MAX_INLINE_AUDIO_BYTES / 1024 / 1024}MB limit.`
        );
      }
      timings.audioBytes = file.size ?? undefined;
      // Persisted before the call, not just after: a transcription that stalls
      // and is then killed used to leave no trace at all. Now History at least
      // shows it was attempted, with the size and length.
      await saveTimings();

      onStage?.('transcribing');
      // Bound as consts before the closure so `meeting` (a reassigned `let`)
      // keeps its non-null narrowing for the rest of the function.
      const audioPath = meeting.audioPath;
      // Derived from the file rather than assumed: an imported meeting may be
      // mp3 or wav, and Gemini rejects a type that disagrees with the bytes.
      const audioMime = mimeForPath(audioPath);
      const durationSec = meeting.durationSec;
      const sizeBytes = file.size ?? 0;
      const [transcript, transcribeMs] = await timed(() =>
        withAttemptCapture(() =>
          transcribeAudio({
            apiKeys: apiKeyValues(settings),
            // Uploaded to the Files API once per key and streamed from disk —
            // no base64 in memory, no re-upload on every fallback attempt.
            audioPath,
            mimeType: audioMime,
            sizeBytes,
            durationSec,
          })
        )
      );
      const [text, attempt] = transcript;
      timings.transcribeMs = transcribeMs;
      timings.transcribeModel = attempt.model;
      timings.transcribeAttempts = attempt.attempts;
      timings.transcribeLog = attempt.log;
      console.log(
        `[timing] transcribe ${transcribeMs}ms ` +
          `via ${attempt.model ?? '?'} (${attempt.attempts} attempt(s))`
      );

      await updateMeeting(meeting.id, { transcript: text, lastError: null });
      meeting = { ...meeting, transcript: text };
      await saveTimings();
    }

    // --- summary (and title) ----------------------------------------------
    // Runs before the upload on purpose: the Drive folder and the TaskNote post
    // are both named after `meeting.title`, so the real title has to be in place
    // by then or those copies keep the clock-stamped placeholder forever.
    if (!meeting.summary) {
      onStage?.('summarizing');
      try {
        const summaryTranscript = meeting.transcript;
        const [summaryResult, summaryMs] = await timed(() =>
          withAttemptCapture(() =>
            summarizeTranscript({
              apiKeys: apiKeyValues(settings),
              transcript: summaryTranscript,
            })
          )
        );
        const [result, summaryAttempt] = summaryResult;
        timings.summaryMs = summaryMs;
        timings.summaryModel = summaryAttempt.model;
        timings.summaryLog = summaryAttempt.log;
        console.log(
          `[timing] summary ${summaryMs}ms via ${summaryAttempt.model ?? '?'} ` +
            `(${summaryAttempt.attempts} attempt(s))`
        );
        const fields: Partial<Meeting> = { summary: result.summary };
        if (result.title && isPlaceholderTitle(meeting.title)) fields.title = result.title;
        await updateMeeting(meeting.id, fields);
        meeting = { ...meeting, ...fields };
        await saveTimings();
      } catch {
        // Non-fatal: recoverable later, and never worth blocking the upload.
      }
    }

    // --- Drive ------------------------------------------------------------
    if (!meeting.folderUrl) {
      if (!meeting.audioPath) {
        throw new Error('The audio for this meeting is no longer on the device.');
      }
      const file = new File(meeting.audioPath);
      if (!file.exists) {
        throw new Error('The audio file is missing from storage.');
      }

      onStage?.('uploading');
      const uploadBase64 = await file.base64();
      const uploadArgs = {
        driveUrl: settings.driveUrl,
        driveSecret: settings.driveSecret,
        base64Audio: uploadBase64,
        mimeType: mimeForPath(meeting.audioPath),
        // Carries the real extension so Drive stores an mp3 as .mp3 rather than
        // mislabelling it .m4a, which would leave it unplayable in the browser.
        fileName: `${meeting.title}.${extensionOf(meeting.audioPath)}`,
        transcript: meeting.transcript,
        summary: meeting.summary,
      };
      const [result, uploadMs] = await timed(() => uploadToDrive(uploadArgs));
      timings.uploadMs = uploadMs;
      console.log(`[timing] upload ${uploadMs}ms`);

      // Drive now holds the audio, so the local copy has done its job.
      discardLocalAudio(meeting.audioPath);
      await updateMeeting(meeting.id, {
        audioUrl: result.audioUrl,
        transcriptUrl: result.transcriptUrl,
        folderUrl: result.folderUrl,
        audioPath: null,
        lastError: null,
      });
      await saveTimings();
      meeting = {
        ...meeting,
        audioUrl: result.audioUrl,
        transcriptUrl: result.transcriptUrl,
        folderUrl: result.folderUrl,
        audioPath: null,
        lastError: null,
      };
    }

    // --- TaskNote ---------------------------------------------------------
    // Last, because it forwards the folder link the Drive stage produced. Only
    // when configured, and wrapped in its own try/catch: TaskNote is a mirror
    // of work that has already succeeded, so an unreachable server must not
    // turn a saved meeting into a failed one. Retrying from History re-posts.
    if (settings.taskNoteUrl.trim() && !meeting.taskNoteId) {
      onStage?.('posting');
      try {
        const posted = await postMeetingToTaskNote({
          taskNoteUrl: settings.taskNoteUrl,
          externalId: `voicetotext-${meeting.createdAt}`,
          title: meeting.title,
          createdAt: meeting.createdAt,
          durationSec: meeting.durationSec,
          transcript: meeting.transcript,
          summary: meeting.summary,
          folderUrl: meeting.folderUrl,
          audioUrl: meeting.audioUrl,
          transcriptUrl: meeting.transcriptUrl,
        });
        await updateMeeting(meeting.id, { taskNoteId: posted.id });
        meeting = { ...meeting, taskNoteId: posted.id };
      } catch (err) {
        const lastError = `TaskNote: ${err instanceof Error ? err.message : String(err)}`;
        await updateMeeting(meeting.id, { lastError });
        meeting = { ...meeting, lastError };
      }
    }

    onStage?.('done');
    return meeting;
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    await updateMeeting(params.meetingId, { lastError });
    throw err;
  }
}

/**
 * True when there is unfinished work a retry could complete. `settings` is
 * optional because the TaskNote post is only outstanding when one is
 * configured — without it, a meeting with no `taskNoteId` is simply finished.
 */
export function needsRetry(meeting: Meeting, settings?: Settings): boolean {
  if (!meeting.transcript || !meeting.folderUrl) return true;
  return Boolean(settings?.taskNoteUrl.trim()) && !meeting.taskNoteId;
}

/**
 * Whether a retry can actually run. The Drive and transcript stages need the
 * audio; a TaskNote-only retry does not, since everything it sends is already
 * in the database.
 */
export function canRetry(meeting: Meeting): boolean {
  if (!meeting.transcript || !meeting.folderUrl) return Boolean(meeting.audioPath);
  return true;
}
