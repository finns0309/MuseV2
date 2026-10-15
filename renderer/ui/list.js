// The results list: section headers, rows, and the gliding cursor.
//
// cmdk.js decides *what* is in the list (refresh → entries); this module
// decides how it looks and which row is selected. Entries are plain objects
// from commands.js — a song (has `name`) or a menu item (has `title`).

import { store } from '../store.js';
import { icon } from '../icons.js';
import { GLYPH } from '../glyphs.js';

let listEl = null;
let cursorEl = null;
let keysEl = null;
let onExecute = () => {};
let inScope = () => false;
let onCursor = () => {};

let entries = [];
let rowEls = [];          // selectable row <li>s, parallel to entries (excludes section headers)
let cursor = 0;
let query = '';           // highlighted in titles
let introPending = false; // the first render after opening staggers its rows in

export function mountList({ list, cursor: cur, keys, execute, scoped, cursorChanged }) {
  listEl = list;
  cursorEl = cur;
  keysEl = keys;
  onExecute = execute;
  inScope = scoped || inScope;
  onCursor = cursorChanged || onCursor;
  listEl.addEventListener('scroll', () => seat(true), { passive: true });
  // The playing song's row follows the player while the list is open.
  store.select((s) => s.player.track?.id ?? null, (id, prev) => { if (prev !== undefined) markPlaying(id); });
}

const playingId = () => store.get().player.track?.id ?? null;
const isPlaying = (e) => e?.track?.id != null && e.track.id === playingId();

// ♫ — three bars on the thumbnail of the song that's playing (they rest
// when paused, via .cmdk-panel.paused in CSS).
function markPlaying(id) {
  rowEls.forEach((li, i) => {
    const on = id != null && entries[i]?.track?.id === id;
    li.classList.toggle('playing', on);
    const tile = li.querySelector('.tile.thumb');
    if (tile && on && !tile.querySelector('.eq')) tile.append(eqBars());
    if (tile && !on) tile.querySelector('.eq')?.remove();
  });
  renderKeys();
}

function eqBars() {
  const eq = document.createElement('span');
  eq.className = 'eq';
  eq.innerHTML = '<i></i><i></i><i></i>';
  return eq;
}

export const getEntries = () => entries;
export const getCursor = () => cursor;
export const current = () => entries[cursor];
export function armIntro() { introPending = true; }

// Render `next`. keepCursor holds the selection where it was (a menu choice
// re-rendering its ✓, cloud results arriving under a moved cursor).
// thinking: true (cloud search) or the status line to show ("Picking songs…").
// prompt: the request echoed as a speech bubble above everything (Ask).
export function render(next, { query: q = '', thinking = false, emptyText = '', keepCursor = false, prompt = '' } = {}) {
  entries = next;
  query = q;
  cursor = keepCursor ? Math.min(cursor, Math.max(0, entries.length - 1)) : 0;
  listEl.innerHTML = '';
  rowEls = [];
  if (prompt) listEl.appendChild(promptRow(prompt));
  if (!entries.length) {
    if (thinking) listEl.appendChild(thinkingRow(thinking));
    else if (emptyText) {
      const li = document.createElement('li');
      li.className = 'cmdk-empty';
      li.textContent = emptyText;
      listEl.appendChild(li);
    }
    seat(false);
    renderKeys();
    return;
  }
  const intro = introPending;
  introPending = false;

  // Per-group counts for song sections ("Your library 8"); menus don't count.
  const counts = {};
  entries.forEach((e) => { if (e.group && e.name !== undefined) counts[e.group] = (counts[e.group] || 0) + 1; });
  // ♥ only where it tells you something: a section that mixes liked and
  // unliked songs. "Your library" or an All-mode queue would be all hearts.
  const mixed = {};
  for (const g of Object.keys(counts)) {
    const songs = entries.filter((e) => e.group === g && e.name !== undefined);
    mixed[g] = songs.some((e) => e.liked) && songs.some((e) => !e.liked);
  }

  let prevGroup = null;
  entries.forEach((e, i) => {
    if (e.group && e.group !== prevGroup) {
      prevGroup = e.group;
      const h = document.createElement('li');
      h.className = 'cmdk-sec';
      const lbl = document.createElement('span'); lbl.className = 'sec-lbl'; lbl.textContent = e.group;
      const cnt = document.createElement('span'); cnt.className = 'sec-cnt'; cnt.textContent = counts[e.group] || '';
      h.append(lbl, cnt);
      listEl.appendChild(h);
    }

    const li = document.createElement('li');
    li.className = 'row' + (i === cursor ? ' sel' : '');
    if (intro) { li.classList.add('in'); li.style.animationDelay = `${Math.min(i, 10) * 24}ms`; }

    if (e.name !== undefined) songRow(li, e, mixed[e.group] ?? false, i);
    else if (e.kind === 'answer') answerRow(li, e, i);
    else menuRow(li, e);

    li.addEventListener('click', (ev) => onExecute(i, pickVariant(ev)));
    li.addEventListener('mousemove', () => setCursor(i));
    listEl.appendChild(li);
    rowEls.push(li);
  });
  if (thinking) listEl.appendChild(thinkingRow(thinking));
  seat(false);
  renderKeys();
}

