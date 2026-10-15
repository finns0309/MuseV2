// The composer: the input as a card. A text line (prompt mark · scope chip ·
// input) over a toolbar (commands · like ……… session picker · send), plus the
// mode chips under it at home. Everything here is mouse sugar over what the
// keyboard already does — nothing is keyboard-only, nothing is mouse-only.
//
// The scope chip is which `/` submenu the input is filtering ("Theme",
// "Queue"…). cmdk.refresh turns a typed `/theme ` into a chip; Backspace at
// the start of the input drops it (cmdk.onKey).

import { store, actions } from '../store.js';
import * as player from '../player.js';
import { resolveScope } from '../commands.js';
import { MODES } from '../modes/index.js';
import { setTimeSession } from '../modes/session.js';
import * as memory from '../lib/memory.js';
import * as sleep from '../lib/sleep.js';

let inputEl, scopeEl, sendEl, heartEl, sessionEl, chipsEl;
let scope = null;         // { id, title }
let handlers = { refresh() {}, runSelected() {}, toggleLike() {} };

export const PLACEHOLDER = 'What would you like to hear?';
const SCOPE_PLACEHOLDER = {
  playlist: 'Filter, or paste a NetEase link…',
  accent: 'Pick one, or type a hex…',
};

const ICON = {
  play:  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 3.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L6.1 3.1a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="3.4" width="2.6" height="9.2" rx=".9" fill="currentColor"/><rect x="9.2" y="3.4" width="2.6" height="9.2" rx=".9" fill="currentColor"/></svg>',
  send:  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.8V3.6M4 7.4l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export function mountComposer(root, h) {
  handlers = { ...handlers, ...h };
  inputEl   = root.querySelector('.cmdk-input');
  scopeEl   = root.querySelector('[data-role=scope]');
  sendEl    = root.querySelector('[data-role=send]');
  heartEl   = root.querySelector('[data-role=heart]');
  sessionEl = root.querySelector('[data-role=session]');
  chipsEl   = root.querySelector('[data-role=chips]');

  // Buttons must never take focus from the input — the next keystroke is
  // always a search.
  root.querySelectorAll('.cmdk-toolbar button, .cmdk-chips').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
  });
  root.querySelector('[data-role=slash]').addEventListener('click', () => setValue('/'));
  heartEl.addEventListener('click', () => handlers.toggleLike());
  sessionEl.addEventListener('click', () => setValue('/mode '));
  // ☾ 24m — the sleep timer, when one is set. Click to change or cancel it.
  const sleepEl = root.querySelector('[data-role=sleep]');
  sleepEl.addEventListener('click', () => setValue('/sleep '));
  const renderSleep = () => {
    const st = sleep.state();
    sleepEl.hidden = !st.active;
    sleepEl.textContent = st.endOfSong ? '☾ after this' : `☾ ${sleep.label(st)}`;
  };
  sleep.onChange(renderSleep);
  setInterval(() => { if (sleep.state().active) renderSleep(); }, 20_000);
  sendEl.addEventListener('click', () => {
    if (inputEl.value.trim()) handlers.runSelected();
    else player.toggle();
  });
  chipsEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-memory]')) { playOnThisDay(); return; }
    const chip = e.target.closest('[data-mode]');
    if (chip) actions.setMode(chip.dataset.mode);
  });
  memory.prime().then(() => renderChips(store.get()));
  // Late font loads nudge chip widths; put the glide back on its chip.
  document.fonts?.ready.then(() => reseatChips());

  // Why this queue exists — mode / manual / radio / playlist — always visible.
  store.selectKey(
    (s) => `${s.playbackSession?.kind ?? ''}|${s.playbackSession?.modeId ?? ''}|${s.playbackSession?.label ?? ''}`,
    (s) => { sessionEl.textContent = sessionText(s.playbackSession); }
  );
  // The send button doubles as play/pause while the input is empty.
  store.selectKey((s) => `${s.player.playing}|${!!s.player.track}`, renderSend);
  // The heart shows whether the current track is in the library.
  // A like (not a track change) pops the heart and throws off a few sparks.
  let heartFor = null;
  store.selectKey(
    (s) => `${s.player.track?.id ?? 0}|${s.library.tracks.length}`,
    (s) => {
      const id = s.player.track?.id;
      const on = !!id && s.library.tracks.some((t) => t.id === id);
      if (on && heartFor === id && !heartEl.classList.contains('on')) {
        heartEl.classList.remove('burst'); void heartEl.offsetWidth; heartEl.classList.add('burst');
      }
      heartFor = id;
      heartEl.classList.toggle('on', on);
      heartEl.disabled = !id;
    }
  );
  store.selectKey(
    (s) => `${s.playbackSession?.kind ?? ''}|${s.playbackSession?.modeId ?? ''}`,
    renderChips
  );
}

