// The now-playing area: the hero at home (big cover, serif title, progress)
// and the compact strip above the composer while searching — the same DOM,
// morphed by `.idle` on the panel. When nothing is playing, the greeting
// ("✻ Evening, finn") takes its place.

import { store } from '../store.js';
import * as player from '../player.js';
import * as accent from '../accent.js';
import * as tx from '../transitions.js';
import { formatArtists } from '../commands.js';
import * as memory from '../lib/memory.js';

let nowEl, coverEl, metaEl, titleEl, artistEl, timeEl, progressEl, contextEl, rowEl, barEl, scrubEl;
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
  rowEl          = root.querySelector('[data-role=progress-row]');
  barEl          = root.querySelector('.cmdk-now__progress');
  scrubEl        = root.querySelector('[data-role=scrub]');
  wireScrub();

  tx.initCoverTilt(coverEl);
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${Math.floor(s.player.currentTime)}|${Math.floor(s.player.duration)}`,
    renderNow
  );
  // The bar follows the player's ~4Hz position, gliding between samples.
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${Math.round(s.player.currentTime * 4)}|${Math.floor(s.player.duration)}`,
    renderProgress
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

  if (!scrubbing) renderTime(p.currentTime || 0, p.duration || 0);

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

// ---- Progress: fluid, and a control -------------------------------------------
//
// The width glides (a 260ms linear transition) between the player's quarter-
// second samples, and snaps on a jump (seek, new track). Hover the bar and it
// thickens, with the time under the pointer in a small bubble; press or drag
// to scrub, release to seek. At home ←/→ nudge by 10s (cmdk.onKey → nudge).

let scrubbing = false;
let lastPos = 0;

function renderTime(sec, dur) {
  timeEl.textContent = fmtTime(sec);
  if (dur) {
    const tot = document.createElement('span');
    tot.className = 'tot';
    tot.textContent = ` / ${fmtTime(dur)}`;
    timeEl.append(tot);
  }
}

function renderProgress() {
  if (scrubbing) return;
  const p = store.get().player;
  const pos = p.currentTime || 0;
  const pct = p.duration ? Math.max(0, Math.min(1, pos / p.duration)) : 0;
  const jumped = Math.abs(pos - lastPos) > 1.5;
  lastPos = pos;
  progressEl.classList.toggle('snap', jumped);
  progressEl.style.width = `${pct * 100}%`;
}

function fractionAt(e) {
  const r = barEl.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

function wireScrub() {
  const dur = () => store.get().player.duration || 0;
  const show = (f) => {
    const r = barEl.getBoundingClientRect();
    const rr = rowEl.getBoundingClientRect();
    scrubEl.textContent = fmtTime(f * dur());
    scrubEl.style.left = `${r.left - rr.left + f * r.width}px`;
    scrubEl.classList.add('on');
  };
  const overBar = (e) => {
    const r = barEl.getBoundingClientRect();
    return e.clientX >= r.left - 4 && e.clientX <= r.right + 4;
  };
  rowEl.addEventListener('pointermove', (e) => {
    if (!dur()) return;
    if (scrubbing) {
      const f = fractionAt(e);
      progressEl.classList.add('snap');
      progressEl.style.width = `${f * 100}%`;
      renderTime(f * dur(), dur());
      show(f);
    } else if (overBar(e)) { rowEl.classList.add('hot'); show(fractionAt(e)); }
    else { rowEl.classList.remove('hot'); scrubEl.classList.remove('on'); }
  });
  rowEl.addEventListener('pointerleave', () => {
    if (scrubbing) return;
    rowEl.classList.remove('hot');
    scrubEl.classList.remove('on');
  });
  rowEl.addEventListener('pointerdown', (e) => {
    if (!dur() || !overBar(e)) return;
    e.preventDefault();
    scrubbing = true;
    rowEl.classList.add('hot', 'scrubbing');
    rowEl.setPointerCapture(e.pointerId);
    const f = fractionAt(e);
    progressEl.classList.add('snap');
    progressEl.style.width = `${f * 100}%`;
    show(f);
  });
  const end = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    rowEl.classList.remove('scrubbing');
    const t = fractionAt(e) * dur();
    lastPos = t;
    player.seek(t);
    if (!rowEl.matches(':hover')) { rowEl.classList.remove('hot'); scrubEl.classList.remove('on'); }
  };
  rowEl.addEventListener('pointerup', end);
  rowEl.addEventListener('pointercancel', end);
}

// ←/→ at home: skip back / ahead.
export function nudge(seconds) {
  const p = store.get().player;
  if (!p.track || !p.duration) return;
  const t = Math.max(0, Math.min(p.duration - 0.5, (p.currentTime || 0) + seconds));
  lastPos = t;
  progressEl.classList.add('snap');
  progressEl.style.width = `${(t / p.duration) * 100}%`;
  player.seek(t);
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
