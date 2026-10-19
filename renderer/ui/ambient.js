// Ambient — MuseV2 being present when you haven't summoned it.
//
//  · The menu bar: the ✻ spark (solid playing, dimmed paused, a quick turn on
//    a track change, turning on while the DJ is thinking — main.js) and the
//    song's title beside it. The title is off with /appearance → Song in the
//    menu bar; the spark always shows.
//  · The spark: the composer's ✻ breathes with the music — the spectrum's
//    loudness, smoothed, lands in --level on the panel and the themes that
//    want it (claude, muse) scale the mark by it.
//  · The system: navigator.mediaSession — the keyboard's ⏯ ⏭ keys, AirPods
//    taps, and Control Center's Now Playing (cover, title, a scrubbable
//    position, ⏮ ⏭).

import { store } from '../store.js';
import * as player from '../player.js';
import * as dj from '../lib/dj.js';

const TITLE_MAX = 24;
let panelEl = null;
let level = 0;
let bassMean = 0;
let bassDev = 0.02;
let lastWritten = -1;

export function mountAmbient(panel) {
  panelEl = panel;
  mountMediaSession();

  const pushTray = (s = store.get()) => {
    const t = s.player.track;
    window.muse.setTrayState?.({
      title: s.appearance.menuBar && t?.name ? clip(t.name, TITLE_MAX) : '',
      playing: !!s.player.playing,
      trackId: t?.id ?? null,
      thinking: dj.pending().length > 0,
    });
  };
  store.selectKey((s) => `${s.player.track?.id ?? 0}|${s.player.playing}|${s.appearance.menuBar}`, pushTray);
  dj.onPending(() => pushTray());

  // ~30 frames a second while playing. The spectrum's absolute loudness
  // barely moves (rms sits in a narrow 0.65–0.78 band on real music), so the
  // spark follows the *bass relative to its own recent average* — it jumps
  // on a kick and settles between them, whatever the track's level. Fast
  // attack, slower release.
  player.onLevel((rms, bands) => {
    if (!bands) { level = 0; bassMean = 0; bassDev = 0.02; }
    else {
      const bass = (bands[0] + bands[1] + bands[2] + bands[3]) / 4;
      if (!bassMean) bassMean = bass;
      bassMean += (bass - bassMean) * 0.04;
      bassDev += (Math.abs(bass - bassMean) - bassDev) * 0.04;
      const target = Math.max(0, Math.min(1, 0.15 + (bass - bassMean) / (3 * Math.max(bassDev, 0.008))));
      level += (target - level) * (target > level ? 0.6 : 0.2);
    }
    if (document.hidden) return;
    const v = Math.round(level * 100) / 100;
    if (v === lastWritten) return;
    lastWritten = v;
    panelEl.style.setProperty('--level', String(v));
  });
}

// ---- Now Playing / media keys --------------------------------------------------

function mountMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms || typeof MediaMetadata === 'undefined') return;
  const handlers = {
    play: () => player.play(),
    pause: () => player.pause(),
    previoustrack: () => player.prev(),
    nexttrack: () => player.next(),
    seekbackward: (d) => seekBy(-(d?.seekOffset || 10)),
    seekforward: (d) => seekBy(d?.seekOffset || 10),
    seekto: (d) => { if (Number.isFinite(d?.seekTime)) player.seek(d.seekTime); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }

  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${s.player.track?.al?.picUrl ?? ''}`,
    (s) => {
      const t = s.player.track;
      if (!t) { ms.metadata = null; return; }
      // The system fetches artwork itself, so give it the CDN (it can't see
      // our muse-thumb scheme); 512px is what Control Center draws.
      const art = t.al?.picUrl ? t.al.picUrl.replace(/^http:/, 'https:') : '';
      ms.metadata = new MediaMetadata({
        title: t.name || '',
        artist: (t.ar || []).map((a) => a.name).join(', '),
        album: t.al?.name || '',
        artwork: art ? [{ src: `${art}?param=512y512`, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    }
  );
  store.select((s) => !!s.player.playing, (playing) => { ms.playbackState = playing ? 'playing' : 'paused'; });
  // Position for the Now Playing scrubber — once a second is plenty, the
  // system extrapolates from playbackRate in between.
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${Math.floor(s.player.currentTime)}|${Math.floor(s.player.duration)}`,
    (s) => {
      const { duration, currentTime } = s.player;
      if (!duration || !Number.isFinite(duration)) return;
      try { ms.setPositionState({ duration, playbackRate: 1, position: Math.min(currentTime || 0, duration) }); } catch {}
    }
  );
}

function seekBy(sec) {
  const { currentTime, duration } = store.get().player;
  if (!duration) return;
  player.seek(Math.max(0, Math.min(duration - 0.5, (currentTime || 0) + sec)));
}

function clip(s, n) {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : s;
}
