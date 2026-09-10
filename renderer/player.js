// Owns the single <audio> element. Pushes state into the store on every tick
// and forwards a snapshot to main (over IPC) so echo' /now endpoint
// stays current. Modes drive the queue via `setQueue()`; single-track loop is
// a separate flag so we don't conflate "loop one" with "loop queue".

import { store } from './store.js';
import { api, ApiError } from './api.js';
import { extendQueueForCurrentSession, shouldLoopQueueAtEnd } from './modes/session.js';

const audio = new Audio();
audio.preload = 'auto';

// Legacy escape hatch. Normal end-of-queue behavior is session-driven: modes
// extend, playlists repeat, manual one-offs stop.
let queueLoop = false;
// Repeat-one. We loop manually (in the 'ended' handler) rather than via the
// native audio.loop property, so every repeat fires 'ended' and gets counted
// + scrobbled instead of looping silently forever.
let singleLoop = false;

// ---- Current-track cache ----------------------------------------------------
// NetEase stream URLs expire after ~20 min. The <audio> element only buffers
// a slice, so resuming after a long pause used to mean: re-fetch the URL,
// reload, seek back — a visible stall. Instead we keep exactly ONE track in
// memory as a Blob: the one that's playing. It is fetched in the background
// shortly after playback starts (so it never competes with the first
// buffering), survives across pauses regardless of URL expiry, and is dropped
// the moment a *different* track starts. Same track again (loop, re-pick from
// search) keeps it — and plays from it instantly, no URL request at all.
//
// One song at standard quality is ~4–10 MB; Chromium may page a Blob to disk
// on its own, but nothing is written by us, so there is no cache to clean up.

const CACHE_DELAY_MS = 1500;
let cache = { id: null, url: null, ctrl: null, size: 0 };
let cacheTimer = null;
let srcIsBlob = false;              // the element currently plays from `cache.url`

function cacheReadyFor(id) { return cache.id === id && !!cache.url; }

function dropCache() {
  clearTimeout(cacheTimer);
  cache.ctrl?.abort();
  if (cache.url) URL.revokeObjectURL(cache.url);
  cache = { id: null, url: null, ctrl: null, size: 0 };
}

// Schedule a background fetch of `url` for `track`. No-op if that track is
// already cached or being cached.
function cacheTrack(track, url) {
  if (cache.id === track.id) return;          // same track: keep what we have
  dropCache();
  const ctrl = new AbortController();
  cache = { id: track.id, url: null, ctrl, size: 0 };
  cacheTimer = setTimeout(async () => {
    if (cache.ctrl !== ctrl) return;
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (cache.ctrl !== ctrl) return;        // superseded while downloading
      cache.url = URL.createObjectURL(blob);
      cache.size = blob.size;
      console.info('[cache] ready', track.name, `${(blob.size / 1048576).toFixed(1)} MB`);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('[cache] failed', track.name, e?.message || e);
      if (cache.ctrl === ctrl) cache = { id: null, url: null, ctrl: null, size: 0 };
    }
  }, CACHE_DELAY_MS);
}

export function cacheInfo() {
  return { id: cache.id, ready: !!cache.url, size: cache.size, srcIsBlob };
}

// ---- Optimistic switch ------------------------------------------------------
// cmdk lands on the keypress, but building the queue for a picked track can
// take seconds (mode rebuilds hit the network). Stage the track in the store
// right away so the hero shows it immediately; playTrack() replaces the
// snapshot when the real switch happens, unstage() restores it on failure.
// The <audio> element is untouched (loadedTrackId still gates its events).

let staged = null;                  // previous player snapshot while a stage is pending

export function stageTrack(track) {
  if (!track || staged) return;
  const cur = store.get().player;
  if (cur.track?.id === track.id) return;
  staged = cur;
  store.set((s) => ({ ...s, player: { ...s.player, track, currentTime: 0, duration: track.dt ? track.dt / 1000 : 0 } }));
}

export function unstage() {
  if (!staged) return;
  const prev = staged; staged = null;
  // Only roll back if nothing else has moved the player since.
  if (store.get().player.track?.id !== prev.track?.id) store.set((s) => ({ ...s, player: prev }));
}

