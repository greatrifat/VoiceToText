import * as SecureStore from 'expo-secure-store';

/**
 * Credentials live in the OS keystore rather than the bundle, so the APK ships
 * with no secrets in it. Each device is configured once from the Settings tab.
 */
/**
 * A key and what the user calls it. The name is theirs to choose because the
 * thing that distinguishes two keys — which Google Cloud project they belong to
 * — is invisible from the key itself, and "Fallback 2" told them nothing about
 * which project had run out.
 */
export type ApiKey = {
  name: string;
  key: string;
};

export type Settings = {
  /** In priority order within each model's fallback round. */
  apiKeys: ApiKey[];
  driveUrl: string;
  driveSecret: string;
  /** Optional TaskNote base URL. Blank disables the TaskNote post entirely. */
  taskNoteUrl: string;
};

const KEY_LIST = 'gemini_api_keys';
const LEGACY_SINGLE_KEY = 'gemini_api_key';
const DRIVE_URL = 'drive_url';
const DRIVE_SECRET = 'drive_secret';
const TASKNOTE_URL = 'tasknote_url';

export const EMPTY_SETTINGS: Settings = {
  apiKeys: [],
  driveUrl: '',
  driveSecret: '',
  taskNoteUrl: '',
};

export async function loadSettings(): Promise<Settings> {
  const [rawKeys, legacy, driveUrl, driveSecret, taskNoteUrl] = await Promise.all([
    SecureStore.getItemAsync(KEY_LIST),
    SecureStore.getItemAsync(LEGACY_SINGLE_KEY),
    SecureStore.getItemAsync(DRIVE_URL),
    SecureStore.getItemAsync(DRIVE_SECRET),
    SecureStore.getItemAsync(TASKNOTE_URL),
  ]);

  let apiKeys: ApiKey[] = [];
  if (rawKeys) {
    try {
      const parsed = JSON.parse(rawKeys);
      if (Array.isArray(parsed)) apiKeys = parsed.map(readKey).filter((k): k is ApiKey => !!k);
    } catch {
      apiKeys = [];
    }
  } else if (legacy) {
    // Carry over the single key from before multi-key support existed.
    apiKeys = [{ name: defaultName(0), key: legacy }];
  }

  return {
    apiKeys,
    driveUrl: driveUrl ?? '',
    driveSecret: driveSecret ?? '',
    taskNoteUrl: taskNoteUrl ?? '',
  };
}

/**
 * Just the secrets, in priority order. The Gemini walk works in positions —
 * "key 2 of 4" — so the names stay a Settings-screen concern and never reach it.
 */
export function apiKeyValues(settings: Settings): string[] {
  return settings.apiKeys.map((k) => k.key.trim()).filter(Boolean);
}

/** Name for a key the user has not named, and for every pre-naming key on disk. */
export function defaultName(index: number): string {
  return `Key ${index + 1}`;
}

/**
 * Reads one stored entry. Before names existed the list was plain strings, so
 * both shapes are accepted — the app is sideloaded and upgraded in place, and a
 * migration that dropped everyone's keys would be worse than this branch.
 */
function readKey(entry: unknown, index: number): ApiKey | null {
  if (typeof entry === 'string') {
    return entry ? { name: defaultName(index), key: entry } : null;
  }
  if (entry && typeof entry === 'object') {
    const { name, key } = entry as { name?: unknown; key?: unknown };
    if (typeof key === 'string' && key) {
      return { name: typeof name === 'string' && name.trim() ? name.trim() : defaultName(index), key };
    }
  }
  return null;
}

export async function saveSettings(settings: Settings): Promise<void> {
  // A blank key is a row the user added and did not fill in; a blank name is
  // one they did not bother to name, which is fine and gets numbered.
  const apiKeys = settings.apiKeys
    .map((k) => ({ name: k.name.trim(), key: k.key.trim() }))
    .filter((k) => k.key)
    .map((k, index) => ({ name: k.name || defaultName(index), key: k.key }));
  await Promise.all([
    SecureStore.setItemAsync(KEY_LIST, JSON.stringify(apiKeys)),
    SecureStore.deleteItemAsync(LEGACY_SINGLE_KEY),
    write(DRIVE_URL, settings.driveUrl),
    write(DRIVE_SECRET, settings.driveSecret),
    write(TASKNOTE_URL, settings.taskNoteUrl),
  ]);
}

function write(key: string, value: string) {
  const trimmed = value.trim();
  return trimmed ? SecureStore.setItemAsync(key, trimmed) : SecureStore.deleteItemAsync(key);
}

/** Returns a human-readable reason the settings are unusable, or null if fine. */
export function validateSettings(settings: Settings): string | null {
  if (settings.apiKeys.filter((k) => k.key.trim()).length === 0) {
    return 'Add a Gemini API key in Settings.';
  }
  if (!settings.driveUrl.trim()) {
    return 'Add your Apps Script URL in Settings.';
  }
  if (!settings.driveUrl.trim().endsWith('/exec')) {
    return 'The Apps Script URL should end in /exec.';
  }
  return null;
}
