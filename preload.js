const { contextBridge, ipcRenderer } = require('electron');

// Asked once, synchronously, before the page runs: which NCM API (the dev
// profile has its own port) and how this launch starts.
const config = ipcRenderer.sendSync('muse-config') || {};

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
  // The menu bar: { title ('' = none), playing, trackId, thinking } → icon + text.
  setTrayState: (state) => ipcRenderer.invoke('tray-state', state),
  resizeWindow: (w, h) => ipcRenderer.invoke('resize-window', w, h),
  setWindowBg: (color) => ipcRenderer.invoke('set-window-bg', color),
  onWindowAppear: (cb) => ipcRenderer.on('window-appear', () => cb()),
  onWindowHidden: (cb) => ipcRenderer.on('window-hidden', () => cb()),
  shownAtStart: config.shownAtStart !== false,
  store: {
    get: (key, fallback) => ipcRenderer.invoke('store-get', key, fallback),
    set: (key, value) => ipcRenderer.invoke('store-set', key, value),
  },
  history: {
    add: (event) => ipcRenderer.invoke('history-add', event),
  },
  // Asks and Muse playlists, kept by main (lib/collections.js).
  // kind: 'asks' | 'playlists'. onChange fires for every change, wherever it came from.
  collections: {
    list: (kind) => ipcRenderer.invoke('collections-list', kind),
    put: (kind, item) => ipcRenderer.invoke('collections-put', kind, item),
    remove: (kind, id) => ipcRenderer.invoke('collections-remove', kind, id),
    onChange: (cb) => ipcRenderer.on('collections-changed', (_, d) => cb(d)),
  },
  // A system notification; clicking it opens the window on that ask.
  notify: (n) => ipcRenderer.invoke('notify', n),
  onOpenAsk: (cb) => ipcRenderer.on('open-ask', (_, id) => cb(id)),
  // Agents (lib/control.js → renderer/lib/remote.js): a call comes in, a
  // reply goes back with its id.
  onRemoteCall: (cb) => ipcRenderer.on('remote-call', (_, c) => cb(c)),
  remoteReply: (reply) => ipcRenderer.send('remote-reply', reply),
  controlInfo: () => ipcRenderer.invoke('control-info'),
  // Ask: an OpenAI-compatible Responses call made by the main process (the
  // key never enters the renderer). respond(body) → { model, output, usage }.
  llm: {
    available: () => ipcRenderer.invoke('llm-available'),
    respond: (body) => ipcRenderer.invoke('llm-respond', body),
  },
  // Report a play to NetEase listen history. payload: { action:'startplay'|'playend', id, sourceId, time? }
  scrobble: (payload) => ipcRenderer.invoke('scrobble', payload),
  // Cover thumbnails go through main's disk cache (lib/thumbs.js).
  thumbScheme: 'muse-thumb',
  ncmBase: config.ncmBase || 'http://127.0.0.1:10764',   // main.js NCM_PORT
  startPaused: !!config.startPaused,
  dev: !!config.dev,
  agentDir: config.agentDir || '',
});