// ⌘-click likes, ⌥-click starts a radio; keyboard variants live in cmdk.onKey.
function pickVariant(ev) {
  if (ev.metaKey && !ev.altKey) return 'heart';
  if (ev.altKey) return 'alt';
  return 'primary';
}

// ---- Rows --------------------------------------------------------------------

// Song: cover · name ♥ artist ……… duration — or, on the selected / hovered
// row, its actions as buttons (the key legend below says the same in keys).
function songRow(li, e, showLiked, i) {
  li.classList.add('song');
  if (e.dim) li.classList.add('dim');
  const th = document.createElement('span'); th.className = 'tile thumb';
  if (e.cover) {
    th.appendChild(coverImg(e.cover, 64, () => { th.innerHTML = icon('music'); }));
  } else th.innerHTML = icon('music');
  if (isPlaying(e)) { li.classList.add('playing'); th.append(eqBars()); }
  const main = document.createElement('div'); main.className = 'rowmain';
  const nm = document.createElement('span'); nm.className = 'nm'; highlightInto(nm, e.name, query);
  main.append(nm);
  if (e.liked && showLiked) {
    const h = document.createElement('span'); h.className = 'liked'; h.textContent = GLYPH.LIKED; h.title = 'In your library';
    main.append(h);
  }
  const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = e.sub || '';
  main.append(sub);
  const meta = document.createElement('span'); meta.className = 'meta';
  const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = e.dur || '';
  meta.append(dur);
  const acts = rowActions(e);
  if (acts.length) {
    const box = document.createElement('span'); box.className = 'acts';
    for (const [variant, ic, label, on] of acts) {
      const b = document.createElement('button');
      b.className = 'act' + (on ? ' on' : '');
      b.title = label; b.setAttribute('aria-label', label);
      b.innerHTML = icon(ic);
      b.addEventListener('mousedown', (ev) => ev.preventDefault());   // keep the input focused
      b.addEventListener('click', (ev) => { ev.stopPropagation(); onExecute(i, variant); });
      box.append(b);
    }
    meta.append(box);
  }
  li.append(th, main, meta);
}

// Ask's answer: cover mosaic · ✻ title  N songs / the DJ's sentence ……… actions
function answerRow(li, e, i) {
  li.classList.add('answer');
  const art = document.createElement('span'); art.className = 'mosaic';
  if (e.covers?.length) {
    for (const url of e.covers.slice(0, 4)) art.appendChild(coverImg(url, 96));
    art.dataset.n = Math.min(4, e.covers.length);
  } else art.classList.add('empty');
  const body = document.createElement('div'); body.className = 'ans';
  const head = document.createElement('div'); head.className = 'ans-head';
  const ttl = document.createElement('span'); ttl.className = 'ans-title'; ttl.textContent = e.title;
  head.append(ttl);
  if (e.count) { const n = document.createElement('span'); n.className = 'ans-count'; n.textContent = `${e.count} songs`; head.append(n); }
  const reply = document.createElement('div'); reply.className = 'ans-reply'; reply.textContent = e.reply || '';
  body.append(head, reply);
  const meta = document.createElement('span'); meta.className = 'meta';
  const acts = e.count
    ? [['primary', 'play', 'Play all  ↵'], ['next', 'next', 'Play next  ⌘↵'], ['queue', 'listPlus', 'Add to queue  ⇧↵'], ['alt', 'refresh', 'Try again  ⌥↵']]
    : [['alt', 'refresh', 'Try again  ⌥↵']];
  const box = document.createElement('span'); box.className = 'acts';
  for (const [variant, ic, label] of acts) {
    const b = document.createElement('button');
    b.className = 'act'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = icon(ic);
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onExecute(i, variant); });
    box.append(b);
  }
  meta.append(box);
  li.append(art, body, meta);
}

