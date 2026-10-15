// Command palette — the sole UI surface of muse.
//
// Idle state: large centered now-playing hero + search input at bottom.
// Search state: compact now-playing strip + input + results list.
// The morph between the two is driven by the `.idle` class on `.cmdk-panel`.
//
// This file owns: DOM mount, rendering, cursor, keyboard dispatch, and window
// resize. Business logic (builders, playlists, accent, transitions) is in
// sibling modules to keep this file focused on the view.

import { store, actions } from './store.js';
import * as player from './player.js';
import * as accent from './accent.js';
import * as playlist from './playlist.js';
import * as tx from './transitions.js';
import { COMMAND_BUILDERS, SONG_BUILDERS, ASYNC_BUILDERS, injectSetInput, formatArtists } from './commands.js';
import { GLYPH } from './glyphs.js';
import { toggleHeart } from './lib/library.js';
import { MODES } from './modes/index.js';

// ---- DOM refs ---------------------------------------------------------------

let rootEl, panelEl, inputEl, listEl, toastEl, nowEl, nowCoverEl, nowTitleEl, nowArtistEl, nowTimeEl, nowProgressEl, sessionEl;
let greetingEl, greetingTextEl, sendEl, heartEl, chipsEl;
let cursorEl = null;

// ---- State ------------------------------------------------------------------

let entries = [];
let rowEls = [];          // selectable row <li>s, parallel to entries (excludes section headers)
let cursor = 0;
let introPending = false;
let lastQuery = '';       // current bare search query, for match highlighting
let lastNowCover = '';
let lastRenderedTrackId = null;
let toastTimer = null;
let composing = false;    // IME composition in progress
let idleTimer = null;     // staged search → idle transition
let idleSeq = 0;          // invalidates an in-flight staged transition
let landing = false;      // Enter → home choreography owns the now-area for a moment
let thinking = false;     // cloud search in flight → the "✻ Searching NetEase…" row
let nowMetaEl;

// ---- Window resize ----------------------------------------------------------

// Two fixed heights, nothing in between: the window must never change size
// while the user is typing (async cloud results used to grow it mid-word).
// Idle is a little taller than 16:9 to fit the composer's toolbar + chips.
const IDLE_H = 440;
const SEARCH_H = 560;
const WIN_W = 720;
let lastResizeH = 0;

function resizeToContent() {
  if (!panelEl) return;
  resizeTo(panelEl.classList.contains('idle') ? IDLE_H : SEARCH_H);
}

// Request a native resize and resolve once the viewport actually has that
// height (or after a short grace period — the IPC is async and we don't want
// a stuck promise to freeze a transition).
function resizeTo(h) {
  if (h === lastResizeH && window.innerHeight === h) return Promise.resolve();
  lastResizeH = h;
  window.muse.resizeWindow?.(WIN_W, h);
  if (window.innerHeight === h) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; window.removeEventListener('resize', onResize); resolve(); };
    const onResize = () => { if (window.innerHeight === h) finish(); };
    window.addEventListener('resize', onResize);
    setTimeout(finish, 120);
  });
}

// ---- Mount ------------------------------------------------------------------

