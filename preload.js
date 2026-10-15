const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('muse', {
  sendPlayerState: (s) => ipcRenderer.send('player-state', s),
  // Structured clone, not JSON — at 30fps the stringify cost shows up.
  sendSpectrum: (frame) => ipcRenderer.send('spectrum-frame', frame),
  loadCookie: () => ipcRenderer.invoke('cookie-load'),
  saveCookie: (c) => ipcRenderer.invoke('cookie-save', c),
  clearCookie: () => ipcRenderer.invoke('cookie-clear'),
  onOpenCommandSurface: (cb) => ipcRenderer.on('open-command-surface', () => cb()),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  // The menu bar: { title ('' = none), playing, trackId } → icon + text.
  setTrayState: (state) => ipcRenderer.invoke('tray-state', state),
  resizeWindow: (w, h) => ipcRenderer.invoke('resize-window', w, h),
  setWindowBg: (color) => ipcRenderer.invoke('set-window-bg', color),
  onWindowAppear: (cb) => ipcRenderer.on('window-appear', () => cb()),
  store: {
    get: (key, fallback) => ipcRenderer.invoke('store-get', key, fallback),
    set: (key, value) => ipcRenderer.invoke('store-set', key, value),
  },
  history: {
    add: (event) => ipcRenderer.invoke('history-add', event),
  },
  // Ask: an OpenAI-compatible Responses call made by the main process (the
  // key never enters the renderer). respond(body) → { model, output, usage }.
  llm: {
    available: () => ipcRenderer.invoke('llm-available'),
    respond: (body) => ipcRenderer.invoke('llm-respond', body),
  },
  // Report a play to NetEase listen history. payload: { action:'startplay'|'playend', id, sourceId, time? }
  scrobble: (payload) => ipcRenderer.invoke('scrobble', payload),
  ncmBase: 'http://127.0.0.1:10764',   // MuseV2's own NCM API port — keep in sync with main.js NCM_PORT
});
