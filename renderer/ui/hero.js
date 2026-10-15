// The now-playing area: the hero at home (big cover, serif title, progress)
// and the compact strip above the composer while searching — the same DOM,
// morphed by `.idle` on the panel. When nothing is playing, the greeting
// ("✻ Evening, finn") takes its place.

import { store } from '../store.js';
import * as accent from '../accent.js';
import * as tx from '../transitions.js';
import { formatArtists } from '../commands.js';
import * as memory from '../lib/memory.js';

let nowEl, coverEl, metaEl, titleEl, artistEl, timeEl, progressEl, contextEl;
let greetingEl, greetingTextEl, greetingSubEl;
let lastNowCover = '';
let lastRenderedTrackId = null;

export function mountHero(root) {
  nowEl          = root.querySelector('[data-role=now]');
  metaEl         = root.querySelector('.cmdk-now__meta');
  coverEl        = root.querySelector('[data-role=now-cover]');
  titleEl        = root.querySelector('[data-role=now-title]');
  artistEl       = root.querySelector('[data-role=now-artist]');
  timeEl         = root.querySelector('[data-role=now-time]');
  progressEl     = root.querySelector('[data-role=now-progress]');
  greetingEl     = root.querySelector('[data-role=greeting]');
  greetingTextEl = root.querySelector('[data-role=greeting-text]');
  greetingSubEl  = root.querySelector('[data-role=greeting-sub]');
  contextEl      = root.querySelector('[data-role=now-context]');

  tx.initCoverTilt(coverEl);
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${Math.floor(s.player.currentTime)}|${Math.floor(s.player.duration)}`,
    renderNow
  );
  store.select((s) => s.user?.nickname ?? '', () => renderGreeting());
  // The song's story changes when it's liked / unliked, not just per track.
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${s.library.tracks.length}`,
    (s) => { if (s.player.track) renderContext(s.player.track); }
  );
}

// The pieces cmdk's idle ⇄ search morph animates.
export const nowArea = () => nowEl;
export const cover = () => coverEl;
export const meta = () => metaEl;

function renderNow() {
  const p = store.get().player;
  const t = p.track;
  greetingEl.hidden = !!t;
  if (!t) { nowEl.hidden = true; return; }
  nowEl.hidden = false;

  const isNewTrack = t.id !== lastRenderedTrackId;
  lastRenderedTrackId = t.id;
  if (isNewTrack) {
    if (t.name) tx.scrambleText(titleEl, t.name, 380);
    else titleEl.textContent = t.name || '';
    artistEl.textContent = formatArtists(t) || t.al?.name || '';
  }

  timeEl.textContent = fmtTime(p.currentTime || 0);
  const pct = p.duration ? Math.max(0, Math.min(1, p.currentTime / p.duration)) : 0;
  progressEl.style.width = `${pct * 100}%`;

  const coverUrl = t.al?.picUrl;
  if (coverUrl && coverUrl !== lastNowCover) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (store.get().player.track?.al?.picUrl !== coverUrl) return;
      coverEl.style.setProperty('--cover', `url("${coverUrl}")`);
      tx.popEl(coverEl);
      accent.update(coverUrl);
    };
    img.src = coverUrl;
  } else if (!coverUrl) {
    coverEl.style.removeProperty('--cover');
  }
  lastNowCover = coverUrl || '';
}

export function renderGreeting(nickname = store.get().user?.nickname ?? '') {
  const h = new Date().getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  greetingTextEl.textContent = nickname ? `${part}, ${nickname}` : part;
  // Under it, the week so far: "This week · 14 h · mostly ヨルシカ".
  memory.prime().then(() => {
    const w = memory.weekRecap();
    greetingSubEl.textContent = w.plays
      ? ['This week', w.hours >= 1 ? `${Math.round(w.hours)} h` : `${w.plays} songs`, w.topArtist && `mostly ${w.topArtist}`].filter(Boolean).join(' · ')
      : 'Nothing played this week yet';
  });
}

// One quiet line under the hero: the song's story with you.
//   liked:      "♥ since Apr 2026 · 31 plays · most in August"
//   not liked:  "12 plays · first heard 3 months ago"
//   never:      "New to you"
async function renderContext(t) {
  await memory.prime();
  if (store.get().player.track?.id !== t.id) return;
  const lib = store.get().library.tracks.find((x) => x.id === t.id);
  const s = memory.statsFor(t.id);
  const bits = [];
  if (lib?.addedAt) bits.push(`♥ since ${memory.monthYear(lib.addedAt)}`);
  if (s.plays) bits.push(`${s.plays} ${s.plays === 1 ? 'play' : 'plays'}`);
  const peak = s.plays >= 6 ? memory.peakMonth(t.id) : null;
  if (lib && peak && peak.plays >= 4) {
    const [y, m] = peak.month.split('-').map(Number);
    bits.push(`most in ${new Date(y, m - 1, 1).toLocaleDateString('en', { month: 'long' })}`);
  } else if (!lib && s.firstAt) bits.push(`first heard ${memory.ago(s.firstAt)}`);
  contextEl.textContent = bits.length ? bits.join(' · ') : 'New to you';
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
