// ⌘I — a song's card beside the list: the cover large, title / artist /
// album, and its story with you (liked since, plays, first and last heard,
// the month you played it most). It follows the cursor while open; songs
// only — on a menu row it says so.

import { store } from '../store.js';
import * as memory from '../lib/memory.js';
import { formatArtists } from '../commands.js';
import { thumbUrl } from './list.js';

let wrapEl = null;
let panelEl = null;
let open = false;
let seq = 0;

export function mountInfo(wrap) {
  wrapEl = wrap;
  panelEl = document.createElement('aside');
  panelEl.className = 'cmdk-info';
  panelEl.hidden = true;
  wrapEl.appendChild(panelEl);
}

export const isOpen = () => open;

export function setOpen(on, entry) {
  open = !!on;
  wrapEl.classList.toggle('with-info', open);
  panelEl.hidden = !open;
  if (open) show(entry);
}

export async function show(entry) {
  if (!open) return;
  const my = ++seq;
  const t = entry?.track;
  panelEl.textContent = '';
  if (!t) {
    panelEl.append(el('div', 'info-empty', 'Select a song to see its story'));
    return;
  }
  await memory.prime();
  if (my !== seq) return;

  const lib = store.get().library.tracks.find((x) => x.id === t.id);
  const s = memory.statsFor(t.id);
  const peak = memory.peakMonth(t.id);

  const cover = el('div', 'info-cover');
  if (t.al?.picUrl) { const img = new Image(); img.alt = ''; img.src = thumbUrl(t.al.picUrl, 400); cover.append(img); }
  const facts = el('dl', 'info-facts');
  const fact = (k, v) => { if (v) facts.append(el('dt', '', k), el('dd', '', v)); };
  fact('Liked', lib ? (lib.addedAt ? fmtDate(lib.addedAt) : 'yes') : 'not yet');
  fact('Plays', String(s.plays || 0));
  fact('First heard', s.firstAt ? `${fmtDate(s.firstAt)}` : '');
  fact('Last heard', s.lastAt ? memory.ago(s.lastAt) : '');
  if (peak && peak.plays > 1) {
    const [y, m] = peak.month.split('-').map(Number);
    fact('Most in', `${new Date(y, m - 1, 1).toLocaleDateString('en', { month: 'short', year: 'numeric' })} · ${peak.plays}×`);
  }
  panelEl.append(
    cover,
    el('div', 'info-title', t.name || ''),
    el('div', 'info-artist', formatArtists(t)),
    el('div', 'info-album', t.al?.name || ''),
    facts,
  );
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}
