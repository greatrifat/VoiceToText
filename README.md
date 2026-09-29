# VoiceToText

> A Windows desktop edition is available in [DesktopApp](DesktopApp/README.md).
> It records system/meeting audio and the microphone together, then runs the
> same Gemini → Drive → optional TaskNote workflow as the mobile app.

Record a meeting → Gemini transcribes and summarises it → audio, transcript and
summary land in your Google Drive. An optional TaskNote mirror makes the same
meeting readable from the web.

Three tabs: **New Record**, **History**, **Settings**.

## First run

The APK ships with **no credentials baked in**. Open **Settings** and fill in:

| Field | Where it comes from |
| --- | --- |
| Gemini API key(s) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Apps Script URL | the `/exec` URL from your Web App deployment (below) |
| Shared secret | only if you set `SHARED_SECRET` in the Apps Script |
| TaskNote URL | optional — a TaskNote instance to mirror finished meetings to |

You can add **more than one Gemini key** and give each a name. Free-tier quota is
metered per model and Google Cloud project, so keys from separate projects add
daily headroom. The app tries each model across the configured keys before moving
to the next model. In the processing line keys stay numbered by order; the names
you set are shown on the Settings page.

The Gemini and Apps Script fields have a **Test** button — use them before
recording, so a bad key surfaces immediately rather than after you've sat through
a meeting.

Values are stored via `expo-secure-store` (Android keystore), not in the bundle,
and are never written to `.env` or `EXPO_PUBLIC_*` (those compile into the APK).

## How a recording is processed

`src/pipeline.ts` runs the stages a meeting still needs, in order:

1. **Transcribe** — the audio is uploaded **once** to the Gemini Files API and
   referenced by URL, so a fallback to another model doesn't re-send the
   recording. Models are tried best-first across the Flash family.
2. **Summarise** — a title + structured summary in the transcript's own language.
   Wrapped so a failed summary never blocks the upload.
3. **Upload to Drive** — a new subfolder per meeting holding the audio,
   `transcript.txt` and `summary.txt`.
4. **TaskNote** (optional) — posts the finished meeting to `{taskNoteUrl}` so it
   is readable from the web app too. Skipped entirely when the URL is blank.

The recording is saved to disk and its History row created **before any network
call**, so nothing is ever lost to a dropped connection. A meeting that stalled
part-way can be resumed from **History → Try now**, which re-runs only the stages
that didn't finish — a meeting that transcribed but failed to upload re-uploads
without paying Gemini again.

**Background processing**: a retry started from History keeps running after you
close the detail and browse other recordings. The History row shows a live badge
(`Transcribing… → Summarizing… → Saving to Drive…`) and refreshes itself when it
finishes. Retries run one at a time.

**Diagnostics**: each meeting records per-stage timings (encode / transcribe /
summary / upload), the model that answered, and a per-attempt walk log — shown in
a Diagnostics panel on the meeting, since a sideloaded build has no console.

**Download audio** is available from a meeting: the on-device copy via the share
sheet, or the Drive link once it has been uploaded.

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
version*. Picking "New deployment" instead mints a different URL. A stale
deployment fails silently by running the old code.

Anyone holding the `/exec` URL can write into your Drive. To require a second
factor, set `SHARED_SECRET` in `Code.gs` and enter the same value in Settings.

## Building the APK

Needs Java 17+, and an Android SDK with platform 36. On Windows, export
`ANDROID_HOME=C:\Android` in the same shell. From the repo root:

```bash
npx tsc --noEmit                       # the only automated check in this repo
npx expo prebuild --platform android   # required after ANY app.json change
cd android && ./gradlew.bat assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

First build is ~23 min; incremental ~3 min. **Don't pass `--clean` to prebuild**
unless the native project is actually broken — it forces the full 23-minute path.

**Versioning**: bump `expo.version` and `expo.android.versionCode` in
[app.json](app.json), then re-run `expo prebuild` so the values reach
`android/app/build.gradle`. The Settings screen reads the same config, so the
number shown in the app can't drift from the one in the APK. Android refuses to
install an APK whose `versionCode` is lower than or equal to the installed one,
so bump it on every build you intend to sideload over an existing install.

## Layout

| File | Role |
| --- | --- |
| [App.tsx](App.tsx) | Tab navigator; Settings and Processing providers |
| [src/screens/RecordScreen.tsx](src/screens/RecordScreen.tsx) | Record → persist → process flow |
| [src/screens/HistoryScreen.tsx](src/screens/HistoryScreen.tsx) | Past meetings; live processing badges; tap to read, long-press to delete |
| [src/screens/MeetingDetail.tsx](src/screens/MeetingDetail.tsx) | Summary/transcript/ask, retry, download audio, diagnostics |
| [src/screens/SettingsScreen.tsx](src/screens/SettingsScreen.tsx) | Credentials with live connection tests |
| [src/pipeline.ts](src/pipeline.ts) | The stage machine — transcribe → summary → Drive → TaskNote; also the retry path |
| [src/ProcessingContext.tsx](src/ProcessingContext.tsx) | Runs pipelines above the screens so a retry survives navigation |
| [src/settings.ts](src/settings.ts) | Keystore-backed credentials; named multi-key support |
| [src/db.ts](src/db.ts) | SQLite history, migrated on `PRAGMA user_version` |
| [src/gemini.ts](src/gemini.ts) | Transcription + summary; Files API upload, model/key fallback walk |
| [src/config.ts](src/config.ts) | Model list, timeouts, size cap |
| [src/net.ts](src/net.ts) | `fetch` with retry and abort-based timeouts |
| [src/drive.ts](src/drive.ts) | Uploads to the Apps Script |
| [src/tasknote.ts](src/tasknote.ts) | Optional mirror to a TaskNote instance |
| [src/recording.ts](src/recording.ts) | Speech-tuned preset (mono, 32kbps AAC) |
| [apps-script/Code.gs](apps-script/Code.gs) | Server side — writes the three files to Drive |

History is local to the device. Drive holds the durable copy, so deleting a
history row leaves the Drive files untouched.

## Known limit

Audio files are capped at **30MB** (`MAX_INLINE_AUDIO_BYTES`). The built-in
recorder uses mono AAC at 32kbps, giving a theoretical maximum of about **2 hours
11 minutes**; plan on roughly **2 hours** in practice. Imported files keep their
original bitrate, so their duration limit can be much shorter—for example, about
65 minutes at 64kbps or 32 minutes at 128kbps. The app refuses anything larger
with a clear message rather than failing on an opaque error.

Transcription itself no longer inlines the audio — it uploads once to the Gemini
Files API — so the remaining ceiling is the base64 Drive upload path, not Gemini.
Lifting it means streaming the Drive upload rather than sending it as one base64
body.