// ---- Public actions ---------------------------------------------------------

export async function playTrack(track, queue = null, queueIdx = -1) {
  if (!track || typeof track.id !== 'number') throw new TypeError('playTrack: track.id required');
  const q = queue || [track];
  const idx = queueIdx >= 0 ? queueIdx : q.findIndex((t) => t.id === track.id);

  const ok = store.race('player');
  // A staged (optimistic) track is being made real now: the rollback point is
  // the snapshot from *before* staging, not the staged one.
  const prevSnapshot = staged || store.get().player;
  staged = null;

  // Scrobble the previous track before we overwrite state. Safe to call even
  // if nothing is loaded yet (no-op when scrobbleTrack is null).
  maybeScrobble();
  resetScrobble(track);

  // Reset position/duration with the new track. Play tracking (library.js)
  // watches currentTime ≥ 30s; leaving the previous track's value in place
  // made a quick skip look like an instant 30s listen and logged phantom plays.
  store.set((s) => ({ ...s, player: { ...s.player, track, queue: q, queueIdx: idx, currentTime: 0, duration: track.dt ? track.dt / 1000 : 0 } }));

  // Same track again and we hold it in memory: no URL round-trip at all.
  if (cacheReadyFor(track.id)) {
    audio.src = cache.url;
    srcIsBlob = true;
    loadedTrackId = track.id;
    urlIssuedAt = Date.now();
    pushPlayerState();
    try { await audio.play(); }
    catch (e) { console.warn('audio.play() (cached)', e); }
    return;
  }

  let url;
  try {
    // Tight timeouts here because the user is actively waiting on this fetch.
    // Default (15s × 4 attempts) is fine for background calls but feels frozen
    // during a track switch — cap worst case at ~16s so playFromQueue's skip
    // fallback kicks in before the user gives up and clicks something else.
    const r = await api('/song/url/v1', { id: track.id, level: 'standard' },
      { timeout: 5_000, retry: { attempts: 2, baseDelayMs: 250 } });
    url = r?.data?.[0]?.url;
  } catch (e) {
    if (!ok()) return;
    store.set((s) => ({ ...s, player: prevSnapshot }));
    throw e;
  }

  if (!ok()) return;

  if (!url) {
    store.set((s) => ({ ...s, player: prevSnapshot }));
    throw new ApiError('unavailable or no license', { path: '/song/url/v1' });
  }

  audio.src = url;
  srcIsBlob = false;
  loadedTrackId = track.id;
  urlIssuedAt = Date.now();
  cacheTrack(track, url);
  // Push meta now — lyrics can show the title immediately instead of waiting
  // for the first timeupdate after audio actually starts.
  pushPlayerState();
  try { await audio.play(); }
  catch (e) { console.warn('audio.play()', e); }
}

// ---- Resume after idle ------------------------------------------------------
// NetEase media URLs expire (expi ≈ 1200s → HTTP 403 afterwards). Chromium
// only buffers part of the file, so resuming a track that sat paused for
// >20 min issues a Range request against a dead URL: play() rejects or the
// element throws MEDIA_ERR_NETWORK and ⌘P looks like it does nothing. We
// track when the URL was issued and re-fetch it (keeping the position)
// before resuming — and do the same once if the element already errored.

const URL_TTL_MS = 15 * 60 * 1000;   // refresh well before the 20-min expiry
let urlIssuedAt = 0;
// Which track the <audio> element is actually loaded with. During a switch the
// store already points at the new track while the URL is still being fetched
// and the OLD track keeps playing — its timeupdate/loadedmetadata events must
// not be attributed to the new one (play tracking watches store.currentTime).
let loadedTrackId = null;
let reloading = null;                // in-flight reload promise (dedupe)

function urlStale() {
  if (audio.error) return true;
  if (srcIsBlob) return false;                 // a Blob never expires
  return urlIssuedAt > 0 && Date.now() - urlIssuedAt > URL_TTL_MS;
}