// What you asked, echoed as a speech bubble on the right — the conversation
// shape Ask borrows from a chat. Not a row: the cursor never lands on it.
function promptRow(text) {
  const li = document.createElement('li');
  li.className = 'cmdk-prompt';
  const b = document.createElement('span'); b.className = 'bubble'; b.textContent = text;
  li.append(b);
  return li;
}

// [variant, icon, tooltip, active?] for a song row's buttons.
function rowActions(e) {
  const out = [];
  if (e.moveRun) out.push(['up', 'arrowUp', 'Move up  ⌥↑'], ['down', 'arrowDown', 'Move down  ⌥↓']);
  const now = isPlaying(e);
  if (e.nextRun && !now) out.push(['next', 'next', 'Play next  ⌘↵']);
  if (e.queueRun && e.queueIdx === undefined && !now) out.push(['queue', 'listPlus', 'Add to queue  ⇧↵']);
  if (e.altRun) out.push(['alt', 'radio', 'Start a radio  ⌥↵']);
  if (e.heartRun) out.push(['heart', e.liked ? 'heartFill' : 'heart', e.liked ? 'Unlike  ⌘-click' : 'Like  ⌘-click', e.liked]);
  if (e.removeRun) out.push(['remove', 'x', 'Remove  ⌘⌫']);
  return out;
}

// Menu: tile (icon or colour swatch) · title  description ……… value ✓ ›
function menuRow(li, e) {
  li.classList.add('menu');
  if (e.inert) li.classList.add('inert');
  const tile = document.createElement('span'); tile.className = 'tile';
  if (e.swatch) {
    tile.classList.add('swatch');
    tile.style.setProperty('--sw-bg', e.swatch[0]);
    tile.style.setProperty('--sw-ink', e.swatch[1]);
  } else if (e.icon === 'spark') {
    tile.classList.add('spark');
  } else tile.innerHTML = icon(e.icon || 'dot');
  const main = document.createElement('div'); main.className = 'rowmain';
  const ttl = document.createElement('span'); ttl.className = 'ttl'; highlightInto(ttl, e.title ?? e.label ?? '', query);
  const dsc = document.createElement('span'); dsc.className = 'dsc'; dsc.textContent = e.desc ?? e.hint ?? '';
  main.append(ttl, dsc);
  const meta = document.createElement('span'); meta.className = 'meta';
  if (e.value) { const v = document.createElement('span'); v.className = 'val'; v.textContent = e.value; meta.append(v); }
  if (e.checked) { const c = document.createElement('span'); c.className = 'chk'; c.innerHTML = icon('check'); meta.append(c); }
  if (e.submenu) { const c = document.createElement('span'); c.className = 'chev'; c.innerHTML = icon('chevron'); meta.append(c); }
  li.append(tile, main, meta);
}

// A cover thumbnail. The CDN occasionally drops one of a burst of requests,
// so a failure gets one quiet retry before the row falls back to an icon.
function coverImg(url, px, fallback = () => {}) {
  const img = new Image();
  img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
  let retried = false;
  img.onerror = () => {
    if (!retried) {
      retried = true;
      const again = thumbUrl(url, px);
      setTimeout(() => { img.src = again + (again.includes('?') ? '&' : '?') + 'retry=1'; }, 500 + Math.random() * 700);
      return;
    }
    img.remove();
    fallback();
  };
  img.src = thumbUrl(url, px);
  return img;
}