export function mount(el) {
  rootEl = el;
  // The ambient wash lives INSIDE the panel (absolute, z 0) so it's painted
  // under the content layers — outside the opaque panel it was invisible.
  rootEl.innerHTML = `
    <div class="cmdk-panel">
      <div class="cmdk-ambient" data-role="ambient" aria-hidden="true"></div>
      <div class="cmdk-greeting" data-role="greeting">
        <span class="cmdk-greeting__spark" aria-hidden="true"></span>
        <span data-role="greeting-text"></span>
      </div>
      <div class="cmdk-now" data-role="now" hidden>
        <div class="cmdk-now__cover" data-role="now-cover"></div>
        <div class="cmdk-now__meta">
          <div class="cmdk-now__title" data-role="now-title"></div>
          <div class="cmdk-now__artist" data-role="now-artist"></div>
          <div class="cmdk-now__progress-row">
            <div class="cmdk-now__progress"><span data-role="now-progress"></span></div>
            <div class="cmdk-now__time" data-role="now-time">0:00</div>
          </div>
        </div>
      </div>
      <div class="cmdk-composer">
        <div class="cmdk-input-row">
          <span class="cmdk-mark" aria-hidden="true">${GLYPH.MARK}</span>
          <input class="cmdk-input" spellcheck="false" placeholder="What would you like to hear?" aria-label="Search songs or commands">
        </div>
        <div class="cmdk-toolbar">
          <button class="cmdk-tool" data-role="slash" title="Commands" aria-label="Commands">/</button>
          <button class="cmdk-tool cmdk-tool--heart" data-role="heart" title="Like (⌘D)" aria-label="Like">${GLYPH.LIKED}</button>
          <span class="cmdk-toolbar__gap"></span>
          <button class="cmdk-session" data-role="session" title="Change mode"></button>
          <button class="cmdk-send" data-role="send" aria-label="Play or pause"></button>
        </div>
      </div>
      <div class="cmdk-chips" data-role="chips"></div>
      <div class="cmdk-list-wrap">
        <ul class="cmdk-list"></ul>
      </div>
      <div class="cmdk-toast" role="status"></div>
    </div>`;

  panelEl      = rootEl.querySelector('.cmdk-panel');
  inputEl      = rootEl.querySelector('.cmdk-input');
  listEl       = rootEl.querySelector('.cmdk-list');
  toastEl      = rootEl.querySelector('.cmdk-toast');
  sessionEl    = rootEl.querySelector('[data-role=session]');
  nowEl        = rootEl.querySelector('[data-role=now]');
  nowMetaEl    = rootEl.querySelector('.cmdk-now__meta');
  nowCoverEl   = rootEl.querySelector('[data-role=now-cover]');
  nowTitleEl   = rootEl.querySelector('[data-role=now-title]');
  nowArtistEl  = rootEl.querySelector('[data-role=now-artist]');
  nowTimeEl    = rootEl.querySelector('[data-role=now-time]');
  nowProgressEl = rootEl.querySelector('[data-role=now-progress]');
  greetingEl   = rootEl.querySelector('[data-role=greeting]');
  greetingTextEl = rootEl.querySelector('[data-role=greeting-text]');
  sendEl       = rootEl.querySelector('[data-role=send]');
  heartEl      = rootEl.querySelector('[data-role=heart]');
  chipsEl      = rootEl.querySelector('[data-role=chips]');

  // Gliding cursor — lives in the list wrapper, not inside the <ul>.
  cursorEl = document.createElement('div');
  cursorEl.className = 'cmdk-cursor';
  cursorEl.setAttribute('aria-hidden', 'true');
  rootEl.querySelector('.cmdk-list-wrap').appendChild(cursorEl);

  // Init subsystems
  accent.init(rootEl.querySelector('[data-role=ambient]'));
  tx.initCoverTilt(nowCoverEl);
  playlist.boot();
  injectSetInput((v) => { inputEl.value = v; refresh(); });

  // Event listeners
  listEl.addEventListener('scroll', () => positionCursor(true), { passive: true });
  // IME (日本語 / 拼音 …): while a composition is open the input holds
  // half-typed romaji / pinyin — don't search on it, and don't let the Enter
  // that confirms the candidate fall through to "play the first result".
  inputEl.addEventListener('compositionstart', () => { composing = true; });
  inputEl.addEventListener('compositionend', () => { composing = false; refresh(); });
  inputEl.addEventListener('input', () => { if (!composing) refresh(); });
  inputEl.addEventListener('keydown', onKey);
  wireComposer();

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); actions.openCmdk(); }
    // ⌘D — like / unlike the currently-playing track, from anywhere in the app
    // (idle or search). Per-row liking in results is still available via ⌘-click.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      toggleCurrent();
      return;
    }
    if (e.key === 'Escape' && store.get().cmdkOpen) {
      if (inputEl.value.trim()) { inputEl.value = ''; refresh(); }
      else doHide();
    }
  });

  // Store subscriptions
  store.select((s) => s.cmdkOpen, (open) => {
    rootEl.classList.toggle('open', open);
    if (open) { introPending = true; inputEl.value = pendingOpenInput; pendingOpenInput = ''; refresh(); setTimeout(() => inputEl.focus(), 10); }
  });
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${Math.floor(s.player.currentTime)}|${Math.floor(s.player.duration)}`,
    renderNow
  );
  store.select((s) => s.player.track?.id ?? null, (id, prevId) => {
    // During an Enter → home landing the choreography already moves the
    // now-area; layering the generic cross-fade on top reads as a stutter.
    if (prevId !== undefined && id !== prevId && id !== null && !landing) tx.onTrackChange(nowEl);
  });
  // Paused ⇒ the cover dims and the progress line goes quiet (CSS .paused).
  store.selectKey(
    (s) => `${s.player.playing}|${!!s.player.track}`,
    (s) => panelEl.classList.toggle('paused', !!s.player.track && !s.player.playing)
  );
  // Why this queue exists — mode / manual / radio / playlist — always visible.
  store.selectKey(
    (s) => `${s.playbackSession?.kind ?? ''}|${s.playbackSession?.modeId ?? ''}|${s.playbackSession?.label ?? ''}`,
    (s) => { sessionEl.textContent = sessionText(s.playbackSession); }
  );
  // Composer state: the send button doubles as play/pause while the input is
  // empty; the heart shows whether the current track is in the library.
  store.selectKey((s) => `${s.player.playing}|${!!s.player.track}`, renderSend);
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${s.library.tracks.length}`,
    (s) => {
      const id = s.player.track?.id;
      heartEl.classList.toggle('on', !!id && s.library.tracks.some((t) => t.id === id));
      heartEl.disabled = !id;
    }
  );
  store.selectKey(
    (s) => `${s.playbackSession?.kind ?? ''}|${s.playbackSession?.modeId ?? ''}`,
    renderChips
  );
  store.select((s) => s.user?.nickname ?? '', renderGreeting);
  // A theme swap changes row metrics (type, padding) under a cursor that was
  // measured for the old ones — re-seat it without the glide.
  store.selectKey(
    (s) => `${s.appearance.theme}|${s.appearance.scheme}`,
    () => requestAnimationFrame(() => positionCursor(false))
  );

  // Window appear (global hotkey). Focus synchronously — the first keystroke
  // after ⌥Space must never be lost — and start from a clean slate: a blur-hide
  // may have left a half-typed query behind.
  window.muse.onWindowAppear?.(() => {
    if (inputEl.value) { inputEl.value = ''; entries = []; renderList(); setIdle(true, { instant: true }); }
    renderGreeting(store.get().user?.nickname ?? '');   // the hour may have turned
    tx.animateAppear(panelEl);
    inputEl.focus();
  });
}

