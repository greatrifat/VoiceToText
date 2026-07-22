import { Directory, File, Paths } from 'expo-file-system';

import { getMeeting, updateMeeting, type Meeting } from './db';
import { MAX_INLINE_AUDIO_BYTES } from './config';
import { extensionOf, mimeForPath } from './audioFile';
import { uploadToDrive } from './drive';
import { summarizeTranscript, transcribeAudio } from './gemini';
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

      onStage?.('transcribing');
      const transcript = await transcribeAudio({
        apiKeys: apiKeyValues(settings),
        base64Audio: await file.base64(),
        // Derived from the file rather than assumed: an imported meeting may be
        // mp3 or wav, and Gemini rejects a type that disagrees with the bytes.
        mimeType: mimeForPath(meeting.audioPath),
        durationSec: meeting.durationSec,
      });
      await updateMeeting(meeting.id, { transcript, lastError: null });
      meeting = { ...meeting, transcript };
    }

    // --- summary (and title) ----------------------------------------------
    // Runs before the upload on purpose: the Drive folder and the TaskNote post
    // are both named after `meeting.title`, so the real title has to be in place
    // by then or those copies keep the clock-stamped placeholder forever.
    if (!meeting.summary) {
      onStage?.('summarizing');
      try {
        const result = await summarizeTranscript({
          apiKeys: apiKeyValues(settings),
          transcript: meeting.transcript,
        });
        const fields: Partial<Meeting> = { summary: result.summary };
        if (result.title && isPlaceholderTitle(meeting.title)) fields.title = result.title;
        await updateMeeting(meeting.id, fields);
        meeting = { ...meeting, ...fields };
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
      const result = await uploadToDrive({
        driveUrl: settings.driveUrl,
        driveSecret: settings.driveSecret,
        base64Audio: await file.base64(),
        mimeType: mimeForPath(meeting.audioPath),
        // Carries the real extension so Drive stores an mp3 as .mp3 rather than
        // mislabelling it .m4a, which would leave it unplayable in the browser.
        fileName: `${meeting.title}.${extensionOf(meeting.audioPath)}`,
        transcript: meeting.transcript,
        summary: meeting.summary,
      });

      // Drive now holds the audio, so the local copy has done its job.
      discardLocalAudio(meeting.audioPath);
      await updateMeeting(meeting.id, {
        audioUrl: result.audioUrl,
        transcriptUrl: result.transcriptUrl,
        folderUrl: result.folderUrl,
        audioPath: null,
        lastError: null,
      });
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
