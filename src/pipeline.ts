import { Directory, File, Paths } from 'expo-file-system';

import { getMeeting, updateMeeting, type Meeting } from './db';
import { MAX_INLINE_AUDIO_BYTES } from './config';
import { uploadToDrive } from './drive';
import { summarizeTranscript, transcribeAudio } from './gemini';
import { RECORDING_MIME_TYPE } from './recording';
import type { Settings } from './settings';

export type PipelineStage = 'transcribing' | 'summarizing' | 'uploading' | 'done';

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
        apiKeys: settings.apiKeys,
        base64Audio: await file.base64(),
        mimeType: RECORDING_MIME_TYPE,
      });
      await updateMeeting(meeting.id, { transcript, lastError: null });
      meeting = { ...meeting, transcript };
    }

    // --- summary ----------------------------------------------------------
    if (!meeting.summary) {
      onStage?.('summarizing');
      try {
        const summary = await summarizeTranscript({
          apiKeys: settings.apiKeys,
          transcript: meeting.transcript,
        });
        await updateMeeting(meeting.id, { summary });
        meeting = { ...meeting, summary };
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
        mimeType: RECORDING_MIME_TYPE,
        fileName: meeting.title,
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

    onStage?.('done');
    return meeting;
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    await updateMeeting(params.meetingId, { lastError });
    throw err;
  }
}

/** True when there is unfinished work a retry could complete. */
export function needsRetry(meeting: Meeting): boolean {
  return !meeting.transcript || !meeting.folderUrl;
}