// ---- Now-playing ------------------------------------------------------------

function renderNow() {
  const p = store.get().player;
  const t = p.track;
  greetingEl.hidden = !!t;
  if (!t) { nowEl.hidden = true; return; }
  nowEl.hidden = false;

  const isNewTrack = t.id !== lastRenderedTrackId;
  lastRenderedTrackId = t.id;
  if (isNewTrack) {
    if (t.name) tx.scrambleText(nowTitleEl, t.name, 380);
    else nowTitleEl.textContent = t.name || '';
    nowArtistEl.textContent = formatArtists(t) || t.al?.name || '';
  }

  nowTimeEl.textContent = fmtTime(p.currentTime || 0);
  const pct = p.duration ? Math.max(0, Math.min(1, p.currentTime / p.duration)) : 0;
  nowProgressEl.style.width = `${pct * 100}%`;

  const cover = t.al?.picUrl;
  if (cover && cover !== lastNowCover) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (store.get().player.track?.al?.picUrl !== cover) return;
      nowCoverEl.style.setProperty('--cover', `url("${cover}")`);
      tx.popEl(nowCoverEl);
      accent.update(cover);
    };
    img.src = cover;
  } else if (!cover) {
    nowCoverEl.style.removeProperty('--cover');
  }
  lastNowCover = cover || '';
}

// ---- Refresh (main dispatch) ------------------------------------------------

let pendingOpenInput = '';
export function openWith(prefill) { pendingOpenInput = String(prefill || ''); actions.openCmdk(); }

