// Ambient — MuseV2 being present when you haven't summoned it.
//
//  · The menu bar: the playing song's title beside the tray icon, with the ✻
//    while it plays ("✻ 夜に駆ける"). Off with /appearance → Song in the
//    menu bar.
//  · The spark: the composer's ✻ breathes with the music — the spectrum's
//    loudness, smoothed, lands in --level on the panel and the themes that
//    want it (claude, muse) scale the mark by it.

import { store } from '../store.js';
import * as player from '../player.js';

const TITLE_MAX = 24;
let panelEl = null;
let level = 0;
let bassMean = 0;
let bassDev = 0.02;
let lastWritten = -1;

export function mountAmbient(panel) {
  panelEl = panel;

  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${s.player.playing}|${s.appearance.menuBar}`,
    (s) => {
      const t = s.player.track;
      const text = s.appearance.menuBar && t?.name
        ? `${s.player.playing ? '✻ ' : ''}${clip(t.name, TITLE_MAX)}`
        : '';
      window.muse.setTrayTitle?.(text);
    }
  );

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

function clip(s, n) {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : s;
}
