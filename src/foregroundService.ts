import BackgroundService, {
  type BackgroundTaskOptions,
} from 'react-native-background-actions';

/**
 * A single Android foreground service shared by every path that runs the
 * processing pipeline — the Record-screen import/record flow and the History
 * retry queue both call `processMeeting`, and either can be left running when
 * the screen locks. Android otherwise suspends the JS thread under Doze the
 * moment the screen goes off, stalling a transcription mid-flight and dropping
 * its socket. The service — with the persistent notification Android requires —
 * keeps the JS runtime and network alive so the pipeline finishes.
 *
 * Reference counted so overlapping owners compose: it starts on the first
 * acquire and stops only when the last releases. It must be acquired while the
 * app is foregrounded (Android 12+ forbids starting a foreground service from
 * the background) — every caller does so from a user action, before any screen
 * lock.
 */
const FGS_OPTIONS: BackgroundTaskOptions = {
  taskName: 'processing',
  taskTitle: 'VoiceToText',
  taskDesc: 'Processing recordings…',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  foregroundServiceType: ['dataSync'],
};

// Never resolves: keeps the service (and the JS runtime under it) alive until
// stop() is called, while the app's own queue does the real work on that runtime.
const keepRuntimeAlive = () => new Promise<void>(() => {});

let holders = 0;

export async function acquireForegroundService(): Promise<void> {
  holders += 1;
  if (holders > 1) return;
  try {
    if (!BackgroundService.isRunning()) {
      await BackgroundService.start(keepRuntimeAlive, FGS_OPTIONS);
    }
  } catch {
    // If the service cannot start, processing still runs while foregrounded.
  }
}

export async function releaseForegroundService(): Promise<void> {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return;
  try {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
  } catch {
    // A lingering notification is harmless next to a stuck process.
  }
}
