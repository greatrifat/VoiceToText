/**
 * Importing an existing audio file so it runs through the same pipeline as a
 * recording — transcript, summary, Drive, TaskNote.
 *
 * A recording is always the app's own `.m4a`, but an imported file can be
 * anything the phone holds, so the two things a recording gets for free — its
 * MIME type and its duration — have to be worked out here instead.
 */
import { createAudioPlayer } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Extensions Gemini accepts inline, mapped to the MIME type it expects. Sending
 * a type that disagrees with the bytes gets the request rejected, so the map is
 * deliberately narrow: anything not listed is refused up front rather than
 * failing later with an opaque 400.
 */
const AUDIO_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
};

export const SUPPORTED_AUDIO_EXTENSIONS = Object.keys(AUDIO_TYPES);

export function extensionOf(path: string): string {
  const name = path.split('?')[0].split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * MIME type for a stored audio file, derived from its extension. Recordings are
 * always `.m4a`, so this keeps returning what the recorder used to hardcode.
 */
export function mimeForPath(path: string): string {
  return AUDIO_TYPES[extensionOf(path)] ?? 'audio/mp4';
}

export function isSupportedAudio(path: string): boolean {
  return extensionOf(path) in AUDIO_TYPES;
}

export type PickedAudio = {
  uri: string;
  name: string;
  size: number;
  extension: string;
};

/**
 * Opens the system file picker. Returns null when the user backs out, which is
 * an ordinary outcome rather than an error.
 */
export async function pickAudioFile(): Promise<PickedAudio | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets?.[0];
  if (!asset) return null;

  const extension = extensionOf(asset.name) || extensionOf(asset.uri);
  if (!(extension in AUDIO_TYPES)) {
    throw new Error(
      `${extension ? `.${extension}` : 'That file'} is not a supported audio format. ` +
        `Use ${SUPPORTED_AUDIO_EXTENSIONS.slice(0, 6).join(', ')}.`
    );
  }

  return {
    uri: asset.uri,
    name: asset.name,
    size: asset.size ?? 0,
    extension,
  };
}

/**
 * Copies an imported file into the same durable directory recordings live in,
 * so everything downstream — retry, Drive upload, cleanup — treats the two
 * identically. The picker's copy sits in the cache, which the OS may purge.
 */
export async function importAudioFile(uri: string, id: string, extension: string): Promise<string> {
  const dir = new Directory(Paths.document, 'recordings');
  if (!dir.exists) dir.create({ intermediates: true });

  const destination = new File(dir, `${id}.${extension}`);
  new File(uri).copy(destination);
  return destination.uri;
}

/**
 * Reads a file's length by briefly loading it into a player.
 *
 * Duration matters beyond display: it is what pulls Gemini's drifting timestamps
 * back into range, and what TaskNote stores as the meeting length. Returns 0 if
 * the file will not load in time — callers treat that as "unknown" rather than
 * failing the import, since the transcript is still perfectly usable.
 */
export async function probeDuration(uri: string, timeoutMs = 5000): Promise<number> {
  let player: ReturnType<typeof createAudioPlayer> | null = null;
  try {
    player = createAudioPlayer(uri);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (player.isLoaded && player.duration > 0) return Math.round(player.duration);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return 0;
  } catch {
    return 0;
  } finally {
    try {
      player?.remove();
    } catch {
      // Nothing useful to do if the player is already gone.
    }
  }
}
