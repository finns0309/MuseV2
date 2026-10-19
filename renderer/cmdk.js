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
import { buildCommands, resolveScope, SONG_BUILDERS, ASYNC_BUILDERS, injectSetInput, askEntry, answerEntries, playlistEntries, playAsk } from './commands.js';
import * as askLib from './lib/ask.js';
import * as dj from './lib/dj.js';
import * as col from './lib/collections.js';
import * as remote from './lib/remote.js';
import { GLYPH } from './glyphs.js';
import { toggleHeart } from './lib/library.js';
import * as hero from './ui/hero.js';
import * as composer from './ui/composer.js';
import * as list from './ui/list.js';
import * as toast from './ui/toast.js';
import * as info from './ui/info.js';
import * as ambient from './ui/ambient.js';
import * as memory from './lib/memory.js';

// ---- State ------------------------------------------------------------------

let rootEl, panelEl, inputEl;
let composing = false;    // IME composition in progress
let idleTimer = null;     // staged search → idle transition
let idleSeq = 0;          // invalidates an in-flight staged transition
let landing = false;      // Enter → home choreography owns the now-area for a moment
let askEnabled = false;   // llm.json present (main process) — otherwise no Ask row
let view = null;          // a conversation (or a Muse playlist) the list is showing: { kind: 'ask'|'playlist', id }
let viewFresh = false;    // just opened, or a new turn: anchor the thread on its last bubble
let viewTurns = 0;        // turns drawn last time — a new one re-anchors
let ideaIdx = -1;         // ⇥ walks the DJ's follow-up ideas into the input
let viewWasThinking = false; // the answer arriving under your eyes cascades in
// Away: the window is hidden. main says so on every hide (document.hidden can
// lag: a never-shown window, or one hidden while the Mac is locked).
let away = window.muse.shownAtStart === false;
const isAway = () => away || document.hidden;

// ---- Window resize ----------------------------------------------------------

