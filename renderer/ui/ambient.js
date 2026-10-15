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

  // ~30 frames a second while playing; a fast attack and a slower release so
  // the spark jumps with a beat and settles between them.
  player.onLevel((rms) => {
    const target = Math.min(1, rms * 2.2);
    level += (target - level) * (target > level ? 0.55 : 0.18);
    if (rms === 0) level = 0;
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