let searchCtrl = null;

function refresh() {
  const raw = inputEl.value.trim();
  const isCmd = raw.startsWith('/');
  const q = isCmd ? raw.slice(1).trim() : raw;

  if (isCmd)     entries = COMMAND_BUILDERS.flatMap((b) => b(q));
  else if (!q)   entries = [];
  else           entries = SONG_BUILDERS.flatMap((b) => b(q));

  lastQuery = isCmd ? '' : q;   // only highlight matches for bare search
  cursor = 0;
  thinking = !isCmd && !!q;
  renderList();
  renderSend();

  setIdle(!raw);

  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const ok = store.race('cmdk');
  if (isCmd || !q) return;

  let pending = ASYNC_BUILDERS.length;
  const settle = () => { if (ok() && --pending === 0) { thinking = false; renderList(); } };
  for (const b of ASYNC_BUILDERS) {
    b(q, { signal: searchCtrl.signal, ok })
      .then((res) => { if (ok()) { entries.push(...res); requestAnimationFrame(resizeToContent); } })
      .catch(() => {})
      .finally(settle);
  }
}

// ---- idle ⇄ search morph ------------------------------------------------------
//
// The cover is the shared element and travels (FLIP); the text next to it
// cross-fades; the list fades under it. Two directions, two tempos:
//
//   idle → search  (first keystroke)   immediate. Cover shrinks into the strip
//                                      in 200ms, the list rises underneath at
//                                      the same time. Nothing waits.
//   search → idle  (Enter / Esc)       staged. Rows fade (120ms) → window snaps
//                                      to the idle height while nothing is
//                                      visible below the strip → cover grows
//                                      into the hero with a soft settle.
const LEAVE_MS = 120;
function setIdle(wantIdle, { instant = false } = {}) {
  const panel = panelEl;
  if (!panel) return;
  clearTimeout(idleTimer);
  const seq = ++idleSeq;
  const isIdle = panel.classList.contains('idle');
  if (wantIdle === isIdle) { panel.classList.remove('leaving-search'); return; }

  if (!wantIdle) {
    panel.classList.remove('leaving-search');
    tx.flip(nowCoverEl, () => panel.classList.remove('idle'), { duration: 200 });
    tx.replay(nowMetaEl, 'meta-in');
    resizeToContent();
    return;
  }

  if (instant) {
    panel.classList.remove('leaving-search');
    panel.classList.add('idle');
    resizeToContent();
    return;
  }

  panel.classList.add('leaving-search');
  idleTimer = setTimeout(async () => {
    await resizeTo(IDLE_H);
    if (seq !== idleSeq) return;
    panel.classList.remove('leaving-search');
    tx.flip(nowCoverEl, () => panel.classList.add('idle'), { duration: 300, easing: tx.EASE_SETTLE });
    tx.replay(nowMetaEl, 'meta-in');
  }, LEAVE_MS);
}

// Enter on something that changes what's playing: acknowledge the row first
// (a 140ms accent fill on the cursor), then go home. The hero landing with
// the new cover *is* the confirmation — no toast needed for the track itself.
function land() {
  landing = true;
  cursorEl?.classList.add('commit');
  setTimeout(() => cursorEl?.classList.remove('commit'), 160);
  setTimeout(() => {
    inputEl.value = '';
    refresh();
  }, 90);
  setTimeout(() => { landing = false; }, 700);
}

// ---- List rendering ---------------------------------------------------------

