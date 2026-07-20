# VoiceToText

Record a meeting → Gemini transcribes it → audio and transcript land in your Google Drive.

Three tabs: **New Record**, **History**, **Settings**.

## First run

The APK ships with **no credentials baked in**. Open **Settings** and fill in:

| Field | Where it comes from |
| --- | --- |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Apps Script URL | the `/exec` URL from your Web App deployment (below) |
| Shared secret | only if you set `SHARED_SECRET` in the Apps Script |

Both fields have a **Test** button — use them before recording, so a bad key
surfaces immediately rather than after you've sat through a meeting.

Values are stored via `expo-secure-store` (Android keystore), not in the bundle.

## Apps Script setup

1. [script.google.com](https://script.google.com) → **New project**
2. Paste [apps-script/Code.gs](apps-script/Code.gs), then **Ctrl+S to save** —
   deployments snapshot the *saved* code, so an unsaved edit deploys nothing
3. **Deploy** → **New deployment** → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (otherwise the app gets an HTML login page)
4. Authorise it — "unverified app" is expected for your own script
5. Copy the **`/exec`** URL into the app's Settings

Opening the `/exec` URL in a browser should return
`{"ok":true,"status":"VoiceToText Drive receiver is live"}`.

**After editing the script**, use **Manage deployments** → ✏️ → Version: *New
version*. Picking "New deployment" instead mints a different URL.

Anyone holding the `/exec` URL can write into your Drive. To require a second
factor, set `SHARED_SECRET` in `Code.gs` and enter the same value in Settings.

## Building the APK

Needs Java 17+, and an Android SDK with platform 36. From the repo root:

```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

**Versioning**: bump `expo.version` and `expo.android.versionCode` in
[app.json](app.json), then re-run `expo prebuild` so the values reach
`android/app/build.gradle`. The Settings screen reads the same config, so the
number shown in the app can't drift from the one in the APK. Android refuses to
install an APK whose `versionCode` is lower than the installed one, so bump it
on every build you intend to sideload over an existing install.

## Layout

| File | Role |
| --- | --- |
| [App.tsx](App.tsx) | Tab navigator and providers |
| [src/screens/RecordScreen.tsx](src/screens/RecordScreen.tsx) | Record → transcribe → upload flow |
| [src/screens/HistoryScreen.tsx](src/screens/HistoryScreen.tsx) | Past meetings; tap to read, long-press to delete |
| [src/screens/SettingsScreen.tsx](src/screens/SettingsScreen.tsx) | Credentials with live connection tests |
| [src/settings.ts](src/settings.ts) | Keystore-backed credential storage |
| [src/db.ts](src/db.ts) | SQLite history |
| [src/gemini.ts](src/gemini.ts) | Transcription via `gemini-2.5-flash` |
| [src/drive.ts](src/drive.ts) | Uploads to the Apps Script |
| [src/recording.ts](src/recording.ts) | Speech-tuned preset (mono, 32kbps AAC) |
| [apps-script/Code.gs](apps-script/Code.gs) | Server side — writes both files to Drive |

History is local to the device. Drive holds the durable copy, so deleting a
history row leaves the Drive files untouched.

## Known limit

Audio is sent to Gemini inline, which caps at ~20MB per request — roughly **an
hour** at this bitrate. The app refuses anything larger with a clear message
rather than failing on an opaque 400.

Lifting it means switching to the Gemini Files API (upload, then reference the
file URI), which also unlocks multi-hour recordings. That's the natural next
step once the basic flow is proven on-device.
