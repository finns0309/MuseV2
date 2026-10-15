// Tiny pub/sub store. Single global instance; views subscribe to slices they
// care about. No frameworks — keeps the surface small and any state mutation
// traceable to one place (store.set).
//
// Helpers added on top:
//   - select(selector, fn):       fires only when selector output changes (===)
//   - selectKey(getKey, fn):      fires only when a STRING key changes — for
//                                 composite slices that would otherwise leak
//                                 a fresh object reference on every update
//   - race(name):                 returns isCurrent() — call after every await
//                                 in an async flow to discard stale results

class Store {
  constructor(initial) {
    this.state = initial;
    this.listeners = new Set();
    this.tokens = Object.create(null);  // race tokens by name
  }
  get() { return this.state; }
  set(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : { ...this.state, ...patch };
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    for (const fn of this.listeners) {
      try { fn(this.state, prev); }
      catch (e) { console.error('[store] subscriber threw', e); }
    }
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  select(selector, fn) {
    let last = selector(this.state);
    fn(last, undefined);
    return this.subscribe((s) => {
      const next = selector(s);
      if (next !== last) { const prev = last; last = next; fn(next, prev); }
    });
  }

  selectKey(getKey, fn) {
    let last = getKey(this.state);
    fn(this.state, undefined);
    return this.subscribe((s) => {
      const k = getKey(s);
      if (k !== last) { const prev = last; last = k; fn(s, prev); }
    });
  }

  race(name) {
    const my = (this.tokens[name] = (this.tokens[name] || 0) + 1);
    return () => this.tokens[name] === my;
  }
}

// Central state. Shape is intentionally flat — persistence slices are derived
// by selectKey at the bottom of the file, so adding a new top-level field
// doesn't require touching save logic unless that field needs to survive a
// relaunch.
export const store = new Store({
  // Auth / identity
  user: null,                      // { uid, nickname, avatarUrl } once logged in

  // Active mode id. Modes are registered in ./modes/index.js; adding
  // a mode does NOT require touching this default (it just becomes a valid
  // value). On first launch we fall back to 'all'.
  mode: 'all',
  modeRun: 0,                      // increments when re-running the active mode
  playbackSession: null,           // { kind, label, modeId?, seedTrackId?, playlistId? }

  // Local library mirror. Hydrated from NCM (the user's 我喜欢 playlist) and
  // extended every time a track is played. See lib/library.js.
  library: {
    tracks: [],                    // Track[] — id,name,ar,al,dt,addedAt,lastPlayedAt,playCount
    likedPlaylistId: 0,            // user's 我喜欢 playlist id; needed as scrobble sourceid
    ready: false,                  // true once initial hydration finished (even if 0 tracks)
    loading: false,
    error: null,
  },

  // Player state. The audio element in player.js is the source of truth;
  // it pushes updates here ~4Hz. UI reads from here.
  player: {
    track: null,                   // full song object
    queue: [],                     // ordered list
    queueIdx: -1,
    playing: false,
    currentTime: 0,
    duration: 0,
  },

  // Command palette open state.
  cmdkOpen: false,

  // Quiet command-surface appearance. Accent is null (auto: derived from the
  // album cover, see accent.js) or a plain hex pinned via `/accent #d8b35f`.
  appearance: {
    scheme: 'dark',                 // 'dark' | 'light'
    theme: 'muse',                  // see ./themes.js
    accent: null,
    bg: null,                       // resolved panel bg (#rrggbb) — mirrored to the native window
    menuBar: true,                  // the playing song's title beside the tray icon
  },
});

// ---- High-level actions ----------------------------------------------------

export const actions = {
  setMode(id) {
    if (typeof id !== 'string' || !id) throw new TypeError('setMode: id must be non-empty string');
    if (store.get().mode === id) {
      store.set((s) => ({ ...s, modeRun: s.modeRun + 1 }));
      return;
    }
    store.set({ mode: id });
  },

  openCmdk()  { if (!store.get().cmdkOpen) store.set({ cmdkOpen: true }); },
  closeCmdk() { if (store.get().cmdkOpen)  store.set({ cmdkOpen: false }); },

  setAppearanceScheme(scheme) {
    if (scheme !== 'dark' && scheme !== 'light') throw new TypeError('setAppearanceScheme: "dark"|"light"');
    if (store.get().appearance.scheme === scheme) return;
    store.set((s) => ({ ...s, appearance: { ...s.appearance, scheme } }));
  },

  setTheme(theme) {
    if (typeof theme !== 'string' || !theme) throw new TypeError('setTheme: id must be non-empty string');
    if (store.get().appearance.theme === theme) return;
    store.set((s) => ({ ...s, appearance: { ...s.appearance, theme } }));
  },

  setMenuBar(on) {
    const v = !!on;
    if (store.get().appearance.menuBar === v) return;
    store.set((s) => ({ ...s, appearance: { ...s.appearance, menuBar: v } }));
  },

  // null = auto (follow the album cover). A hex value pins the accent.
  setAccent(accent) {
    if (accent != null && !/^#[0-9a-f]{6}$/i.test(accent)) throw new TypeError('setAccent: expected #rrggbb or null');
    const normalized = accent == null ? null : accent.toLowerCase();
    if (store.get().appearance.accent === normalized) return;
    store.set((s) => ({ ...s, appearance: { ...s.appearance, accent: normalized } }));
  },
};

// Persist a small slice of UI state. Debounced + keyed on a string signature so
// player ticks don't trigger a save cycle. Only the fields that should survive
// a relaunch go in here — mode + appearance. Library persistence lives in lib/library.js.
let saveTimer;
store.selectKey(
  (s) => `${s.mode}|${s.appearance.scheme}|${s.appearance.theme}|${s.appearance.accent}|${s.appearance.bg}`,
  (s) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.muse.store.set('ui-prefs', { mode: s.mode, appearance: s.appearance })
        .catch((e) => console.warn('[store] persist ui-prefs failed', e));
    }, 300);
  }
);

if (typeof window !== 'undefined') window.__store = store;