// Two fixed heights, nothing in between: the window must never change size
// while the user is typing (async cloud results used to grow it mid-word).
// Idle is 3:2 — tall enough that the hero (cover, title, progress, the
// song's story line) sits with air above it over the composer + chips.
// Below ~470 the hero overflows its area and the cover gets pushed up
// against the top edge.
const IDLE_H = 480;
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
        <div class="cmdk-greeting__line">
          <span class="cmdk-greeting__spark" aria-hidden="true"></span>
          <span data-role="greeting-text"></span>
        </div>
        <div class="cmdk-greeting__sub" data-role="greeting-sub"></div>
      </div>
      <div class="cmdk-now" data-role="now" hidden>
        <div class="cmdk-now__cover" data-role="now-cover">
          <div class="cmdk-now__art" data-role="cover-art"></div>
          <div class="cmdk-now__art cmdk-now__art--prev" data-role="cover-prev"></div>
          <div class="cmdk-now__transport" data-role="transport">
            <button data-act="prev" aria-label="Previous" title="Previous  ⌘←"></button>
            <button data-act="toggle" class="main" aria-label="Play or pause" title="Play / pause  ⌘P"></button>
            <button data-act="next" aria-label="Next" title="Next  ⌘→"></button>
          </div>
        </div>
        <div class="cmdk-now__meta">
          <div class="cmdk-now__title" data-role="now-title"></div>
          <div class="cmdk-now__artist" data-role="now-artist"></div>
          <div class="cmdk-now__progress-row" data-role="progress-row">
            <div class="cmdk-now__progress"><span data-role="now-progress"></span></div>
            <div class="cmdk-now__time" data-role="now-time">0:00</div>
            <span class="cmdk-now__scrub" data-role="scrub" aria-hidden="true"></span>
          </div>
          <div class="cmdk-now__context" data-role="now-context"></div>
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
          <button class="cmdk-asking" data-role="asking" hidden><span class="cmdk-spark" aria-hidden="true"></span><span></span></button>
          <button class="cmdk-sleep" data-role="sleep" title="Sleep timer" hidden></button>
          <button class="cmdk-session" data-role="session" title="Change mode"></button>
          <button class="cmdk-send" data-role="send" aria-label="Play or pause"></button>
        </div>
      </div>
      <div class="cmdk-chips" data-role="chips"></div>
      <div class="cmdk-list-wrap">
        <ul class="cmdk-list"></ul>
      </div>
      <div class="cmdk-keys" data-role="keys" aria-hidden="true"></div>
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
    refresh: (opts) => refresh(opts),
    runSelected: () => submit(),
    toggleLike: toggleCurrent,
    openAsk: (id) => openView('ask', id),
    openPlaylist: (id) => openView('playlist', id),
  });
  list.mountList({
    list: rootEl.querySelector('.cmdk-list'),
    cursor: cursorEl,
    keys: rootEl.querySelector('[data-role=keys]'),
    execute,
    scoped: () => !!composer.getScope(),
    cursorChanged: (entry) => info.show(entry),
    suggest: (text) => followUp(text),
  });
  info.mountInfo(rootEl.querySelector('.cmdk-list-wrap'));
  ambient.mountAmbient(panelEl);
  memory.prime();

  // Subsystems
  askLib.available().then((on) => { askEnabled = on; });
  dj.recover();
  dj.onLanded(landAsk);
  remote.mount();
  remote.onActivity(redrawAsks);
  // An ask moving (thinking → answered, a new one, one forgotten) shows in
  // whatever list is about asks — the conversation, /asks, /playlists, the
  // / menu's Asks row.
  col.onChange(redrawAsks);
  dj.onPending(redrawAsks);
  window.muse.onOpenAsk?.((id) => openView('ask', id));
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
    // ⌘C with nothing selected copies the song — the selected row's, or
    // what's playing — as "title — artists" + its NetEase link.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      const textSelected = !!window.getSelection()?.toString() || inputEl.selectionStart !== inputEl.selectionEnd;
      const searching = !panelEl.classList.contains('idle');
      const t = (searching && list.current()?.track) || store.get().player.track;
      if (!textSelected && t) { e.preventDefault(); copySong(t); }
      return;
    }
    // ⌘I — the selected song's story beside the list. At home there's no
    // list, so it opens the queue with what's playing selected.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      if (panelEl.classList.contains('idle') && !inputEl.value) {
        composer.enterScope('queue');
        info.setOpen(true, list.current());
      } else info.setOpen(!info.isOpen(), list.current());
      return;
    }
    if (e.key === 'Escape' && store.get().cmdkOpen) {
      if (view) {
        // A half-written reply goes first; then the conversation. Leaving one
        // that's still thinking is the point — it carries on, and plays when
        // it's ready — so that Esc closes the window outright.
        if (inputEl.value.trim()) { inputEl.value = ''; refresh(); }
        else if (view.kind === 'ask' && dj.isThinking(view.id)) doHide();
        else { closeView(); refresh(); }
        return;
      }
      if (inputEl.value.trim() || composer.getScope()) { composer.reset(); refresh(); }
      else doHide();
    }
  });

  // Store subscriptions
  store.select((s) => s.cmdkOpen, (open) => {
    rootEl.classList.toggle('open', open);
    if (open) { list.armIntro(); inputEl.value = pendingOpenInput; pendingOpenInput = ''; refresh(); setTimeout(() => inputEl.focus(), 10); }
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
    () => {
      // The theme's styles are already applied (app.js subscribes first), so
      // offsets are current now; again shortly after for the font swap.
      list.seat(false);
      composer.reseatChips();
      setTimeout(() => { list.seat(false); composer.reseatChips(); }, 250);
    }
  );

  // Window appear (global hotkey). Focus synchronously — the first keystroke
  // after ⌥Space must never be lost — and start from a clean slate: a blur-hide
  // may have left a half-typed query behind.
  window.muse.onWindowHidden?.(() => { away = true; });
  window.muse.onWindowAppear?.(() => {
    away = false;
    closeView();
    if (inputEl.value || composer.getScope()) { composer.reset(); list.render([]); setIdle(true, { instant: true }); }
    composer.renderSend();
    hero.renderGreeting();   // the hour may have turned
    composer.reseatChips();
    tx.animateAppear(panelEl);
    inputEl.focus();
  });
}

// ---- Refresh (main dispatch) ------------------------------------------------

let pendingOpenInput = '';
export function openWith(prefill) { pendingOpenInput = String(prefill || ''); actions.openCmdk(); }

let searchCtrl = null;