function renderList() {
  listEl.innerHTML = '';
  rowEls = [];
  if (!entries.length) {
    if (thinking) listEl.appendChild(thinkingRow());
    else if (inputEl.value.trim()) {
      const li = document.createElement('li');
      li.className = 'cmdk-empty';
      li.textContent = 'No matches';
      listEl.appendChild(li);
    }
    positionCursor(false);
    return;
  }
  const intro = introPending;
  introPending = false;

  // Per-group counts for the section headers (library / from netease).
  const counts = {};
  entries.forEach((e) => { if (e.group) counts[e.group] = (counts[e.group] || 0) + 1; });

  let prevGroup = null;
  entries.forEach((e, i) => {
    // Section header when the group changes.
    if (e.group && e.group !== prevGroup) {
      prevGroup = e.group;
      const h = document.createElement('li');
      h.className = 'cmdk-sec';
      const lbl = document.createElement('span'); lbl.className = 'sec-lbl'; lbl.textContent = e.group;
      const cnt = document.createElement('span'); cnt.className = 'sec-cnt'; cnt.textContent = counts[e.group];
      h.append(lbl, cnt);
      listEl.appendChild(h);
    }

    const li = document.createElement('li');
    li.className = 'row' + (i === cursor ? ' sel' : '');
    if (intro) { li.classList.add('in'); li.style.animationDelay = `${Math.min(i, 10) * 24}ms`; }

    if (e.name !== undefined) {
      // structured song row: glyph · name + artist · duration
      li.classList.add('song');
      if (e.dim) li.classList.add('dim');
      const gl = document.createElement('span'); gl.className = 'gl'; gl.textContent = e.glyph || '';
      const main = document.createElement('div'); main.className = 'rowmain';
      const nm = document.createElement('span'); nm.className = 'nm'; highlightInto(nm, e.name, lastQuery);
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = e.sub || '';
      main.append(nm, sub);
      const meta = document.createElement('span'); meta.className = 'meta';
      const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = e.dur || '';
      meta.append(dur);
      li.append(gl, main, meta);
    } else {
      // legacy label/hint row (commands, modes, hints)
      const label = document.createElement('span'); label.className = 'lbl'; label.textContent = e.label;
      const hint  = document.createElement('span'); hint.className = 'hint'; hint.textContent = e.hint || '';
      li.append(label, hint);
    }

    li.addEventListener('click', (ev) => execute(i, pickVariant(ev)));
    li.addEventListener('mousemove', () => setCursor(i));
    listEl.appendChild(li);
    rowEls.push(li);
  });
  if (thinking) listEl.appendChild(thinkingRow());
  positionCursor(false);
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
function highlightInto(el, text, q) {
  text = text || '';
  const query = (q || '').trim();
  el.textContent = '';
  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx < 0) { el.textContent = text; return; }
  el.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(idx, idx + query.length);
  el.appendChild(mark);
  el.appendChild(document.createTextNode(text.slice(idx + query.length)));
}

// ---- Cursor -----------------------------------------------------------------

function setCursor(i) {
  if (i === cursor || i < 0 || i >= entries.length) return;
  const prev = rowEls[cursor];
  if (prev) prev.classList.remove('sel');
  cursor = i;
  const next = rowEls[cursor];
  if (next) { next.classList.add('sel'); next.scrollIntoView({ block: 'nearest' }); }
  positionCursor(true);
}

