const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, globalShortcut, nativeImage, clipboard, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api');
const { WebSocketServer } = require('ws');
const { Store } = require('./lib/store');
const llm = require('./lib/llm').create(path.join(app.getPath('userData'), 'llm.json'));
const thumbs = require('./lib/thumbs');
thumbs.registerScheme(protocol);   // must precede 'ready'

// Name has to be set BEFORE whenReady so it propagates to every place
// Electron reads `app.getName()` (the About panel, the application menu
// built below, user-data path). Without this the default "Electron"
// identity leaks into visible surfaces.
app.setName('MuseV2');   // also picks the userData dir: ~/Library/Application Support/MuseV2

// One MuseV2 at a time — keyed on MuseV2's own userData, so Muse v1 running
// alongside is fine. A second launch just summons the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => showCommandSurface());

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRAY_PATH = path.join(__dirname, 'assets', 'trayTemplate.png');

let tray = null;  // menu-bar entry (the only visible UI when dock is hidden)

// Local NCM API (the reverse-engineered HTTP wrapper YesPlayMusic also uses).
// MuseV2 has its own (v1 uses 10754), so the two can run side by side.
// preload.js mirrors this in ncmBase — change both together.
const NCM_PORT = 10764;
// Tiny side server that exposes the renderer's current playback state so
// echo (or anything else) can poll it instead of nowplaying-cli.
// Wire format is defined in ./NOW_PLAYING.md — any field change must land
// there + in echo in the same commit.
// /now + /spectrum for echo. echo reads 10755, so MuseV2 takes it when it's
// free; if Muse v1 already holds it, MuseV2 serves on 10765 instead and echo
// keeps following v1. Whichever app starts first is the one echo shows.
const NOW_PORTS = [10755, 10765];
let NOW_PORT = NOW_PORTS[0];

const COOKIE_PATH = path.join(app.getPath('userData'), 'cookie.txt');
let store;     // initialized in app.whenReady (needs userData path)

let win;
let nowState = {
  title: '',
  artist: '',
  album: '',
  cover: '',
  songId: 0,
  duration: 0,
  currentTime: 0,
  playing: false,
  updatedAt: 0,
  // Epoch ms of the moment `currentTime` was sampled. Consumers use this
  // (not "now") to anchor local interpolation, eliminating the 0–1s poll-lag
  // drift that used to show up on seek/pause.
  positionSampledAt: 0,
  // Monotonic counter; bumped only on a timeline discontinuity (new song,
  // play/pause transition, or a seek detected as |currentTime - expected| > 0.5s).
  // Consumers treat "stateVersion changed" as "drop local clock, re-anchor".
  stateVersion: 0,
};
let stateVersion = 0;

function isDiscontinuity(prev, next, now) {
  if (prev.updatedAt === 0) return true;
  if (prev.songId !== next.songId) return true;
  if (prev.playing !== next.playing) return true;
  const dt = (now - prev.updatedAt) / 1000;
  const expected = prev.currentTime + (prev.playing ? dt : 0);
  return Math.abs((next.currentTime || 0) - expected) > 0.5;
}

async function startNcmApi() {
  // Modules array left empty → the package walks its own ./module folder.
  await serveNcmApi({ port: NCM_PORT, checkVersion: false });
  console.log(`[muse] NCM API on http://127.0.0.1:${NCM_PORT}`);
}

let nowServer;
let spectrumWss;
// Spectrum channel (v1.2 of NOW_PLAYING.md). Contract constants live here so
// the hello frame is authoritative — consumers key off this to map bands to
// frequency/screen position without hardcoding.
const SPECTRUM_SAMPLE_HZ = 30;
const SPECTRUM_BAND_COUNT = 24;
const SPECTRUM_FMIN_HZ = 60;
const SPECTRUM_FMAX_HZ = 12000;

// History retention: 365 days is plenty for the in-app tape view; beyond that
// the file just bloats on disk. Trim happens on every append, so a long-paused
// muse won't accumulate stale events either.
const HISTORY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

async function startNowServer() {
  for (let i = 0; i < NOW_PORTS.length; i++) {
    try { await listenNow(NOW_PORTS[i]); return; }
    catch (e) { if (e.code !== 'EADDRINUSE' || i === NOW_PORTS.length - 1) throw e; }
  }
}