// motion: 'forward' (into a submenu) / 'back' (out of one) — the list
// slides in from that side so the hierarchy reads without thinking.
function refresh({ keepCursor = false, motion = null } = {}) {
  // `/theme ` — typed, pasted, or set by a button — becomes a chip + filter.
  if (!composer.getScope()) {
    const m = inputEl.value.match(/^\s*\/(\S+)\s([\s\S]*)$/);
    const sc = m && resolveScope(m[1]);
    if (sc) { composer.setScope(sc); inputEl.value = m[2]; }
  }
  const scope = composer.getScope();
  const raw = inputEl.value.trim();

  // A conversation owns the list while it's open — its chip in the input
  // row, the input its reply box. Leaving it never stops the DJ (lib/dj.js).
  if (view && !col.get(view.kind === 'ask' ? 'asks' : 'playlists', view.id)) closeView();
  if (view) {
    renderView();
    composer.renderSend();
    setIdle(false);
    searchCtrl?.abort();
    return;
  }

  const isCmd = !!scope || raw.startsWith('/');
  const isAsk = !isCmd && raw.startsWith('?');          // `?…` goes straight to the DJ
  const q = scope ? raw : isCmd || isAsk ? raw.slice(1).trim() : raw;

  let entries;
  if (isCmd)       entries = buildCommands(scope ? raw : raw.slice(1), scope?.id);
  else if (isAsk)  entries = askEnabled && q ? [askEntry(q)] : [];
  else if (!q)     entries = [];
  else {
    entries = SONG_BUILDERS.flatMap((b) => b(q));
    // Ask sits above the results when the query reads like a request (or
    // nothing matched), below them when it reads like a title.
    if (askEnabled && q.length >= 2) {
      if (askLib.looksLikeAsk(q) || !entries.length) entries.unshift(askEntry(q));
      else entries.push(askEntry(q));
    }
  }

  const shown = { query: q, emptyText: raw ? 'No matches' : '' };
  list.render(entries, { ...shown, thinking: !isCmd && !isAsk && !!q, keepCursor, motion });
  composer.renderSend();

  setIdle(!raw && !scope);

  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const ok = store.race('cmdk');
  if (isCmd || isAsk || !q) return;

  let pending = ASYNC_BUILDERS.length;
  const settle = () => {
    if (ok() && --pending === 0) list.render(entries, { ...shown, thinking: false, keepCursor: true });
  };
  for (const b of ASYNC_BUILDERS) {
    b(q, { signal: searchCtrl.signal, ok })
      .then((res) => { if (ok()) { entries.push(...res); requestAnimationFrame(resizeToContent); } })
      .catch(() => {})
      .finally(settle);
  }
}

// ---- Ask ---------------------------------------------------------------------
//
// Enter on the Ask row (or `?…`) sends the request to the DJ (lib/dj.js) and
// opens the conversation: a chip names it (✻ 夜行重拍), your requests are
// bubbles, the DJ's earlier answers quiet lines, and the latest answer a card
// over its songs. The input becomes the reply box — say "quieter" and the DJ
// edits the playlist; ⇥ walks its own ideas into the input. While it thinks
// the spark turns and the line says what it's doing ("Searching NetEase for
// “Sparkle”…"). Esc, ⌫ back to /asks, closing the window — none of it stops
// the DJ; the ask is kept, and the ✻ session label opens it again later.

function startAsk(q, { againOf = null } = {}) {
  try { openView('ask', dj.send(q, { againOf })); }
  catch (e) { toast.show(e.message, 'warn'); }
}

// A reply in an open conversation: the DJ takes it as a follow-up.
function followUp(text) {
  const q = String(text || '').trim();
  if (!q || view?.kind !== 'ask') return;
  try { dj.send(q, { followUpOf: view.id }); }
  catch (e) { toast.show(e.message, 'warn'); return; }
  inputEl.value = '';
  ideaIdx = -1;
  viewFresh = true;
  refresh();
}

// Enter, or the send button: in a conversation with something typed, that's
// a reply; otherwise the selected row runs.
function submit() {
  if (view?.kind === 'ask' && inputEl.value.trim()) followUp(inputEl.value);
  else execute(list.getCursor(), 'primary');
}

function openView(kind, id) {
  const item = col.get(kind === 'ask' ? 'asks' : 'playlists', id);
  if (!item) return;
  view = { kind, id };
  viewFresh = true;
  ideaIdx = -1;
  list.armIntro();
  inputEl.value = '';
  setViewChip();
  panelEl.classList.add('viewing-ask');
  inputEl.focus();
  refresh();
}