// Re-fetch the current track's URL and restore playback position. Resolves
// true on success. Safe to call concurrently — callers share one attempt.
async function reloadCurrent({ autoplay }) {
  if (reloading) return reloading;
  reloading = (async () => {
    const track = store.get().player.track;
    if (!track) return false;
    commitSegment();
    const pos = audio.currentTime || 0;
    // Preferred path: the track is in memory — swap to the Blob, no network.
    const fromCache = cacheReadyFor(track.id) && !srcIsBlob;
    let url;
    if (fromCache) {
      url = cache.url;
    } else {
      try {
        const r = await api('/song/url/v1', { id: track.id, level: 'standard' },
          { timeout: 5_000, retry: { attempts: 2, baseDelayMs: 250 } });
        url = r?.data?.[0]?.url;
      } catch (e) {
        console.warn('[player] reload url failed', e?.message || e);
        return false;
      }
    }
    if (!url || store.get().player.track?.id !== track.id) return false;
    const ready = new Promise((resolve) => {
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
    });
    audio.src = url;
    srcIsBlob = fromCache;
    loadedTrackId = track.id;
    urlIssuedAt = Date.now();
    if (!fromCache) cacheTrack(track, url);
    await ready;
    if (audio.error) return false;
    if (pos > 0 && pos < (audio.duration || Infinity)) audio.currentTime = pos;
    console.info(fromCache ? '[player] resumed from cache' : '[player] reloaded url', track.name, `at ${Math.round(pos)}s`);
    if (autoplay) { try { await audio.play(); } catch (e) { console.warn('audio.play() after reload', e); return false; } }
    return true;
  })().finally(() => { reloading = null; });
  return reloading;
}

async function resume() {
  if (!store.get().player.track) return;
  if (urlStale()) { await reloadCurrent({ autoplay: true }); return; }
  try { await audio.play(); }
  catch (e) {
    // AbortError = a newer load interrupted us; anything else (network,
    // decode) is worth one reload before giving up.
    if (e?.name === 'AbortError') return;
    console.warn('[player] play() failed, reloading', e?.message || e);
    await reloadCurrent({ autoplay: true });
  }
}

// Replace the queue and start playing. Used by radio modes on activation.
// `startIdx` defaults to 0. If queue is empty, clears the player.
export function setQueue(tracks, { startIdx = 0 } = {}) {
  if (!Array.isArray(tracks)) throw new TypeError('setQueue: tracks must be an array');
  // Clear single-loop carryover. Without this, leaving 'single' mode by
  // picking a song in cmdk would silently inherit the loop flag and the new
  // song would repeat forever. Modes that want loop call setLoop(true) AFTER
  // setQueue (see app.js activateMode()).
  singleLoop = false;
  if (!tracks.length) {
    store.set((s) => ({ ...s, player: { ...s.player, queue: [], queueIdx: -1 } }));
    return;
  }
  const idx = Math.max(0, Math.min(startIdx, tracks.length - 1));
  const target = tracks[idx];
  // If the target is already playing, just attach the new queue without
  // reloading audio — matters most for single-loop activation so the current
  // track doesn't restart from 0s just because the user picked the mode.
  // Compare against what the <audio> element actually holds, not the store:
  // a staged (optimistic) track is in the store before it plays.
  if (loadedTrackId === target.id && !audio.paused) {
    store.set((s) => ({ ...s, player: { ...s.player, queue: tracks, queueIdx: idx } }));
    return;
  }
  if (tracks.length > 1) return playFromQueue(tracks, idx, 1, { allowLoop: true });
  return playTrack(target, tracks, idx);
}

export function setLoop(single) {
  // Manual loop (not audio.loop): the native property restarts the element
  // WITHOUT firing 'ended', which would skip both the scrobble and the
  // per-round history record. We re-loop in the 'ended' handler instead so a
  // track on repeat is counted every round, like the official client.
  singleLoop = !!single;
}
export function setQueueLoop(flag) { queueLoop = !!flag; }

export function toggle() { if (audio.paused) resume(); else audio.pause(); }
export function pause()  { audio.pause(); }
export function play()   { resume(); }

export function seek(t) {
  const dur = audio.duration;
  if (!Number.isFinite(t)) return;
  audio.currentTime = Math.max(0, Math.min(t, dur || t));
}

