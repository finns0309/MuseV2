// The window's copy of what main keeps (lib/collections.js): asks — your
// conversations with the DJ — and Muse playlists. Reads are synchronous over
// the copy (menu builders are sync); writes update it at once and go on to
// main, which announces every change — ours or anyone's — and the copy
// reloads from there.

const KINDS = ['asks', 'playlists'];
const cache = { asks: [], playlists: [] };
const subs = new Set();
const reloadTimers = {};
let booted = null;

export function boot() {
  if (booted) return booted;
  window.muse.collections?.onChange?.(({ kind }) => {
    // A burst of writes (an ask landing writes its playlist and itself)
    // reloads once.
    clearTimeout(reloadTimers[kind]);
    reloadTimers[kind] = setTimeout(() => reload(kind), 60);
  });
  booted = Promise.all(KINDS.map(reload));
  return booted;
}

async function reload(kind) {
  try {
    const v = await window.muse.collections?.list(kind);
    if (Array.isArray(v)) cache[kind] = v;
  } catch (e) { console.warn('[collections] list', kind, e); }
  emit(kind);
}

export const list = (kind) => cache[kind];
export const get = (kind, id) => cache[kind].find((x) => x.id === id) || null;

export function put(kind, item) {
  cache[kind] = [item, ...cache[kind].filter((x) => x.id !== item.id)]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  emit(kind);
  return Promise.resolve(window.muse.collections?.put(kind, item))
    .catch((e) => console.warn('[collections] put', kind, e));
}

export function remove(kind, id) {
  cache[kind] = cache[kind].filter((x) => x.id !== id);
  emit(kind);
  return Promise.resolve(window.muse.collections?.remove(kind, id))
    .catch((e) => console.warn('[collections] remove', kind, e));
}

export function onChange(cb) { subs.add(cb); return () => subs.delete(cb); }
function emit(kind) { for (const cb of subs) { try { cb(kind); } catch (e) { console.warn(e); } } }

// 'ask_lx3k9f2a1b2c3d' — time-ordered, and unique enough on one machine.
export function newId(prefix) {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

// What a kept track carries: enough to show it and play it, nothing more.
export function compactTrack(t) {
  return {
    id: t.id,
    name: t.name || '',
    ar: (t.ar || []).map((a) => ({ id: a.id ?? null, name: a.name || '' })),
    al: { id: t.al?.id ?? null, name: t.al?.name || '', picUrl: t.al?.picUrl || '' },
    dt: t.dt || 0,
  };
}