function closeView() {
  if (!view) return;
  view = null;
  ideaIdx = -1;
  viewWasThinking = false;
  panelEl.classList.remove('viewing-ask');
  if (composer.getScope()?.convo) composer.setScope(null);
}

// The chip in the input row says whose conversation this is; the
// placeholder offers the DJ's first idea as an example reply.
function setViewChip() {
  if (!view) return;
  if (view.kind === 'playlist') {
    const pl = col.get('playlists', view.id);
    composer.setScope({ id: 'convo', convo: true, title: `♪ ${pl?.name || ''}`, placeholder: 'Filter these songs…' });
    return;
  }
  const ask = col.get('asks', view.id);
  const pl = ask?.playlistId ? col.get('playlists', ask.playlistId) : null;
  const title = pl?.name || ask?.title || 'Asking';
  const idea = dj.lastTurn(ask)?.suggestions?.[0];
  composer.setScope({
    id: 'convo', convo: true, title: `✻ ${title}`,
    placeholder: dj.isThinking(ask?.id) ? 'The DJ is thinking — Esc, and it plays when it’s ready'
      : idea ? `Reply — “${idea}”…` : 'Reply — quieter, more like the first one…',
  });
}

function renderView() {
  const fresh = viewFresh;
  viewFresh = false;
  setViewChip();
  if (view.kind === 'playlist') {
    const pl = col.get('playlists', view.id);
    list.render(playlistEntries(pl, inputEl.value), { keepCursor: !fresh, query: inputEl.value.trim() });
    return;
  }
  const ask = col.get('asks', view.id);
  const turns = ask.turns;
  const latest = turns[turns.length - 1];
  const anchor = fresh || turns.length !== viewTurns;
  viewTurns = turns.length;
  const before = [];
  turns.forEach((t, i) => {
    before.push({ kind: 'bubble', text: t.q, via: t.via });
    if (i < turns.length - 1) {
      before.push({
        kind: 'said', error: t.status === 'error',
        title: t.status === 'error' ? '' : t.title,
        text: t.status === 'error' ? `Couldn’t answer — ${t.error || ''}` : t.reply || '',
        meta: t.tracks?.length ? `${t.tracks.length} songs` : '',
      });
    }
  });
  const typing = !!inputEl.value.trim();
  if (latest.status === 'thinking') {
    viewWasThinking = true;
    // A follow-up keeps the playlist in view, dimmed, under the line saying
    // what the DJ is doing to it; a first ask has only the line.
    const holds = dj.tracksOf(ask).length ? answerEntries(ask) : [];
    list.render(holds, {
      before, anchor, keepCursor: !fresh, thinkingFirst: true,
      thinking: dj.progressOf(ask.id) || 'Reading your library…',
      legend: [['esc', 'Leave it with me — it plays when it’s ready']],
    });
    return;
  }
  if (viewWasThinking) { viewWasThinking = false; list.armIntro(); }
  list.render(answerEntries(ask), {
    before, anchor, keepCursor: !fresh,
    legend: typing ? [['↵', 'Send to the DJ'], ['esc', 'Clear']] : null,
  });
}

// ⇥ with nothing typed: the DJ's next idea into the input, ready to send.
function nextIdea() {
  if (view?.kind !== 'ask') return false;
  const ideas = dj.lastTurn(col.get('asks', view.id))?.suggestions || [];
  if (!ideas.length || (inputEl.value.trim() && !ideas.includes(inputEl.value.trim()))) return false;
  ideaIdx = (ideaIdx + 1) % ideas.length;
  inputEl.value = ideas[ideaIdx];
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  refresh();
  return true;
}

// An ask landing changes several things at once (its playlist, itself, the
// pending set) — one redraw for the lot, so an arriving answer's rows can
// cascade in without the next redraw cutting them off.
let redrawTimer = null;
function redrawAsks() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => { if (showingAsks()) refresh({ keepCursor: true }); }, 0);
}

// Is the list about asks right now (so an ask changing should redraw it)?
function showingAsks() {
  if (!panelEl || panelEl.classList.contains('idle')) return false;
  const sc = composer.getScope()?.id;
  return !!view || sc === 'asks' || sc === 'playlist' || sc === 'agents' || (!sc && inputEl.value.trim().startsWith('/'));
}