export function next() {
  const { queue, queueIdx } = store.get().player;
  if (!queue.length) return;
  if (queueIdx + 1 < queue.length) {
    playFromQueue(queue, queueIdx + 1, 1, { allowLoop: false }).catch(swallowExpected);
  } else {
    playNextFromSession(queue).catch(swallowExpected);
  }
}

export function prev() {
  const { queue, queueIdx } = store.get().player;
  if (queueIdx > 0) playFromQueue(queue, queueIdx - 1, -1, { allowLoop: false }).catch(swallowExpected);
  else seek(0);
}

// Jump directly to the given queue index (used by the cmdk /queue view). If
// the target is unavailable, playFromQueue's own skip logic advances forward
// to find something playable — matches user expectation of "play from here".
export function playAt(idx) {
  const { queue } = store.get().player;
  if (!queue.length || idx < 0 || idx >= queue.length) return;
  playFromQueue(queue, idx, 1, { allowLoop: false }).catch(swallowExpected);
}

async function playNextFromSession(queue) {
  const extra = await extendQueueForCurrentSession();
  if (extra.length) {
    const nextQueue = [...queue, ...extra];
    store.set((s) => ({ ...s, player: { ...s.player, queue: nextQueue } }));
    return playFromQueue(nextQueue, queue.length, 1, { allowLoop: false });
  }
  if (queueLoop || shouldLoopQueueAtEnd()) {
    return playFromQueue(queue, 0, 1, { allowLoop: true });
  }
  patch({ playing: false, currentTime: audio.currentTime || audio.duration || 0 });
  pushPlayerState();
}

async function playFromQueue(queue, startIdx, step, { allowLoop }) {
  const tried = new Set();
  let idx = startIdx;
  let lastErr = null;

  while (idx >= 0 && idx < queue.length && !tried.has(idx)) {
    tried.add(idx);
    try {
      return await playTrack(queue[idx], queue, idx);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ApiError)) throw e;
      console.warn('[player] skip unavailable', queue[idx]?.name || queue[idx]?.id, e.message);
    }

    idx += step;
    if (allowLoop) {
      if (idx >= queue.length) idx = 0;
      if (idx < 0) idx = queue.length - 1;
    }
  }

  if (lastErr) throw lastErr;
}

function swallowExpected(e) {
  if (e instanceof ApiError) console.warn('[player]', e.message);
  else throw e;
}

// Subscribers notified when a track finishes naturally (not via user skip).
// Modes use this to track per-song play counts + append more tracks on
// exhaustion (for modes with async `extend()` hooks, future).
const endHandlers = new Set();
export function onEnded(fn) { endHandlers.add(fn); return () => endHandlers.delete(fn); }

// ---- Scrobble (NetEase listen history) --------------------------------------
// We accumulate played seconds per track across play/pause segments. On track
// change or natural end we report the play (via window.muse.scrobble) if it was
// actually listened to — NetEase's own client uses a similar "played enough"
// gate; we copy the common Last.fm-style rule (>=30s OR >=50% of duration).

let segmentStart = -1;   // audio.currentTime at last 'play' event, -1 if paused
let accumPlayed = 0;     // seconds played so far for the current track
let scrobbled = false;   // guard against double-scrobbling same track
let scrobbleTrack = null; // snapshot of the track being accumulated

function commitSegment() {
  if (segmentStart >= 0) {
    accumPlayed += Math.max(0, audio.currentTime - segmentStart);
    segmentStart = -1;
  }
}

function resetScrobble(track) {
  accumPlayed = 0;
  segmentStart = -1;
  scrobbled = false;
  scrobbleTrack = track || null;
}