// A px-sized cover. In the app it goes through main's disk cache (the
// muse-thumb scheme, lib/thumbs.js); elsewhere straight to NetEase's CDN,
// which resizes on request.
export function thumbUrl(url, px = 64) {
  const scheme = window.muse?.thumbScheme;
  if (scheme) return `${scheme}://img/${px}/${b64url(url)}`;
  return url.replace(/^http:/, 'https:') + (url.includes('?') ? '&' : '?') + `param=${px}y${px}`;
}

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cloud search in flight: the spark turns and the words shimmer, the way a
// reply is "thinking". Not selectable — it isn't in rowEls.
function thinkingRow(text) {
  const li = document.createElement('li');
  li.className = 'cmdk-thinking';
  li.innerHTML = '<span class="cmdk-spark" aria-hidden="true"></span><span class="cmdk-shimmer"></span>';
  li.lastChild.textContent = typeof text === 'string' ? text : 'Searching NetEase…';
  return li;
}

// Escape `text` and wrap the first case-insensitive occurrence of `q` in <mark>.
export function highlightInto(el, text, q) {
  text = text || '';
  const needle = (q || '').trim();
  el.textContent = '';
  const idx = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (idx < 0) { el.textContent = text; return; }
  el.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(idx, idx + needle.length);
  el.appendChild(mark);
  el.appendChild(document.createTextNode(text.slice(idx + needle.length)));
}

// ---- Cursor --------------------------------------------------------------------

export function setCursor(i) {
  if (i === cursor || i < 0 || i >= entries.length) return;
  const prev = rowEls[cursor];
  if (prev) prev.classList.remove('sel');
  cursor = i;
  const next = rowEls[cursor];
  if (next) { next.classList.add('sel'); next.scrollIntoView({ block: 'nearest' }); }
  seat(true);
  renderKeys();
}

// ---- Key legend ----------------------------------------------------------------
// One slim line under the list saying what the keys do *for the selected row*
// — the only place ⌘↵ / ⇧↵ / ⌥↑↓ are written down.

function renderKeys() {
  onCursor(entries[cursor]);
  if (!keysEl) return;
  const e = entries[cursor];
  const back = inScope() ? [['⌫', 'Back']] : [];
  let keys = [];
  if (!e || e.inert) keys = back;
  else if (e.submenu) keys = [['↵', 'Open'], ['⇥', 'Open'], ...back];
  else if (e.kind === 'answer') keys = e.count ? [['↵', 'Play all'], ['⌘↵', 'Next'], ['⇧↵', 'Queue'], ['⌥↵', 'Try again']] : [['↵', 'Try again']];
  else if (e.name !== undefined && isPlaying(e)) keys = [['⌥↵', 'Radio from it'], ['⌘D', 'Like'], ['⌘I', 'Info'], ...back];
  else if (e.moveRun) keys = [['↵', 'Play'], ['⌘↵', 'Next'], ['⌥↑↓', 'Move'], ['⌘⌫', 'Remove'], ['⌘I', 'Info'], ...back];
  else if (e.name !== undefined) keys = [['↵', 'Play'], ['⌘↵', 'Next'], ['⇧↵', 'Queue'], ['⌥↵', 'Radio'], ['⌘I', 'Info'], ...back];
  else keys = [['↵', 'Choose'], ...back];
  keysEl.innerHTML = keys.map(([k, label]) => `<span><kbd>${k}</kbd>${label}</span>`).join('');
}

export function move(delta) {
  setCursor(Math.max(0, Math.min(cursor + delta, entries.length - 1)));
}

// Put the cursor box over the selected row — gliding, or snapped when the
// rows themselves just changed under it.
export function seat(animate) {
  if (!cursorEl) return;
  const li = rowEls[cursor];
  if (!li) { cursorEl.style.opacity = '0'; return; }
  const place = () => {
    const y = li.offsetTop - listEl.scrollTop;
    cursorEl.style.opacity = '1';
    cursorEl.style.transform = `translate(${li.offsetLeft}px, ${y}px)`;
    cursorEl.style.width = `${li.offsetWidth}px`;
    cursorEl.style.height = `${li.offsetHeight}px`;
  };
  if (animate) { place(); return; }
  cursorEl.style.transition = 'none';
  place();
  void cursorEl.offsetWidth;
  cursorEl.style.transition = '';
}

// Enter: the row is acknowledged (a short accent fill) before anything moves.
export function flashCommit() {
  cursorEl?.classList.add('commit');
  setTimeout(() => cursorEl?.classList.remove('commit'), 160);
}
