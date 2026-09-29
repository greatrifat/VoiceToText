const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceDesktop', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testApiKey: (key) => ipcRenderer.invoke('settings:test-api-key', key),
  testDrive: (url) => ipcRenderer.invoke('settings:test-drive', url),
  testTaskNote: (url) => ipcRenderer.invoke('settings:test-tasknote', url),
  saveAudio: (audio) => ipcRenderer.invoke('audio:save', audio),
  listMeetings: () => ipcRenderer.invoke('meeting:list'),
  getMeeting: (id) => ipcRenderer.invoke('meeting:get', id),
  deleteMeeting: (id) => ipcRenderer.invoke('meeting:delete', id),
  processMeeting: (id) => ipcRenderer.invoke('meeting:process', id),
  askMeeting: (id, question) => ipcRenderer.invoke('meeting:ask', { id, question }),
  exportMeeting: (id) => ipcRenderer.invoke('meeting:export', id),
  openMeetingAudio: (id) => ipcRenderer.invoke('meeting:open-audio', id),
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url),
  onProcessing: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('processing:event', listener);
    return () => ipcRenderer.removeListener('processing:event', listener);
  },
});