function maybeScrobble() {
  commitSegment();
  if (scrobbled || !scrobbleTrack) return;
  const dur = scrobbleTrack.dt ? scrobbleTrack.dt / 1000 : (audio.duration || 0);
  if (accumPlayed < 30 && (dur === 0 || accumPlayed < dur * 0.5)) return;
  scrobbled = true;
  // Every play needs a sourceId (NetEase attributes each play to a list /
  // album / radio). muse is 红心-centric, so we use the 我喜欢 playlist as the
  // source for ALL plays — including cmdk cloud-search tracks not yet in 红心.
  // The server accepts that, and the user wants every play in their history.
  const { likedPlaylistId } = store.get().library;
  if (!likedPlaylistId) {
    console.info('[player] scrobble skipped · liked playlist not loaded yet');
    return;
  }
  const id = scrobbleTrack.id;
  const name = scrobbleTrack.name;
  const time = Math.floor(accumPlayed);
  // startplay → 最近播放 list; playend (with elapsed time) → 听歌排行 count.
  // Send both, in order — see main.js scrobble handler for channel details.
  window.muse.scrobble({ action: 'startplay', id, sourceId: likedPlaylistId })
    .then(() => window.muse.scrobble({ action: 'playend', id, sourceId: likedPlaylistId, time }))
    .then((r) => console.info('[player] scrobbled', name, `sourceid=${likedPlaylistId} t=${time}s`, r?.data ?? ''))
    .catch((e) => console.warn('[player] scrobble failed', e?.message || e));
}

// ---- Audio → store wiring ---------------------------------------------------

