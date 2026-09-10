// Playlist persistence + loading. Saved playlists are bookmarked locally so
// `/pl` can list them without a network call.

import { api, fetchSongDetails } from './api.js';
import * as player from './player.js';
import { setPlaylistSession } from './modes/session.js';

const STORE_KEY = 'saved-playlists';
let saved = [];

export function getAll() { return saved; }

export async function boot() {
  saved = (await window.muse.store.get(STORE_KEY, [])) || [];
}

function persist() {
  window.muse.store.set(STORE_KEY, saved).catch(() => {});
}

export function parseId(input) {
  if (!input) return null;
  const bare = input.trim();
  if (/^\d+$/.test(bare)) return Number(bare);
  const m = bare.match(/[?&]id=(\d+)/);
  return m ? Number(m[1]) : null;
}

export async function load(plId) {
  try {
    const detail = await api('/playlist/detail', { id: plId });
    const name = detail?.playlist?.name || `#${plId}`;
    const trackIds = (detail?.playlist?.trackIds || []).map((r) => r.id);
    if (!trackIds.length) return { warn: `playlist "${name}" is empty` };

    const songs = await fetchSongDetails(trackIds.slice(0, 200));
    const queue = songs.map((s) => ({
      id: s.id,
      name: s.name,
      ar: (s.ar || []).map((a) => ({ id: a.id, name: a.name })),
      al: { id: s.al?.id, name: s.al?.name, picUrl: s.al?.picUrl },
      dt: s.dt || 0,
    }));
    if (!queue.length) return { warn: `no playable tracks in "${name}"` };

    const existing = saved.find((p) => p.id === plId);
    if (existing) {
      existing.name = name;
      existing.trackCount = queue.length;
      existing.savedAt = Date.now();
    } else {
      saved.unshift({ id: plId, name, trackCount: queue.length, savedAt: Date.now() });
    }
    persist();

    setPlaylistSession({ id: plId, name, trackCount: queue.length });
    player.setQueue(queue, { startIdx: 0 });
    return { home: true, ok: `${name} · ${queue.length} tracks` };
  } catch (e) {
    return { warn: e?.message || 'failed to load playlist' };
  }
}
