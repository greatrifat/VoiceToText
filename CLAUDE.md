# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npx tsc --noEmit                       # the only automated check in this repo
npm start                              # Metro / Expo Go
npx expo prebuild --platform android   # after ANY app.json change
cd android && ./gradlew.bat assembleRelease
```

APK lands at `android/app/build/outputs/apk/release/app-release.apk`.

On Windows the Gradle build needs `ANDROID_HOME=C:\Android` exported in the same
shell. First build ~23 min; incremental ~3 min. **Never pass `--clean` to
prebuild** unless the native project is actually broken — it wipes
`android/build` and forces the full 23-minute path.

There is no test framework and no linter. Verification is `tsc --noEmit` plus
probing the real APIs with throwaway Node scripts (`fetch` against Gemini or the
deployed Apps Script, `node:sqlite` against the migration SQL). Prefer that over
assuming a change works — most of this codebase is I/O against three external
systems.

## Architecture

Two halves that deploy separately:

1. **Expo app** (`src/`) — records, calls Gemini, posts to the script
2. **`apps-script/Code.gs`** — a Google Apps Script Web App that writes to Drive

The script is **not deployed from this repo**. Editing `Code.gs` does nothing
until the user manually pastes it into script.google.com, saves, and redeploys
via *Manage deployments → New version*. Always tell the user to redeploy after
changing it; a stale deployment fails silently by doing the old behaviour. Only
the user can deploy it — Claude cannot.

### Credentials never enter the bundle

Gemini key, Apps Script URL and optional shared secret live in
`expo-secure-store` (`src/settings.ts`), are loaded once by `SettingsContext`,
and are **passed as explicit arguments** into `gemini.ts` / `drive.ts`. That is
why those modules take `apiKey` / `driveUrl` params instead of importing config.

Do not reintroduce `.env` / `EXPO_PUBLIC_*` for secrets — those are compiled into
the APK and readable by anyone who unzips it. An earlier version did this; it was
removed deliberately.

### The transcript-preservation invariant

`RecordScreen.stopAndProcess` writes to SQLite in a `finally` block, on purpose.
Once Gemini returns a transcript the user has already spent a meeting and an API
call on it, so a later failure (summary, Drive upload, network) must never
discard it. The row is saved with whatever URLs exist; a null `folderUrl` renders
as "not in Drive" in History. Preserve this ordering when touching that function.

Summarization is likewise wrapped in its own try/catch — a failed summary is
recoverable from History's *Generate summary* button, a lost transcript is not.

### Database migrations

`src/db.ts` migrates on `PRAGMA user_version`. Each version is an append-only
block; **never edit an existing block**, since devices already ran it. A fresh
install runs every block in sequence, so the v1 block is also the table creation.
Add new columns as a new `if (version < N)` block plus a `PRAGMA user_version = N`.

### Drive layout

Each upload creates a **new** subfolder under `VoiceToText Meetings` holding
`<title>.m4a`, `transcript.txt`, and `summary.txt`. Folders are never reused even
on title collision — two meetings silently merging into one folder is worse than
a duplicate the user can rename.

### Audio constraints

`recording.ts` uses a mono 32kbps AAC preset because audio is sent to Gemini
**inline**, which caps around 20MB per request — roughly an hour at this bitrate.
`MAX_INLINE_AUDIO_BYTES` (14MB) rejects oversized files up front rather than
letting the API return an opaque 400. Lifting this limit means moving to the
Gemini Files API, not raising the constant.

`RECORDING_MIME_TYPE` (`audio/mp4`) must stay consistent with the preset's `.m4a`
extension — Gemini rejects a mismatch.

`expo-audio` has `pause()` but **no `resume()`**; call `record()` again to resume.

### Versioning

`app.json` (`expo.version`, `expo.android.versionCode`) is the single source of
truth. `src/version.ts` reads it back through `expo-constants` so the Settings
footer cannot drift from the APK — do not hardcode a version string anywhere.
Bump `versionCode` on every sideloaded build; Android refuses to install over an
equal or higher installed code, surfacing as a misleading "app not installed".

Changes to `app.json` only reach Gradle after `expo prebuild`.