function listenNow(port) {
  NOW_PORT = port;
  return new Promise((resolve, reject) => {
    nowServer = http.createServer((req, res) => {
      if (req.url !== '/now') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(nowState));
    });
    // WebSocket /spectrum shares the HTTP server so port policy stays a single
    // story (probe /now on startup → know muse is already running). noServer
    // mode lets us accept /spectrum and reject other paths explicitly.
    spectrumWss = new WebSocketServer({ noServer: true });
    nowServer.on('upgrade', (req, sock, head) => {
      if (req.url !== '/spectrum') { sock.destroy(); return; }
      spectrumWss.handleUpgrade(req, sock, head, (ws) => {
        // Handshake: tell the consumer the contract so it doesn't have to
        // hardcode 24/30/log. Sent once, synchronously on connect.
        try {
          ws.send(JSON.stringify({
            type: 'hello',
            sampleRate: SPECTRUM_SAMPLE_HZ,
            bandCount: SPECTRUM_BAND_COUNT,
            logBase: true,
            fMin: SPECTRUM_FMIN_HZ,
            fMax: SPECTRUM_FMAX_HZ,
          }));
        } catch {}
      });
    });
    nowServer.once('error', reject);
    nowServer.listen(NOW_PORT, '127.0.0.1', () => {
      console.log(`[muse] /now on http://127.0.0.1:${NOW_PORT}/now`);
      console.log(`[muse] /spectrum on ws://127.0.0.1:${NOW_PORT}/spectrum`);
      resolve();
    });
  });
}

// Renderer pushes the live audio state ~4Hz; we just cache it for /now.
// Defensive copy via JSON.parse(JSON.stringify) is unnecessary — the IPC
// boundary already gives us a structured clone.
//
// stateVersion is bumped here (not in the renderer) so we don't need a
// renderer contract change — discontinuities are inferred by comparing the
// incoming sample against a linear extrapolation of the previous one.
ipcMain.on('player-state', (_, s) => {
  if (!s || typeof s !== 'object') return;
  const now = Date.now();
  if (isDiscontinuity(nowState, s, now)) stateVersion++;
  nowState = {
    ...s,
    updatedAt: now,
    positionSampledAt: now,
    stateVersion,
  };
});

// Spectrum frame from renderer. Tag with the current stateVersion so
// consumers can share one "has the timeline reset?" signal across /now and
// /spectrum. Broadcast to all WS subscribers; dead sockets are cheap to skip.
ipcMain.on('spectrum-frame', (_, frame) => {
  if (!spectrumWss || spectrumWss.clients.size === 0) return;
  if (!frame || !Array.isArray(frame.bands)) return;
  const msg = JSON.stringify({
    t: frame.t || Date.now(),
    bands: frame.bands,
    rms: typeof frame.rms === 'number' ? frame.rms : 0,
    stateVersion,
  });
  for (const ws of spectrumWss.clients) {
    // ws.OPEN === 1; inline to avoid the import churn.
    if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
  }
});

// Persist NetEase login cookie so the user doesn't re-scan QR every launch.
ipcMain.handle('cookie-load', () => {
  try { return fs.readFileSync(COOKIE_PATH, 'utf8'); } catch { return ''; }
});
ipcMain.handle('cookie-save', (_, cookie) => {
  try { fs.writeFileSync(COOKIE_PATH, typeof cookie === 'string' ? cookie : ''); }
  catch (e) { console.error('[muse] cookie-save', e); throw e; }
});
ipcMain.handle('cookie-clear', () => {
  try { fs.unlinkSync(COOKIE_PATH); } catch {}
});

// Generic JSON store, exposed as muse.store.{get,set} in renderer. Errors
// propagate back to the caller as rejected promises so renderer code can
// surface them, but we also log here for diagnosis.
ipcMain.handle('store-get', (_, key, fallback) => {
  try { return store.get(key, fallback); }
  catch (e) { console.error('[muse] store-get', key, e); throw e; }
});
ipcMain.handle('store-set', (_, key, value) => {
  try { store.set(key, value); }
  catch (e) { console.error('[muse] store-set', key, e); throw e; }
});

// Append a single play event. Done in main (not via store-get/set in renderer)
// so the read-modify-write of the history array is single-threaded — there is
// only one renderer, but this also keeps trimming logic in one place.
ipcMain.handle('history-add', (_, event) => {
  if (!event || typeof event.at !== 'number') return;
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const prev = store.get('history', []) || [];
  const next = prev.filter((e) => e && e.at >= cutoff);
  next.push(event);
  store.set('history', next);
});

