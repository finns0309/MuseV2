// Memory — your listening history (data/history.json, written by main on
// every counted play) turned into the things the UI talks about: a song's
// story (liked since, plays, last heard), this week, "N months ago today",
// and eras (a month of your listening, most-played first).
//
// The history is loaded once and refreshed lazily; accessors are synchronous
// over the cached copy so menu builders (which are sync) can use them. Call
// prime() early; until it resolves the accessors return empty answers.

import { store } from '../store.js';

const TTL_MS = 60_000;
let history = [];
let loadedAt = 0;
let loading = null;
let derived = null;        // memoised per load: { bySong, byMonth }

export function prime() {
  if (loading) return loading;
  if (Date.now() - loadedAt < TTL_MS) return Promise.resolve(history);
  loading = Promise.resolve(window.muse.store.get('history', []))
    .then((h) => { history = Array.isArray(h) ? h : []; loadedAt = Date.now(); derived = null; return history; })
    .catch(() => history)
    .finally(() => { loading = null; });
  return loading;
}

export async function loadHistory() { await prime(); return history; }

const monthKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

function derive() {
  if (derived) return derived;
  const bySong = new Map();     // songId → { plays, firstAt, lastAt, entry }
  const byMonth = new Map();    // 'YYYY-MM' → Map(songId → { plays, entry })
  for (const h of history) {
    if (!h?.songId || !h.at) continue;
    const s = bySong.get(h.songId) || { plays: 0, firstAt: h.at, lastAt: h.at, entry: h };
    s.plays++; s.firstAt = Math.min(s.firstAt, h.at); s.lastAt = Math.max(s.lastAt, h.at); s.entry = h;
    bySong.set(h.songId, s);
    const k = monthKey(h.at);
    if (!byMonth.has(k)) byMonth.set(k, new Map());
    const m = byMonth.get(k);
    const e = m.get(h.songId) || { plays: 0, entry: h };
    e.plays++;
    m.set(h.songId, e);
  }
  derived = { bySong, byMonth };
  return derived;
}

// A history row → a playable track (prefers the richer library copy).
function toTrack(entry) {
  const lib = store.get().library.tracks.find((t) => t.id === entry.songId);
  if (lib) return lib;
  return {
    id: entry.songId, name: entry.name,
    ar: String(entry.artist || '').split(/\s*[,/]\s*/).filter(Boolean).map((name) => ({ name })),
    al: { name: entry.album, picUrl: entry.picUrl }, dt: entry.durationMs || 0,
  };
}

// ---- A song's story -----------------------------------------------------------

export function statsFor(songId) {
  const s = derive().bySong.get(songId);
  return s ? { plays: s.plays, firstAt: s.firstAt, lastAt: s.lastAt } : { plays: 0, firstAt: 0, lastAt: 0 };
}

// The month you played it most, if it stands out.
export function peakMonth(songId) {
  let best = null;
  for (const [k, m] of derive().byMonth) {
    const e = m.get(songId);
    if (e && (!best || e.plays > best.plays)) best = { month: k, plays: e.plays };
  }
  return best;
}

// ---- This week ------------------------------------------------------------------

export function weekRecap(now = Date.now()) {
  const since = now - 7 * 86400000;
  let ms = 0, plays = 0;
  const artists = new Map();
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h?.at || h.at < since) { if (h?.at && h.at < since) break; continue; }
    plays++;
    ms += h.durationMs || 0;
    const a = String(h.artist || '').split(/\s*[,/]\s*/)[0];
    if (a) artists.set(a, (artists.get(a) || 0) + 1);
  }
  const topArtist = [...artists].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return { plays, hours: ms / 3600000, topArtist };
}

// ---- N months ago today ----------------------------------------------------------
// The farthest-back anniversary (12, 6, 3, then 1 month) that has plays on
// that calendar day — the history only reaches back so far.

export function onThisDay(now = new Date()) {
  for (const back of [12, 6, 3, 1]) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - back);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = start + 86400000;
    const counts = new Map();
    for (const h of history) {
      if (h?.at >= start && h.at < end && h.songId) {
        const c = counts.get(h.songId) || { plays: 0, entry: h };
        c.plays++;
        counts.set(h.songId, c);
      }
    }
    if (counts.size >= 3) {
      const tracks = [...counts.values()].sort((a, b) => b.plays - a.plays).map((c) => toTrack(c.entry));
      const label = back === 12 ? 'A year ago today' : back === 1 ? 'A month ago today' : `${back} months ago today`;
      return { back, label, date: start, tracks };
    }
  }
  return null;
}

// ---- Eras ---------------------------------------------------------------------------

// Newest first: [{ key:'2026-08', label:'August 2026', plays, topArtist, tracks }]
export function eras() {
  const out = [];
  for (const [key, m] of derive().byMonth) {
    const ranked = [...m.values()].sort((a, b) => b.plays - a.plays);
    const plays = ranked.reduce((n, e) => n + e.plays, 0);
    const [y, mo] = key.split('-').map(Number);
    out.push({
      key,
      label: new Date(y, mo - 1, 1).toLocaleDateString('en', { month: 'long', year: 'numeric' }),
      plays,
      top: ranked[0]?.entry?.name || '',
      tracks: () => ranked.slice(0, 50).map((e) => toTrack(e.entry)),
    });
  }
  return out.sort((a, b) => b.key.localeCompare(a.key));
}

// ---- Formatting ----------------------------------------------------------------------

export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const days = Math.floor((now - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  const n = (v, unit) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (days < 7) return n(days, 'day');
  if (days < 30) return n(Math.round(days / 7), 'week');
  if (days < 365) return n(Math.round(days / 30), 'month');
  return n(Math.round(days / 365), 'year');
}

export function monthYear(ms) {
  return ms ? new Date(ms).toLocaleDateString('en', { month: 'short', year: 'numeric' }) : '';
}