export const input = () => inputEl;
export const getScope = () => scope;

export function setScope(sc) {
  scope = sc || null;
  if (!scopeEl) return;
  scopeEl.hidden = !scope;
  scopeEl.textContent = scope ? scope.title : '';
  inputEl.placeholder = !scope ? PLACEHOLDER
    : SCOPE_PLACEHOLDER[scope.id] || `Filter ${scope.title.toLowerCase()}…`;
}

export function enterScope(id) {
  const sc = resolveScope(id);
  if (!sc) return;
  setScope(sc);
  inputEl.value = '';
  inputEl.focus();
  handlers.refresh({ motion: 'forward' });
}

export function setValue(v) {
  inputEl.value = v;
  inputEl.focus();
  handlers.refresh();
}

// Clear everything — the chip and the text — without re-rendering.
export function reset() {
  setScope(null);
  inputEl.value = '';
}

// The send button holds all three glyphs and morphs between them (CSS keys
// off data-kind): play ⇄ pause turn and cross-fade, ↑ rises in when you type.
export function renderSend() {
  if (!sendEl) return;
  if (!sendEl.firstChild) {
    sendEl.innerHTML = Object.entries(ICON).map(([k, svg]) => `<span class="ico ${k}">${svg}</span>`).join('');
  }
  const typing = !!inputEl.value.trim();
  const p = store.get().player;
  const kind = typing ? 'send' : (p.playing ? 'pause' : 'play');
  sendEl.disabled = !typing && !p.track;
  if (sendEl.dataset.kind === kind) return;
  sendEl.dataset.kind = kind;
  sendEl.setAttribute('aria-label', typing ? 'Run' : (p.playing ? 'Pause' : 'Play'));
}

let glideEl = null;
function renderChips(s) {
  const active = s.playbackSession?.kind === 'mode' ? s.playbackSession.modeId : null;
  if (!glideEl) { glideEl = document.createElement('span'); glideEl.className = 'cmdk-chips__glide'; }
  chipsEl.innerHTML = '';
  chipsEl.appendChild(glideEl);
  // "↺ 3 months ago today" leads the row when your history has that day.
  const day = memory.onThisDay();
  if (day) {
    const b = document.createElement('button');
    b.className = 'cmdk-chip memory' + (s.playbackSession?.kind === 'memory' ? ' on' : '');
    b.dataset.memory = '1';
    b.title = `${day.tracks.length} songs you played that day`;
    b.textContent = `↺ ${day.label}`;
    chipsEl.appendChild(b);
  }
  for (const m of MODES) {
    const b = document.createElement('button');
    b.className = 'cmdk-chip' + (m.id === active ? ' on' : '');
    b.dataset.mode = m.id;
    b.title = m.description || '';
    b.textContent = cap(m.label);
    chipsEl.appendChild(b);
  }
  placeGlide();   // reading offsets forces layout — no need to wait a frame
}

// The active chip's tint is one pill that glides to whichever chip is on —
// the same idea as the list cursor.
function placeGlide() {
  const on = chipsEl.querySelector('.cmdk-chip.on');
  if (!on || !on.offsetWidth) { glideEl.style.opacity = '0'; return; }
  const first = glideEl.style.opacity !== '1';
  if (first) glideEl.style.transition = 'none';
  glideEl.style.opacity = '1';
  glideEl.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  glideEl.style.width = `${on.offsetWidth}px`;
  glideEl.style.height = `${on.offsetHeight}px`;
  if (first) { void glideEl.offsetWidth; glideEl.style.transition = ''; }
}
export function reseatChips() { if (glideEl) placeGlide(); }

function playOnThisDay() {
  const day = memory.onThisDay();
  if (!day) return;
  player.setQueue(day.tracks, { startIdx: 0 });
  setTimeSession({ kind: 'memory', label: `↺ ${day.label}`, trackCount: day.tracks.length });
}

// The picker reads like a model name: "Daily", "Radio · 夜に駆ける".
function sessionText(session) {
  if (!session) return '';
  const mode = session.kind === 'mode' && MODES.find((m) => m.id === session.modeId);
  return mode ? cap(mode.label) : cap(session.label || '');
}
