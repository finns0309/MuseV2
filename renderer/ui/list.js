// The results list: section headers, rows, and the gliding cursor.
//
// cmdk.js decides *what* is in the list (refresh → entries); this module
// decides how it looks and which row is selected. Entries are plain objects
// from commands.js — a song (has `name`) or a menu item (has `title`).

import { icon } from '../icons.js';
import { GLYPH } from '../glyphs.js';

let listEl = null;
let cursorEl = null;
let onExecute = () => {};

let entries = [];
let rowEls = [];          // selectable row <li>s, parallel to entries (excludes section headers)
let cursor = 0;
let query = '';           // highlighted in titles
let introPending = false; // the first render after opening staggers its rows in

export function mountList({ list, cursor: cur, execute }) {
  listEl = list;
  cursorEl = cur;
  onExecute = execute;
  listEl.addEventListener('scroll', () => seat(true), { passive: true });
}

export const getEntries = () => entries;
export const getCursor = () => cursor;
export const current = () => entries[cursor];
export function armIntro() { introPending = true; }

// Render `next`. keepCursor holds the selection where it was (a menu choice
// re-rendering its ✓, cloud results arriving under a moved cursor).
export function render(next, { query: q = '', thinking = false, emptyText = '', keepCursor = false } = {}) {
  entries = next;
  query = q;
  cursor = keepCursor ? Math.min(cursor, Math.max(0, entries.length - 1)) : 0;
  listEl.innerHTML = '';
  rowEls = [];
  if (!entries.length) {
    if (thinking) listEl.appendChild(thinkingRow());
    else if (emptyText) {
      const li = document.createElement('li');
      li.className = 'cmdk-empty';
      li.textContent = emptyText;
      listEl.appendChild(li);
    }
    seat(false);
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

    if (e.name !== undefined) songRow(li, e, mixed[e.group] ?? false);
    else menuRow(li, e);

    li.addEventListener('click', (ev) => onExecute(i, pickVariant(ev)));
    li.addEventListener('mousemove', () => setCursor(i));
    listEl.appendChild(li);
    rowEls.push(li);
  });
  if (thinking) listEl.appendChild(thinkingRow());
  seat(false);
}

// ⌘-click likes, ⌥-click starts a radio; keyboard variants live in cmdk.onKey.
function pickVariant(ev) {
  if (ev.metaKey && !ev.altKey) return 'heart';
  if (ev.altKey) return 'alt';
  return 'primary';
}

// ---- Rows --------------------------------------------------------------------

// Song: cover · name ♥ artist ……… duration — or, on the selected row, the
// keys that act on it (Enter plays, ⌥Enter starts a radio).
function songRow(li, e, showLiked) {
  li.classList.add('song');
  if (e.dim) li.classList.add('dim');
  const th = document.createElement('span'); th.className = 'tile thumb';
  if (e.cover) {
    const img = new Image();
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.onerror = () => { img.remove(); th.innerHTML = icon('music'); };
    img.src = thumbUrl(e.cover);
    th.appendChild(img);
  } else th.innerHTML = icon('music');
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
  if (e.altRun) {
    const keys = document.createElement('span'); keys.className = 'keys';
    keys.innerHTML = '<kbd>↵</kbd> Play<span class="sep"></span><kbd>⌥↵</kbd> Radio';
    meta.append(keys);
  }
  li.append(th, main, meta);
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

// NetEase's CDN resizes on request — a 64px thumb instead of the full cover.
export function thumbUrl(url, px = 64) {
  return url.replace(/^http:/, 'https:') + (url.includes('?') ? '&' : '?') + `param=${px}y${px}`;
}

// Cloud search in flight: the spark turns and the words shimmer, the way a
// reply is "thinking". Not selectable — it isn't in rowEls.
function thinkingRow() {
  const li = document.createElement('li');
  li.className = 'cmdk-thinking';
  li.innerHTML = '<span class="cmdk-spark" aria-hidden="true"></span><span class="cmdk-shimmer">Searching NetEase…</span>';
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