// An answer came back. Watching it? It's already on screen (col.onChange
// redrew the conversation). Otherwise you left it with the DJ: if nothing
// about the music changed since you asked, it plays — old song fades, new
// queue in, the session label becomes its title. If you've since picked
// something else yourself, it doesn't barge in; it's ready in /asks.
// Away from the window, a notification says which; here, the toast does.
//
// An agent's ask lands its own way: 'play' plays it (the agent was told
// to), 'keep' only keeps it — the agent reports back itself.
function landAsk({ ask, turn, sessionAt, land }) {
  if (view?.kind === 'ask' && view.id === ask.id && !isAway()) return;
  const title = turn.title || ask.title;
  const failed = turn.status !== 'done' || !turn.tracks?.length;
  if (land === 'keep') {
    if (!isAway() && !failed) toast.show(`✻ ${title} · made for ${turn.via || 'an agent'}`, 'ok');
    return;
  }
  if (failed) {
    tell(turn.status === 'error' ? 'Couldn’t ask' : `✻ ${title || 'Nothing fit'}`, turn.error || turn.reply || '', ask.id, 'warn');
    return;
  }
  if (land === 'play' || (store.get().playbackSession?.startedAt ?? 0) === sessionAt) {
    // An edit to what's already playing ("quieter") keeps the current song
    // going if it survived the edit — the new list just closes around it.
    const cur = store.get().player.track?.id;
    playAsk(ask, Math.max(0, dj.tracksOf(ask).findIndex((t) => t.id === cur)));
    tell(`✻ ${title}`, turn.reply, ask.id, 'ok');
  } else {
    tell(`✻ ${title} is ready`, `${turn.tracks.length} songs — ${turn.reply}`, ask.id, 'ok', '/asks');
  }
}

function tell(title, body, askId, tone, where = '') {
  if (isAway()) window.muse.notify?.({ title, body, askId });
  else toast.show(where ? `${title} · ${where}` : title, tone);
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
    composer.reseatChips();
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
    composer.reseatChips();
  }, LEAVE_MS);
}

// Enter on something that changes what's playing: acknowledge the row first
// (a 140ms accent fill on the cursor), then go home. The hero landing with
// the new cover *is* the confirmation — no toast needed for the track itself.
function land() {
  landing = true;
  list.flashCommit();
  setTimeout(() => {
    closeView();
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
  const sel = list.current();
  // Queue editing on the selected row comes first — these chords would
  // otherwise read as plain ↑↓ / the chip's Backspace. ⌥↑/⌥↓ move it, ⌘⌫
  // removes it (only with an empty input — otherwise ⌘⌫ deletes text).
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel?.moveRun) {
    execute(list.getCursor(), e.key === 'ArrowUp' ? 'up' : 'down');
    e.preventDefault();
    return;
  }
  if (e.metaKey && e.key === 'Backspace' && !inputEl.value && sel?.removeRun) {
    execute(list.getCursor(), 'remove');
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') { list.move(1); e.preventDefault(); return; }
  if (e.key === 'ArrowUp')   { list.move(-1); e.preventDefault(); return; }
  // In a conversation: ⇥ brings in the DJ's ideas; ⌫ / ← at the very start
  // of an empty reply steps back out to the list it came from.
  if (view) {
    if (e.key === 'Tab' && !e.shiftKey && nextIdea()) { e.preventDefault(); return; }
    if (!inputEl.value && (e.key === 'Backspace' || e.key === 'ArrowLeft')) {
      const back = view.kind === 'ask' ? 'asks' : 'playlist';
      closeView();
      composer.setScope(resolveScope(back));
      refresh({ motion: 'back' });
      e.preventDefault();
      return;
    }
  }
  // Into a submenu: Tab, or → when the caret is already at the end.
  const atEnd = inputEl.selectionStart === inputEl.value.length && inputEl.selectionEnd === inputEl.value.length;
  if ((sel?.submenu || sel?.openRun) && (e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd))) {
    if (sel.submenu) composer.enterScope(sel.submenu);
    else execute(list.getCursor(), 'open');
    e.preventDefault();
    return;
  }
  // Out of one: Backspace / ← at the very start drops the chip (the text
  // stays, now searching every command).
  const atStart = inputEl.selectionStart === 0 && inputEl.selectionEnd === 0;
  if (composer.getScope() && !view && atStart && (e.key === 'Backspace' || e.key === 'ArrowLeft')) {
    const rest = inputEl.value;
    composer.setScope(null);
    inputEl.value = '/' + rest;
    inputEl.setSelectionRange(1, 1);
    refresh({ motion: 'back' });
    e.preventDefault();
    return;
  }
  // An empty input at home: ←/→ skip back / ahead 10s (⇧ for 30s).
  if (!inputEl.value && !composer.getScope() && !e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    hero.nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 30 : 10));
    e.preventDefault();
    return;
  }
  // ↵ play · ⌥↵ radio · ⌘↵ play next · ⇧↵ add to queue.
  // ⌘D is handled globally (document keydown → toggleCurrent); don't also
  // act on the highlighted row here, or it'd double-fire.
  if (e.key === 'Enter') {
    const variant = e.altKey ? 'alt' : e.metaKey ? 'next' : e.shiftKey ? 'queue' : 'primary';
    if (variant === 'primary') submit();
    else execute(list.getCursor(), variant);
    e.preventDefault();
  }
}

