import * as SecureStore from 'expo-secure-store';

/**
 * Credentials live in the OS keystore rather than the bundle, so the APK ships
 * with no secrets in it. Each device is configured once from the Settings tab.
 */
export type Settings = {
  /** In priority order. Later keys are used only after earlier ones hit quota. */
  apiKeys: string[];
  driveUrl: string;
  driveSecret: string;
};

const KEY_LIST = 'gemini_api_keys';
const LEGACY_SINGLE_KEY = 'gemini_api_key';
const DRIVE_URL = 'drive_url';
const DRIVE_SECRET = 'drive_secret';

export const EMPTY_SETTINGS: Settings = { apiKeys: [], driveUrl: '', driveSecret: '' };

export async function loadSettings(): Promise<Settings> {
  const [rawKeys, legacy, driveUrl, driveSecret] = await Promise.all([
    SecureStore.getItemAsync(KEY_LIST),
    SecureStore.getItemAsync(LEGACY_SINGLE_KEY),
    SecureStore.getItemAsync(DRIVE_URL),
    SecureStore.getItemAsync(DRIVE_SECRET),
  ]);

  let apiKeys: string[] = [];
  if (rawKeys) {
    try {
      const parsed = JSON.parse(rawKeys);
      if (Array.isArray(parsed)) apiKeys = parsed.filter((k) => typeof k === 'string' && k);
    } catch {
      apiKeys = [];
    }
  } else if (legacy) {
    // Carry over the single key from before multi-key support existed.
    apiKeys = [legacy];
  }

  return { apiKeys, driveUrl: driveUrl ?? '', driveSecret: driveSecret ?? '' };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const apiKeys = settings.apiKeys.map((k) => k.trim()).filter(Boolean);
  await Promise.all([
    SecureStore.setItemAsync(KEY_LIST, JSON.stringify(apiKeys)),
    SecureStore.deleteItemAsync(LEGACY_SINGLE_KEY),
    write(DRIVE_URL, settings.driveUrl),
    write(DRIVE_SECRET, settings.driveSecret),
  ]);
}

function write(key: string, value: string) {
  const trimmed = value.trim();
  return trimmed ? SecureStore.setItemAsync(key, trimmed) : SecureStore.deleteItemAsync(key);
}

/** Returns a human-readable reason the settings are unusable, or null if fine. */
export function validateSettings(settings: Settings): string | null {
  if (settings.apiKeys.filter((k) => k.trim()).length === 0) {
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