// Listen-history scrobble. Bypasses the local NCM HTTP wrapper's /scrobble
// endpoint (which hardcodes weapi → music.163.com — NetEase silently DROPS
// those now: HTTP 200 "success" but nothing lands in 最近播放 / 听歌排行).
// The combination that still works, verified 2026-06 against a live account:
//   • domain  clientlog.music.163.com   • crypto  eapi
//   • client identity faked as the macOS desktop app (os=osx). pc / android /
//     iphone identities are all dropped.
// We talk to the package's request module directly to control domain+crypto.
// Lazy-required: the package's main.js (already loaded above) creates the
// anonymous_token file it reads on load, so requiring it after startup is safe.
let ncmRequest = null;
ipcMain.handle('scrobble', async (_, payload) => {
  const { action, id, sourceId, time } = payload || {};
  if (typeof id !== 'number' || !sourceId) return { code: 400, data: 'bad-args' };
  let cookie;
  try { cookie = fs.readFileSync(COOKIE_PATH, 'utf8').trim(); }
  catch { return { code: 401, data: 'no-cookie' }; }
  if (!cookie) return { code: 401, data: 'no-cookie' };

  // Append the macOS-client identity the server requires for plays to count.
  const osxCookie = `${cookie}; os=osx; appver=3.1.10.5100; osver=15.5; channel=netease`;
  const src = String(sourceId);
  const common = { mainsite: '1', mainsiteWeb: '1', content: `id=${src}` };
  // startplay drives the 最近播放 list; playend (with elapsed `time`) drives
  // the 听歌排行 counter. Both are needed for a play to fully register.
  const entry = action === 'startplay'
    ? { action: 'startplay', json: { id, type: 'song', ...common } }
    : { action: 'play', json: { type: 'song', wifi: 0, download: 0, id, time: time || 0, end: 'playend', source: 'list', sourceId: src, ...common } };

  try {
    if (!ncmRequest) ncmRequest = require('@neteasecloudmusicapienhanced/api/util/request.js');
    const r = await ncmRequest('/api/feedback/weblog', { logs: JSON.stringify([entry]) },
      { crypto: 'eapi', cookie: osxCookie, realIP: '116.25.146.177', domain: 'https://clientlog.music.163.com' });
    return r.body;
  } catch (e) {
    // request() rejects with the answer object { status, body } on non-200.
    return e?.body || { code: 520, data: String(e?.message || e) };
  }
});

ipcMain.handle('hide-window', () => {
  if (win && !win.isDestroyed()) win.hide();
});

ipcMain.handle('set-window-bg', (_, color) => {
  if (win && !win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(color || '')) {
    win.setBackgroundColor(color);
  }
});

// Ask — the renderer sends a Responses API body (instructions, input, text
// format); the key and endpoint stay here. See lib/llm.js.
ipcMain.handle('llm-available', () => llm.available());
ipcMain.handle('llm-respond', (_, body) => llm.respond(body));

ipcMain.handle('copy-text', (_, text) => { clipboard.writeText(String(text || '')); });

