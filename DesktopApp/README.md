# VoiceToText Desktop

Windows desktop companion for VoiceToText. It records two sources into one
meeting file:

- **System audio** through Windows loopback: Teams, Google Meet, Zoom, YouTube,
  browser tabs, media players, and other apps using the selected Windows output.
- **Microphone audio** from the current default microphone.

After recording, it uses the same flow as the mobile app: Gemini transcription
and summary, Google Drive upload, optional TaskNote mirroring, local History,
retry, export, and transcript Q&A.

## First run

Open **Settings** and add:

1. One or more Gemini API keys. Separate Google Cloud projects provide separate
   model quota; a model 404 or quota failure on one key does not disable that
   model for the other keys.
2. The Google Apps Script `/exec` URL documented in the repository README.
3. The optional Apps Script shared secret and TaskNote URL.

Settings are encrypted at rest with Windows DPAPI through Electron
`safeStorage`. No credential is bundled in the application.

## Recording

Start VoiceToText before the call, then select **Start recording**. The app mixes
Windows loopback audio and the microphone with the Web Audio API and records a
speech-tuned WebM/Opus stream. The microphone chip can be switched on or off
before or during a recording; system audio remains active. Headphones are
recommended so the microphone does not pick up speaker audio a second time.

Recording continues while you open History or Settings. The Record navigation
item shows a red activity dot, and returning to Record restores the live timer
and controls. Use the explicit discard button when you actually want to throw a
recording away.

The recording is written locally before any network step. After a successful
Drive upload, the local audio copy is removed; the History metadata, transcript,
summary, and Drive links remain on the PC.

The current file cap is **30MB** because the Apps Script upload is base64 form
data. At the recorder target of 32kbps, that is theoretically about 2 hours 11
minutes; plan on roughly **2 hours**. Imported audio keeps its original bitrate,
so its maximum duration can be much shorter.

## Development

Requires Node.js and Windows 10/11.

```powershell
cd DesktopApp
npm install
npm run dev
```

Checks and production bundle:

```powershell
npm run typecheck
npm run build
```

Create both the NSIS installer and portable executable:

```powershell
npm run dist:win
```

Outputs are written to `DesktopApp/release/`.

## Architecture

- `electron/main.cjs` owns the window, Windows loopback permission, safe file
  operations, and narrow IPC surface.
- `electron/preload.cjs` exposes only the methods required by the UI.
- `electron/gemini.cjs` handles Files API upload and model/key fallback.
- `electron/pipeline.cjs` resumes incomplete processing without retranscribing
  completed work.
- `src/App.tsx` contains Record, History/detail, and Settings experiences.

The renderer has no Node.js access. External links are restricted to HTTPS and
opened by the main process.
