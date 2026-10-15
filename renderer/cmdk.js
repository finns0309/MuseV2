// Command palette — the sole UI surface of MuseV2.
//
// Idle state: the now-playing hero, the composer, mode chips under it.
// Search state: compact now-playing strip + composer + results list.
// The morph between the two is driven by the `.idle` class on `.cmdk-panel`.
//
// This file is the conductor: it mounts the DOM, decides what the list shows
// (refresh), owns the keyboard, runs entries (execute), and drives the idle ⇄
// search morph and the window height. The views live in ./ui —
//   hero.js      now-playing hero/strip + greeting
//   composer.js  input, scope chip, toolbar, mode chips
//   list.js      rows, section headers, cursor
//   toast.js     the pill
// What goes *in* the list comes from commands.js.

import { store, actions } from './store.js';
import * as accent from './accent.js';
import * as playlist from './playlist.js';
import * as tx from './transitions.js';
import { buildCommands, resolveScope, SONG_BUILDERS, ASYNC_BUILDERS, injectSetInput } from './commands.js';
import { GLYPH } from './glyphs.js';
import { toggleHeart } from './lib/library.js';
import * as hero from './ui/hero.js';
import * as composer from './ui/composer.js';
import * as list from './ui/list.js';
import * as toast from './ui/toast.js';

// ---- State ------------------------------------------------------------------

let rootEl, panelEl, inputEl;
let composing = false;    // IME composition in progress
let idleTimer = null;     // staged search → idle transition
let idleSeq = 0;          // invalidates an in-flight staged transition
let landing = false;      // Enter → home choreography owns the now-area for a moment

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
          <span class="cmdk-scope" data-role="scope" hidden></span>
          <input class="cmdk-input" spellcheck="false" placeholder="${composer.PLACEHOLDER}" aria-label="Search songs or commands">
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

  panelEl = rootEl.querySelector('.cmdk-panel');
  inputEl = rootEl.querySelector('.cmdk-input');

  // Gliding cursor — lives in the list wrapper, not inside the <ul>.
  const cursorEl = document.createElement('div');
  cursorEl.className = 'cmdk-cursor';
  cursorEl.setAttribute('aria-hidden', 'true');
  rootEl.querySelector('.cmdk-list-wrap').appendChild(cursorEl);

  // Views
  toast.mountToast(rootEl.querySelector('.cmdk-toast'));
  hero.mountHero(rootEl);
  composer.mountComposer(rootEl, {
    refresh: () => refresh(),
    runSelected: () => execute(list.getCursor(), 'primary'),
    toggleLike: toggleCurrent,
  });
  list.mountList({ list: rootEl.querySelector('.cmdk-list'), cursor: cursorEl, execute });

  // Subsystems
  accent.init(rootEl.querySelector('[data-role=ambient]'));
  playlist.boot();
  injectSetInput((v) => { inputEl.value = v; refresh(); });

  // IME (日本語 / 拼音 …): while a composition is open the input holds
  // half-typed romaji / pinyin — don't search on it, and don't let the Enter
  // that confirms the candidate fall through to "play the first result".
  inputEl.addEventListener('compositionstart', () => { composing = true; });
  inputEl.addEventListener('compositionend', () => { composing = false; refresh(); });
  inputEl.addEventListener('input', () => { if (!composing) refresh(); });
  inputEl.addEventListener('keydown', onKey);

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
      if (inputEl.value.trim() || composer.getScope()) { composer.reset(); refresh(); }
      else doHide();
    }
  });

  // Store subscriptions
  store.select((s) => s.cmdkOpen, (open) => {
    rootEl.classList.toggle('open', open);
    if (open) { list.armIntro(); inputEl.value = pendingOpenInput; pendingOpenInput = ''; refresh(); setTimeout(() => inputEl.focus(), 10); }
  });
  store.select((s) => s.player.track?.id ?? null, (id, prevId) => {
    // During an Enter → home landing the choreography already moves the
    // now-area; layering the generic cross-fade on top reads as a stutter.
    if (prevId !== undefined && id !== prevId && id !== null && !landing) tx.onTrackChange(hero.nowArea());
  });
  // Paused ⇒ the cover dims and the progress line goes quiet (CSS .paused).
  store.selectKey(
    (s) => `${s.player.playing}|${!!s.player.track}`,
    (s) => panelEl.classList.toggle('paused', !!s.player.track && !s.player.playing)
  );
  // A theme swap changes row metrics (type, padding) under a cursor that was
  // measured for the old ones — re-seat it without the glide.
  store.selectKey(
    (s) => `${s.appearance.theme}|${s.appearance.scheme}`,
    () => requestAnimationFrame(() => list.seat(false))
  );

  // Window appear (global hotkey). Focus synchronously — the first keystroke
  // after ⌥Space must never be lost — and start from a clean slate: a blur-hide
  // may have left a half-typed query behind.
  window.muse.onWindowAppear?.(() => {
    if (inputEl.value || composer.getScope()) { composer.reset(); list.render([]); setIdle(true, { instant: true }); }
    hero.renderGreeting();   // the hour may have turned
    tx.animateAppear(panelEl);
    inputEl.focus();
  });
}

// ---- Refresh (main dispatch) ------------------------------------------------