function positionCursor(animate) {
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

// ---- Keyboard ---------------------------------------------------------------

function pickVariant(ev) {
  if (ev.metaKey && !ev.altKey) return 'heart';
  if (ev.altKey) return 'alt';
  return 'primary';
}

function onKey(e) {
  // Keys consumed by the IME (candidate navigation, the confirming Enter)
  // arrive with isComposing / keyCode 229 — never treat those as ours.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') { setCursor(Math.min(cursor + 1, entries.length - 1)); e.preventDefault(); return; }
  if (e.key === 'ArrowUp')   { setCursor(Math.max(cursor - 1, 0)); e.preventDefault(); return; }
  // ⌘D is handled globally (document keydown → toggleCurrent); don't also
  // act on the highlighted row here, or it'd double-fire.
  if (e.key === 'Enter') {
    const variant = (e.altKey || e.metaKey || e.shiftKey) ? 'alt' : 'primary';
    execute(cursor, variant);
    e.preventDefault();
  }
}

function execute(i, variant = 'primary') {
  const entry = entries[i]; if (!entry) return;
  const handler =
    variant === 'heart' && entry.heartRun ? entry.heartRun :
    variant === 'alt'   && entry.altRun   ? entry.altRun   :
    entry.run;
  // Entries flagged `home` land on the keypress itself. Their handlers may
  // spend seconds on the network (mode rebuilds, similar-track fetches, the
  // stream URL) — the store's now-playing catches up and the hero pops when
  // it does. Handlers may also *return* { home } once they know the outcome.
  const landedEarly = !!entry.home && variant !== 'heart';
  if (landedEarly) land();
  Promise.resolve()
    .then(() => handler())
    .then((res) => {
      if (res?.ok) showToast(res.ok, 'ok');
      if (res?.warn) showToast(res.warn, 'warn');
      if (res?.home && !landedEarly) land();
      else if (res?.close && !landedEarly) actions.closeCmdk();
      else if (variant === 'heart') refresh();
    })
    .catch((err) => { console.warn('cmdk run', err); showToast(err?.message || String(err), 'error'); });
}

// ---- Composer, chips, greeting -----------------------------------------------
//
// The input is a composer card: a toolbar under the text line (commands, like,
// the session/mode picker, a send button), mode chips below it at home, and a
// greeting in place of the hero when nothing is playing. All of it is mouse
// sugar over what the keyboard already does — nothing here is keyboard-only.

const ICON = {
  play:  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 3.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L6.1 3.1a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="3.4" width="2.6" height="9.2" rx=".9" fill="currentColor"/><rect x="9.2" y="3.4" width="2.6" height="9.2" rx=".9" fill="currentColor"/></svg>',
  send:  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.8V3.6M4 7.4l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function wireComposer() {
  // Buttons must never take focus from the input — the next keystroke is
  // always a search.
  rootEl.querySelectorAll('.cmdk-toolbar button, .cmdk-chips').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
  });
  rootEl.querySelector('[data-role=slash]').addEventListener('click', () => setInputValue('/'));
  heartEl.addEventListener('click', toggleCurrent);
  sessionEl.addEventListener('click', () => setInputValue('/mode '));
  sendEl.addEventListener('click', () => {
    if (inputEl.value.trim()) execute(cursor, 'primary');
    else player.toggle();
  });
  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-mode]');
    if (chip) actions.setMode(chip.dataset.mode);
  });
}

function setInputValue(v) {
  inputEl.value = v;
  inputEl.focus();
  refresh();
}

function renderSend() {
  if (!sendEl) return;
  const typing = !!inputEl.value.trim();
  const p = store.get().player;
  const kind = typing ? 'send' : (p.playing ? 'pause' : 'play');
  if (sendEl.dataset.kind === kind) return;
  sendEl.dataset.kind = kind;
  sendEl.innerHTML = ICON[kind];
  sendEl.setAttribute('aria-label', typing ? 'Run' : (p.playing ? 'Pause' : 'Play'));
  sendEl.disabled = !typing && !p.track;
}

function renderChips(s) {
  const active = s.playbackSession?.kind === 'mode' ? s.playbackSession.modeId : null;
  chipsEl.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.className = 'cmdk-chip' + (m.id === active ? ' on' : '');
    b.dataset.mode = m.id;
    b.title = m.description || '';
    b.textContent = cap(m.label);
    chipsEl.appendChild(b);
  }
}

// The picker reads like a model name: "Daily", "Radio · 夜に駆ける".
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function sessionText(session) {
  if (!session) return '';
  const mode = session.kind === 'mode' && MODES.find((m) => m.id === session.modeId);
  return mode ? cap(mode.label) : cap(session.label || '');
}

function renderGreeting(nickname) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  greetingTextEl.textContent = nickname ? `${part}, ${nickname}` : part;
}

// ---- Helpers ----------------------------------------------------------------

// Like / unlike whatever is playing right now. Toast is the only feedback
// (the now-playing area has no heart indicator), so we always show one.
function toggleCurrent() {
  const t = store.get().player.track;
  if (!t) { showToast('nothing playing', 'warn'); return; }
  toggleHeart(t)
    .then((r) => showToast(r.isHearted ? `liked · ${t.name}` : `unliked · ${t.name}`, 'ok'))
    .catch((err) => showToast(err?.message || 'like failed', 'error'));
}

function doHide() {
  tx.animateHide(panelEl, () => window.muse.hideWindow?.());
}

function showToast(msg, level = 'error') {
  if (!toastEl) return;
  toastEl.textContent = cap(String(msg));     // sentence case, whatever the caller wrote
  toastEl.dataset.level = level;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
