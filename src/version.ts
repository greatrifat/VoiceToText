import Constants from 'expo-constants';

/**
 * Read from the app config rather than hardcoded here, so app.json stays the
 * single place a version is bumped and the APK can never disagree with the UI.
 */
export const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

export const ANDROID_VERSION_CODE = Constants.expoConfig?.android?.versionCode ?? null;

/** e.g. "v2.0.0 (2)" — the build number matters when two APKs share a version. */
export const VERSION_LABEL = ANDROID_VERSION_CODE
  ? `v${APP_VERSION} (${ANDROID_VERSION_CODE})`
  : `v${APP_VERSION}`;