// Variants: primary (↵) · alt (⌥↵, radio) · next (⌘↵) · queue (⇧↵) · heart
// (⌘-click) · remove (⌘⌫) · up / down (⌥↑↓) · open (→ / ⇥ on an ask). An entry without the matching
// handler falls back to its primary run (a menu row doesn't care about ⌘).
const VARIANT_RUN = {
  alt: (e) => e.altRun, next: (e) => e.nextRun, queue: (e) => e.queueRun,
  heart: (e) => e.heartRun, remove: (e) => e.removeRun, open: (e) => e.openRun,
  up: (e) => e.moveRun && (() => e.moveRun(-1)),
  down: (e) => e.moveRun && (() => e.moveRun(1)),
};

function execute(i, variant = 'primary') {
  const entry = list.getEntries()[i]; if (!entry) return;
  const special = VARIANT_RUN[variant]?.(entry);
  if (!special && variant !== 'primary' && variant !== 'next' && variant !== 'queue') return;
  const handler = special || entry.run;
  // Entries flagged `home` land on the keypress itself. Their handlers may
  // spend seconds on the network (mode rebuilds, similar-track fetches, the
  // stream URL) — the store's now-playing catches up and the hero pops when
  // it does. Handlers may also *return* { home } once they know the outcome.
  // Queue edits and likes never land: you're still choosing.
  const landedEarly = !!entry.home && (handler === entry.run || (variant === 'alt' && entry.name !== undefined));
  if (landedEarly) land();
  Promise.resolve()
    .then(() => handler())
    .then((res) => {
      if (res?.scope) { composer.enterScope(res.scope); return; }
      if (res?.ask) {
        if (res.againOf) {
          try { dj.send(res.ask, { againOf: res.againOf }); openView('ask', res.againOf); }
          catch (e) { toast.show(e.message, 'warn'); }
        } else startAsk(res.ask);
        return;
      }
      if (res?.openAsk) { openView('ask', res.openAsk); return; }
      if (res?.openPlaylist) { openView('playlist', res.openPlaylist); return; }
      if (res?.ok) toast.show(res.ok, 'ok');
      if (res?.warn) toast.show(res.warn, 'warn');
      if (res?.home && !landedEarly) land();
      else if (res?.close && !landedEarly) actions.closeCmdk();
      // A menu choice (theme, accent, light/dark), a like or a queue edit
      // keeps the list open and re-renders it so the ✓ / ♥ / order updates.
      else if (!landedEarly) {
        refresh({ keepCursor: true });
        if (res?.cursorDelta) list.move(res.cursorDelta);
      }
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

function copySong(t) {
  const artists = (t.ar || []).map((a) => a.name).join(', ');
  const text = `${t.name}${artists ? ` — ${artists}` : ''}\nhttps://music.163.com/song?id=${t.id}`;
  Promise.resolve(window.muse.copyText?.(text) ?? navigator.clipboard.writeText(text))
    .then(() => toast.show(`copied · ${t.name}`, 'ok'))
    .catch(() => toast.show('couldn’t copy', 'error'));
}

function doHide() {
  tx.animateHide(panelEl, () => window.muse.hideWindow?.());
}