// The menu bar: the ✻ spark, solid while playing and dimmed when paused,
// turning once when the track changes; beside it the song's title (the
// renderer decides the text and whether to show any — ui/ambient.js).
const trayImages = {};
function trayImage(name) {
  if (!trayImages[name]) {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`));
    img.setTemplateImage(true);
    trayImages[name] = img;
  }
  return trayImages[name];
}
let trayTrackId = null;
let traySpin = null;
function spinTray(rest) {
  clearInterval(traySpin);
  let frame = 1;
  traySpin = setInterval(() => {
    if (!tray || tray.isDestroyed?.()) { clearInterval(traySpin); traySpin = null; return; }
    if (frame <= 5) tray.setImage(trayImage(`traySpin${frame}Template`));
    else { clearInterval(traySpin); traySpin = null; tray.setImage(trayImage(rest)); }
    frame++;
  }, 70);
}
ipcMain.handle('tray-state', (_, { title = '', playing = false, trackId = null } = {}) => {
  if (!tray || tray.isDestroyed?.()) return;
  tray.setTitle(String(title).slice(0, 64), { fontType: 'monospacedDigit' });
  const rest = playing ? 'trayTemplate' : 'trayPausedTemplate';
  const changed = trackId && trayTrackId && trackId !== trayTrackId;
  trayTrackId = trackId || trayTrackId;
  if (changed && playing) spinTray(rest);
  else if (!traySpin) tray.setImage(trayImage(rest));
});

ipcMain.handle('resize-window', (_, w, h) => {
  if (!win || win.isDestroyed()) return;
  const [curW, curH] = win.getSize();
  if (curW === w && curH === h) return;
  // animate=false: the native resize tween would briefly expose the window's
  // background color at the growing edge (the "black strip" on summon). The
  // content's own CSS transitions carry the visual, so snap the frame.
  win.setSize(w, h, false);
});

// The native window backgroundColor must match the panel's theme background —
// otherwise the panel's fade-in/out (and any resize) reveals a mismatched
// color at/through it (the "grey/black flash" on summon in light mode).
function themeBg() {
  try {
    const a = store?.get('ui-prefs')?.appearance || {};
    // The renderer persists the resolved panel bg (theme × scheme); fall back
    // to the default theme's colours for a first launch / stale prefs.
    if (/^#[0-9a-f]{6}$/i.test(a.bg || '')) return a.bg;
    return a.scheme === 'light' ? '#faf9f5' : '#262624';
  } catch { return '#262624'; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 480,
    minWidth: 520,
    minHeight: 120,
    backgroundColor: themeBg(),
    titleBarStyle: 'customButtonsOnHover',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Summon on the Space you're on — a desktop or another app's full-screen
  // Space — instead of macOS switching you to the Space the window was last
  // shown on (after one summon over a full-screen app, every later ⌥Space
  // from elsewhere dragged you back there). The window hides on blur, so
  // "on every Space" only ever means "on the Space you summoned it from".
  // skipTransformProcessType: we're already an LSUIElement app.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Dev/test runs (an agent driving the app over CDP, say): MUSEV2_SILENT=1
  // keeps everything working but mutes the output.
  if (process.env.MUSEV2_SILENT) win.webContents.setAudioMuted(true);

  // Closing the window (red traffic light, ⌘W) hides it instead of destroying
  // it — playback + state live in the renderer, so we keep it alive in the
  // background. Option+Space brings it back instantly. Real quit goes through
  // app.isQuitting (tray "Quit" / ⌘Q).
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });

  // A summon surface gets out of the way the moment you look elsewhere —
  // clicking another app is the same gesture as Esc.
  win.on('blur', () => {
    if (!app.isQuitting && win.isVisible() && !win.webContents.isDevToolsFocused()) win.hide();
  });
}

function showCommandSurface() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  // Don't resize/center — respect the user's current window placement.
  win.show();
  win.focus();
  win.webContents.send('open-command-surface');
  win.webContents.send('window-appear');
}

function registerShortcuts() {
  // Option+Space is fast to hit and rarely conflicts (Spotlight is Cmd+Space,
  // Raycast is typically Cmd+Space or Ctrl+Space, Alfred is Cmd+Space).
  // Cmd+Shift+Space kept as a fallback for keyboards where Option is awkward.
  for (const key of ['Alt+Space', 'CommandOrControl+Shift+Space']) {
    const ok = globalShortcut.register(key, showCommandSurface);
    if (ok) console.log(`[muse] global shortcut registered: ${key}`);
    else console.warn(`[muse] global shortcut failed: ${key}`);
  }
}

// Build a minimal application menu — without this Electron generates a
// default one whose first label is hardcoded to "Electron" (ignoring
// app.setName). role:'appMenu' reads `app.getName()` at build time, so the
// first menu now reads "MuseV2". editMenu is included so ⌘C/⌘V/⌘A work in
// the cmdk input and login field.
function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function buildTray() {
  try {
    const img = nativeImage.createFromPath(TRAY_PATH);
    img.setTemplateImage(true);   // macOS tints for light/dark menu bar
    tray = new Tray(img);
    tray.setToolTip('MuseV2');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show MuseV2', accelerator: 'Alt+Space', click: showCommandSurface },
      { type: 'separator' },
      { label: 'Quit MuseV2', accelerator: 'Command+Q', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    // Left-click the tray icon → summon (right-click shows the menu).
    tray.on('click', showCommandSurface);
  } catch (e) { console.warn('[muse] tray init failed', e?.message || e); }
}

app.whenReady().then(async () => {
  installAppMenu();
  // Hide from the dock — muse lives in the menu bar + Option+Space, like
  // Raycast. The Tray (built below) is the only persistent visible entry.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  if (!gotLock) return;   // another MuseV2 has it (see requestSingleInstanceLock)
  thumbs.serve(protocol, app.getPath('userData'));

  try {
    store = new Store(path.join(app.getPath('userData'), 'data'));
    await startNcmApi();
    await startNowServer();
  } catch (e) {
    // Port collision with something that isn't muse, missing package, or
    // unwritable userData. Surface visibly — silent start is worse than a
    // clear error since the UI would appear functional but hit "fetch
    // failed" everywhere.
    console.error('[muse] startup failed', e);
    dialog.showErrorBox('MuseV2 启动失败', (e?.message || String(e)) +
      `\n\n常见原因：${NCM_PORT} 或 ${NOW_PORTS.join('/')} 端口被其他程序占用，或 userData 目录不可写。`);
    app.quit();
    return;
  }
  createWindow();
  buildTray();
  registerShortcuts();
});

// macOS: clicking the dock icon after closing the window should reopen it.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Flush any pending store writes before exit. Synchronous by design so the
// process doesn't terminate before bytes hit disk.
app.on('before-quit', () => { app.isQuitting = true; try { store?.flush(); } catch {} });
app.on('will-quit',   () => { try { globalShortcut.unregisterAll(); } catch {}; try { store?.flush(); } catch {}; try { spectrumWss?.close(); } catch {}; try { nowServer?.close(); } catch {} });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
