const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const store = require('./store.cjs');
const gemini = require('./gemini.cjs');
const integrations = require('./integrations.cjs');
const pipeline = require('./pipeline.cjs');

let mainWindow;

function trustedSender(event) {
  const url = event.senderFrame?.url || '';
  return url.startsWith('file://') || url.startsWith('http://127.0.0.1:5173');
}

function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted renderer.');
    return action(event, ...args);
  });
}

function emitProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('processing:event', payload);
}

function configureCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primary = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primary) || sources[0];
      if (!source) return callback({});
      callback({ video: source, audio: 'loopback' });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, origin) => {
    return permission === 'media' && (origin.startsWith('file://') || origin === 'http://127.0.0.1:5173');
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    callback(permission === 'media' && (url.startsWith('file://') || url.startsWith('http://127.0.0.1:5173')));
  });
}

function registerIpc() {
  handle('app:get-state', async () => ({
    settings: await store.loadSettings(),
    meetings: await store.listMeetings(),
    version: app.getVersion(),
  }));
  handle('settings:save', (_event, settings) => store.saveSettings(settings));
  handle('settings:test-api-key', async (_event, key) => ({ models: await gemini.verifyApiKey(key) }));
  handle('settings:test-drive', async (_event, url) => integrations.verifyDriveUrl(String(url || '').trim()));
  handle('settings:test-tasknote', async (_event, url) => integrations.verifyTaskNoteUrl(String(url || '').trim()));
  handle('audio:save', (_event, audio) => {
    if (!(audio?.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(audio?.bytes)) {
      throw new Error('Invalid audio payload.');
    }
    return store.createMeetingFromAudio(audio);
  });
  handle('meeting:list', () => store.listMeetings());
  handle('meeting:get', (_event, id) => store.getMeeting(String(id)));
  handle('meeting:delete', async (_event, id) => {
    if (pipeline.isProcessing(String(id))) throw new Error('Wait for processing to finish before deleting.');
    await store.deleteMeeting(String(id));
  });
  handle('meeting:process', (_event, id) => pipeline.processMeeting(String(id), emitProgress));
  handle('meeting:ask', (_event, payload) => pipeline.askMeeting(String(payload?.id), payload?.question, emitProgress));
  handle('meeting:export', async (_event, id) => {
    const meeting = await store.getMeeting(String(id));
    if (!meeting) throw new Error('Meeting not found.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export meeting',
      defaultPath: `${meeting.title.replace(/[\\/:*?"<>|]/g, ' ')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const content = `# ${meeting.title}\n\n${meeting.summary ? `## Summary\n\n${meeting.summary}\n\n` : ''}## Transcript\n\n${meeting.transcript || 'No transcript yet.'}\n`;
    await fs.writeFile(result.filePath, content, 'utf8');
    return result.filePath;
  });
  handle('meeting:open-audio', async (_event, id) => {
    const meeting = await store.getMeeting(String(id));
    if (!meeting) throw new Error('Meeting not found.');
    if (meeting.audioPath) {
      const result = await shell.openPath(meeting.audioPath);
      if (result) throw new Error(result);
      return;
    }
    if (meeting.audioUrl) return shell.openExternal(meeting.audioUrl);
    throw new Error('No audio is available.');
  });
  handle('app:open-url', (_event, url) => {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new Error('Only secure links can be opened.');
    return shell.openExternal(parsed.toString());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#080d16',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#080d16', symbolColor: '#8f9bad', height: 42 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://127.0.0.1:5173')) event.preventDefault();
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  const screenshotPath = process.env.VTT_CAPTURE_SCREENSHOT;
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage();
        await fs.writeFile(screenshotPath, image.toPNG());
        app.quit();
      }, 800);
    });
  }
}

app.whenReady().then(() => {
  configureCapture();
  registerIpc();
  if (process.argv.includes('--smoke-test')) {
    console.log('VoiceToText Desktop main process is ready.');
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
