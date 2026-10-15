// Boot sequence:
//   1. Hydrate UI prefs (mode / appearance) from muse.store
//   2. Auth (QR flow if no cookie) — blocks until user is signed in
//   3. Mount cmdk (the sole UI surface)
//   4. Boot library mirror (may kick a NetEase sync)
//   5. Mode runner: auto-activate persisted mode once library is ready

import { store, actions } from './store.js';
import { bootAuth } from './auth.js';
import * as cmdk from './cmdk.js';
import * as player from './player.js';
import * as accent from './accent.js';
import { isTheme, DEFAULT_THEME, byId as themeById } from './themes.js';
import { MODES, byId } from './modes/index.js';
import { buildModeQueue, setModeSession } from './modes/session.js';
import { bootLibrary, wirePlayTracking } from './lib/library.js';

const els = {
  loginPane: document.getElementById('loginPane'),
  cmdk:      document.getElementById('cmdk'),
};

// ---- Boot -------------------------------------------------------------------

(async () => {
  // 1. Hydrate persisted prefs.
  const prefs = await window.muse.store.get('ui-prefs', null);
  if (prefs) {
    store.set({
      mode: prefs.mode || 'all',
      appearance: {
        scheme: prefs.appearance?.scheme === 'light' ? 'light' : 'dark',
        theme: isTheme(prefs.appearance?.theme) ? prefs.appearance.theme : DEFAULT_THEME,
        accent: /^#[0-9a-f]{6}$/i.test(prefs.appearance?.accent || '') ? prefs.appearance.accent.toLowerCase() : null,
        bg: null,
        menuBar: prefs.appearance?.menuBar !== false,
      },
    });
  }
  applyAppearance(store.get().appearance);
  store.selectKey((s) => `${s.appearance.scheme}|${s.appearance.theme}|${s.appearance.accent}`, (s) => {
    applyAppearance(s.appearance);
  });

  // 2. Auth gate.
  await bootAuth(els.loginPane);

  // 3. Mount cmdk — the only UI.
  cmdk.mount(els.cmdk);
  actions.openCmdk();
  window.muse.onOpenCommandSurface(() => actions.openCmdk());

  // 4. Library.
  wirePlayTracking();
  bootLibrary().catch((e) => console.error('[app] bootLibrary', e));

  // 5. Mode runner. Watches store.mode and
  //    builds the queue via the mode's build() function.
  bootModeRunner();

  // 6. Global shortcuts.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'ArrowRight') { e.preventDefault(); player.next(); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); player.prev(); return; }
      if (e.key.toLowerCase() === 'p') { e.preventDefault(); player.toggle(); return; }
    }
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    if (e.key === ' ') { e.preventDefault(); player.toggle(); }
    if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); player.next(); }
  });
})();

// ---- Mode runner -------------------------------------------------------------

function bootModeRunner() {
  let started = false;

  // Activate the persisted mode once the library is ready.
  store.select((s) => s.library.ready, (ready) => {
    if (ready && !started) {
      started = true;
      activateMode(store.get().mode);
    }
  });

  // Re-activate whenever the mode changes, or when cmdk re-runs the active mode.
  store.selectKey((s) => `${s.mode}|${s.modeRun}`, (s, prevKey) => {
    if (prevKey !== undefined && s.library.ready) {
      activateMode(s.mode);
    }
  });

  // Immersive auto-rebuild: if the user manually plays another song while in
  // immersive mode, rebuild the queue around the new artist.
  store.selectKey(
    (s) => `${s.playbackSession?.kind ?? ''}|${s.playbackSession?.modeId ?? ''}|${s.player.track?.id ?? ''}|${s.player.track?.ar?.[0]?.id ?? ''}`,
    (s, prevKey) => {
      if (prevKey === undefined) return;
      if (s.playbackSession?.kind !== 'mode' || s.playbackSession?.modeId !== 'immersive' || !s.library.ready) return;
      const artistId = s.player.track?.ar?.[0]?.id;
      if (!artistId) return;
      const queue = s.player.queue;
      const allSameArtist = Array.isArray(queue) && queue.length > 1 &&
        queue.every((t) => t?.ar?.[0]?.id === artistId);
      if (!allSameArtist) activateMode('immersive');
    }
  );
}

async function activateMode(modeId) {
  const mode = byId[modeId] || byId.all;
  const ok = store.race('mode-activate');

  let result;
  try { result = await buildModeQueue(mode.id); }
  catch (e) { console.error('[mode] build failed', modeId, e); return; }
  if (!ok()) return;

  const queue = result?.queue || [];
  if (!queue.length) {
    console.info('[mode] empty queue:', modeId, result?.error || '');
    return;
  }
  setModeSession(mode.id);
  player.setQueue(queue, { startIdx: result.startIdx || 0 });
  player.setLoop(!!mode.singleLoop);
}

// ---- Appearance -------------------------------------------------------------

function applyAppearance(appearance) {
  const scheme = appearance?.scheme === 'light' ? 'light' : 'dark';
  const theme = isTheme(appearance?.theme) ? appearance.theme : DEFAULT_THEME;
  document.body.dataset.scheme = scheme;
  document.body.dataset.theme = theme;
  // accent.js owns --muse-accent: user override > clamped cover colour > token
  // (the cover step only for themes that follow it, see themes.js).
  accent.setScheme(scheme);
  accent.setFollowCover(themeById[theme].followCover);
  accent.setOverride(appearance?.accent || null);
  // Keep the native window backgroundColor in sync so the panel's fade/resize
  // never reveals a mismatched color behind it (the grey flash on summon).
  // The resolved --bg is also persisted so main.js can paint the right colour
  // on the *next* launch, before this renderer has booted.
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if (/^#[0-9a-f]{6}$/i.test(bg)) {
    window.muse.setWindowBg?.(bg);
    if (store.get().appearance.bg !== bg) store.set((s) => ({ ...s, appearance: { ...s.appearance, bg } }));
  }
}