let pendingOpenInput = '';
export function openWith(prefill) { pendingOpenInput = String(prefill || ''); actions.openCmdk(); }

let searchCtrl = null;

function refresh({ keepCursor = false } = {}) {
  // `/theme ` — typed, pasted, or set by a button — becomes a chip + filter.
  if (!composer.getScope()) {
    const m = inputEl.value.match(/^\s*\/(\S+)\s([\s\S]*)$/);
    const sc = m && resolveScope(m[1]);
    if (sc) { composer.setScope(sc); inputEl.value = m[2]; }
  }
  const scope = composer.getScope();
  const raw = inputEl.value.trim();
  const isCmd = !!scope || raw.startsWith('/');
  const q = scope ? raw : isCmd ? raw.slice(1).trim() : raw;

  let entries;
  if (isCmd)     entries = buildCommands(scope ? raw : raw.slice(1), scope?.id);
  else if (!q)   entries = [];
  else           entries = SONG_BUILDERS.flatMap((b) => b(q));

  const view = { query: q, emptyText: raw ? 'No matches' : '' };
  list.render(entries, { ...view, thinking: !isCmd && !!q, keepCursor });
  composer.renderSend();

  setIdle(!raw && !scope);

  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const ok = store.race('cmdk');
  if (isCmd || !q) return;

  let pending = ASYNC_BUILDERS.length;
  const settle = () => {
    if (ok() && --pending === 0) list.render(entries, { ...view, thinking: false, keepCursor: true });
  };
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
    tx.flip(hero.cover(), () => panel.classList.remove('idle'), { duration: 200 });
    tx.replay(hero.meta(), 'meta-in');
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
    tx.flip(hero.cover(), () => panel.classList.add('idle'), { duration: 300, easing: tx.EASE_SETTLE });
    tx.replay(hero.meta(), 'meta-in');
  }, LEAVE_MS);
}

// Enter on something that changes what's playing: acknowledge the row first
// (a 140ms accent fill on the cursor), then go home. The hero landing with
// the new cover *is* the confirmation — no toast needed for the track itself.
function land() {
  landing = true;
  list.flashCommit();
  setTimeout(() => {
    composer.reset();
    refresh();
  }, 90);
  setTimeout(() => { landing = false; }, 700);
}

// ---- Keyboard ---------------------------------------------------------------

function onKey(e) {
  // Keys consumed by the IME (candidate navigation, the confirming Enter)
  // arrive with isComposing / keyCode 229 — never treat those as ours.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') { list.move(1); e.preventDefault(); return; }
  if (e.key === 'ArrowUp')   { list.move(-1); e.preventDefault(); return; }
  // Into a submenu: Tab, or → when the caret is already at the end.
  const atEnd = inputEl.selectionStart === inputEl.value.length && inputEl.selectionEnd === inputEl.value.length;
  const sel = list.current();
  if (sel?.submenu && (e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd))) {
    composer.enterScope(sel.submenu);
    e.preventDefault();
    return;
  }
  // Out of one: Backspace / ← at the very start drops the chip (the text
  // stays, now searching every command).
  const atStart = inputEl.selectionStart === 0 && inputEl.selectionEnd === 0;
  if (composer.getScope() && atStart && (e.key === 'Backspace' || e.key === 'ArrowLeft')) {
    const rest = inputEl.value;
    composer.setScope(null);
    inputEl.value = '/' + rest;
    inputEl.setSelectionRange(1, 1);
    refresh();
    e.preventDefault();
    return;
  }
  // ⌘D is handled globally (document keydown → toggleCurrent); don't also
  // act on the highlighted row here, or it'd double-fire.
  if (e.key === 'Enter') {
    const variant = (e.altKey || e.metaKey || e.shiftKey) ? 'alt' : 'primary';
    execute(list.getCursor(), variant);
    e.preventDefault();
  }
}

function execute(i, variant = 'primary') {
  const entry = list.getEntries()[i]; if (!entry) return;
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
      if (res?.scope) { composer.enterScope(res.scope); return; }
      if (res?.ok) toast.show(res.ok, 'ok');
      if (res?.warn) toast.show(res.warn, 'warn');
      if (res?.home && !landedEarly) land();
      else if (res?.close && !landedEarly) actions.closeCmdk();
      else if (variant === 'heart') refresh({ keepCursor: true });
      // A menu choice (theme, accent, light/dark) keeps the menu open and
      // re-renders so the ✓ moves — flipping through themes is one key each.
      else if (!landedEarly) refresh({ keepCursor: true });
    })
    .catch((err) => { console.warn('cmdk run', err); toast.show(err?.message || String(err), 'error'); });
}

// ---- Helpers ----------------------------------------------------------------

// Like / unlike whatever is playing right now. The toolbar heart reflects it;
// the toast says which way it went.
function toggleCurrent() {
  const t = store.get().player.track;
  if (!t) { toast.show('nothing playing', 'warn'); return; }
  toggleHeart(t)
    .then((r) => toast.show(r.isHearted ? `liked · ${t.name}` : `unliked · ${t.name}`, 'ok'))
    .catch((err) => toast.show(err?.message || 'like failed', 'error'));
}

function doHide() {
  tx.animateHide(panelEl, () => window.muse.hideWindow?.());
}