audio.addEventListener('play', () => {
  segmentStart = audio.currentTime;
  patch({ playing: true });
  pushPlayerState();
});
audio.addEventListener('pause', () => {
  commitSegment();
  patch({ playing: false });
  pushPlayerState();
});
audio.addEventListener('ended', () => {
  // Notify mode subscribers first (they may want to extend the queue), then
  // scrobble the play we just finished.
  for (const fn of endHandlers) { try { fn(); } catch (e) { console.error(e); } }
  maybeScrobble();
  if (singleLoop) {
    // Repeat-one: replay the same track and reset the scrobble accumulator so
    // the next round is reported as its own play (startplay + playend again).
    resetScrobble(store.get().player.track);
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  next();
});
// Guard for element events: drop them while the element still holds the
// previous track (see loadedTrackId).
function elementIsCurrent() {
  return store.get().player.track?.id === loadedTrackId;
}

audio.addEventListener('loadedmetadata', () => {
  if (!elementIsCurrent()) return;
  patch({ duration: audio.duration || 0 });
  pushPlayerState();
});
audio.addEventListener('error', () => {
  const wasPlaying = store.get().player.playing;
  patch({ playing: false });
  console.warn('[player] audio error', audio.error?.code, audio.error?.message);
  // Mid-playback network failure (typically the URL expiring under a long
  // track, or a dropped connection): re-fetch once and pick up where we were.
  // Only when we were actually playing — a stale paused element gets fixed
  // lazily by resume() so we don't hammer NCM for tracks nobody asked for.
  const code = audio.error?.code;
  if (wasPlaying && !reloading && (code === MediaError.MEDIA_ERR_NETWORK || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)) {
    reloadCurrent({ autoplay: true }).catch(() => {});
  }
});

// timeupdate fires ~4Hz while playing, never while paused — perfect single
// source of truth for forwarding state to echo's /now. Throttle
// keeps us at 4Hz even if the browser speeds up.
let lastPushed = 0;
audio.addEventListener('timeupdate', () => {
  if (!elementIsCurrent()) return;
  const now = performance.now();
  if (now - lastPushed < 240) return;
  lastPushed = now;
  patch({ currentTime: audio.currentTime || 0 });
  pushPlayerState();
});

function patch(partial) {
  store.set((s) => ({ ...s, player: { ...s.player, ...partial } }));
}

// ---- Player → main IPC (so echo's /now stays accurate) -----------
// No setInterval here — pushPlayerState() is called from the audio events
// above (play/pause/timeupdate/loadedmetadata) and from playTrack once the
// new track is in the store. That covers every moment echo would
// want an update, without burning CPU while paused.

function pushPlayerState() {
  const { track } = store.get().player;
  if (!track) return;
  window.muse.sendPlayerState({
    title: track.name,
    artist: (track.ar || []).map((a) => a.name).join(', '),
    album: track.al?.name || '',
    cover: track.al?.picUrl || '',
    songId: track.id,
    duration: audio.duration || 0,
    currentTime: audio.currentTime || 0,
    playing: !audio.paused,
  });
}

// ---- Spectrum broadcast -----------------------------------------------------
// Wire-format doc: ./NOW_PLAYING.md §Spectrum channel (v1.2).
// Contract: 24 log-spaced bands, 60Hz–12kHz, sqrt-perceptual, ~30fps, paused
// means silence (no frames — consumer fades out on its own).

const BAND_COUNT = 24;
const SAMPLE_HZ = 30;
const FMIN = 60;
const FMAX = 12000;

let ac = null;
let analyser = null;
let freqBuf = null;        // Uint8Array, reused across frames
let bandEdges = null;      // Int32Array of length BAND_COUNT+1, bin indices
let spectrumTimer = null;

// Deferred so createMediaElementSource runs once and only when we actually
// need the graph. Also: AudioContext construction before a user gesture is
// allowed on Electron, but entering running state requires resume() after a
// play gesture — we hook that in the 'play' listener below.
function ensureAnalyser() {
  if (analyser) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  ac = new Ctx();
  const src = ac.createMediaElementSource(audio);
  analyser = ac.createAnalyser();
  analyser.fftSize = 512;                // → 256 frequency bins
  analyser.smoothingTimeConstant = 0.78; // empirical — stable visuals w/o mud
  src.connect(analyser);
  // CRITICAL: createMediaElementSource rewires the element's default output;
  // if this edge is missing, the user hears nothing the moment the graph
  // activates. Keep it.
  analyser.connect(ac.destination);
  freqBuf = new Uint8Array(analyser.frequencyBinCount);
  bandEdges = buildLogBandEdges(ac.sampleRate, analyser.frequencyBinCount);
}

// Compute once per AudioContext: log-spaced band boundaries as bin indices.
// Even spacing crushes everything below ~300Hz into bin 0 and leaves the top
// half of the strip empty — hearing and music are both log-frequency.
function buildLogBandEdges(sampleRate, binCount) {
  const nyquist = sampleRate / 2;
  const edges = new Int32Array(BAND_COUNT + 1);
  for (let i = 0; i <= BAND_COUNT; i++) {
    const f = FMIN * Math.pow(FMAX / FMIN, i / BAND_COUNT);
    let bin = Math.round((f / nyquist) * binCount);
    if (bin < 0) bin = 0;
    if (bin > binCount) bin = binCount;
    edges[i] = bin;
  }
  // Ensure every band owns at least one bin (low bands can collide at small
  // fftSize × high sampleRate); a zero-width band would always read 0.
  for (let i = 1; i <= BAND_COUNT; i++) {
    if (edges[i] <= edges[i - 1]) edges[i] = Math.min(edges[i - 1] + 1, binCount);
  }
  return edges;
}

function sampleSpectrum() {
  if (!analyser || audio.paused) return;
  analyser.getByteFrequencyData(freqBuf);
  const bands = new Array(BAND_COUNT);
  let sumSq = 0;
  let totalN = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    const lo = bandEdges[b];
    const hi = bandEdges[b + 1];
    let acc = 0;
    for (let j = lo; j < hi; j++) acc += freqBuf[j];
    const mean = acc / Math.max(1, hi - lo);
    // byte → [0,1] then sqrt: the raw byte distribution clusters around
    // 20–80 during normal music; without the perceptual curve the top 2/3
    // of the [0,1] range is dead and the consumer's visuals barely move.
    const norm = Math.sqrt(mean / 255);
    bands[b] = norm;
    sumSq += mean * mean;
    totalN += 1;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, totalN)) / 255;
  window.muse.sendSpectrum({ t: Date.now(), bands, rms });
}

function startSpectrumLoop() {
  if (spectrumTimer) return;
  spectrumTimer = setInterval(sampleSpectrum, Math.round(1000 / SAMPLE_HZ));
}

function stopSpectrumLoop() {
  if (!spectrumTimer) return;
  clearInterval(spectrumTimer);
  spectrumTimer = null;
}

// Build the graph + resume the AudioContext from inside the play event —
// 'play' fires synchronously off the user gesture that triggered audio.play(),
// so autoplay policy is satisfied here even though playTrack itself is async.
audio.addEventListener('play', () => {
  try {
    ensureAnalyser();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
  } catch (e) {
    console.warn('[player] analyser init failed', e);
  }
  startSpectrumLoop();
});
audio.addEventListener('pause', stopSpectrumLoop);
audio.addEventListener('ended', stopSpectrumLoop);
