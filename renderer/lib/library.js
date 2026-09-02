// Local library mirror. Source of truth is NetEase (the user's 我喜欢 playlist
// at first launch), with per-song local metadata — addedAt, lastPlayedAt,
// playCount — layered on top. Every play the user makes through muse mutates
// the library (including tracks played via cmdk search that aren't on NetEase's
// liked list yet): seed from (a) NetEase 我喜欢 + (b) anything played here.
//
// Persistence lives under the `library` key in muse.store (one JSON file).
// Writes are debounced so hot paths (play-count bumps during normal listening)
// don't hit disk per event.

import { api, fetchSongDetailsFull } from '../api.js';
import { store } from '../store.js';
import { onEnded } from '../player.js';

const STORE_KEY = 'library';
const MIN_COUNT_SECONDS = 30;             // play > 30s counts as a listen
const PERSIST_DEBOUNCE_MS = 600;

let persistTimer = null;
let countedThisTrack = false;             // once per track load

// ---- Public API ------------------------------------------------------------

// Load persisted library (if any) and hydrate `store.library.tracks`. If no
// persisted copy exists, fall through to initial NCM sync. Called once at boot
// after auth succeeds.
export async function bootLibrary() {
  const cached = await window.muse.store.get(STORE_KEY, null);
  if (cached?.tracks?.length) {
    store.set((s) => ({ ...s, library: {
      tracks: cached.tracks,
      likedPlaylistId: cached.likedPlaylistId || 0,
      ready: true, loading: false, error: null,
    } }));
    // Kick off a best-effort refresh in the background; don't block startup.
    // Also ensures we pick up likedPlaylistId if the cache predates that field.
    refreshFromNetease().catch((e) => console.warn('[library] background refresh failed', e.message));
    return;
  }
  // First launch: must hydrate before modes can play anything useful.
  store.set((s) => ({ ...s, library: { ...s.library, loading: true, error: null } }));
  try {
    const { tracks, likedPlaylistId } = await fetchLikedPlaylist();
    store.set((s) => ({ ...s, library: { tracks, likedPlaylistId, ready: true, loading: false, error: null } }));
    schedulePersist();
  } catch (e) {
    console.error('[library] initial sync failed', e);
    store.set((s) => ({ ...s, library: { tracks: [], likedPlaylistId: 0, ready: true, loading: false, error: e.message || String(e) } }));
  }
}

// Pull the user's 我喜欢 playlist and replace the tracks list. NetEase is the
// source of truth: songs un-hearted there get removed here too. Local play
// metadata (playCount / lastPlayedAt / addedAt) is preserved for songs that
// survive the refresh.
//
// Previously this function also kept "locally-added" tracks that weren't in
// 我喜欢 — e.g. songs played via cmdk search or discover mode. That turned
// the library into a mixed bag of "things I liked" + "things I happened to
// play", polluting the mental model. muse's job is to be a clean window onto
// 红心, not a listening log.
export async function refreshFromNetease() {
  const { tracks: fresh, likedPlaylistId } = await fetchLikedPlaylist();
  const localById = new Map(store.get().library.tracks.map((t) => [t.id, t]));
  const merged = fresh.map((t) => {
    const prev = localById.get(t.id);
    return prev ? { ...t, playCount: prev.playCount, lastPlayedAt: prev.lastPlayedAt, addedAt: prev.addedAt ?? t.addedAt } : t;
  });
  store.set((s) => ({ ...s, library: { tracks: merged, likedPlaylistId, ready: true, loading: false, error: null } }));
  schedulePersist();
}

// Optimistic heart toggle. Local state flips immediately (so cmdk label
// updates without waiting on the round-trip), and we roll back on error.
// Track shape for un-likes comes from the library itself; for likes (cloud
// search results) we normalize the sparse NCM payload to the library shape.
export async function toggleHeart(track) {
  if (!track || typeof track.id !== 'number') throw new TypeError('toggleHeart: track.id required');
  const prev = store.get().library.tracks;
  const isHearted = prev.some((t) => t.id === track.id);
  const next = isHearted
    ? prev.filter((t) => t.id !== track.id)
    : [{
        id: track.id,
        name: track.name,
        ar: (track.ar || []).map((a) => ({ id: a.id, name: a.name })),
        al: { id: track.al?.id, name: track.al?.name, picUrl: track.al?.picUrl },
        dt: track.dt || 0,
        addedAt: Date.now(),
        lastPlayedAt: 0,
        playCount: 0,
      }, ...prev];
  store.set((s) => ({ ...s, library: { ...s.library, tracks: next } }));
  schedulePersist();
  try {
    await api('/like', { id: track.id, like: isHearted ? 'false' : 'true' });
    return { isHearted: !isHearted };
  } catch (e) {
    store.set((s) => ({ ...s, library: { ...s.library, tracks: prev } }));
    schedulePersist();
    throw e;
  }
}

// No-op kept for backward import compatibility. Previously added non-liked
// tracks to the local library, which polluted 红心. Use actual NetEase "like"
// (POST /like) when we want to persist a song as liked.
export function ensureTrack(_track) { /* intentionally empty */ }

// ---- Play tracking ---------------------------------------------------------

// Watch the player. When a new track loads, reset the per-track "counted" flag.
// When the user crosses MIN_COUNT_SECONDS on that track, bump playCount and
// record lastPlayedAt. Kept separate from the main player loop so removing
// this file doesn't break playback.
export function wirePlayTracking() {
  let lastTrackId = null;
  store.select((s) => s.player.track?.id ?? null, (id) => {
    if (id !== lastTrackId) {
      lastTrackId = id;
      countedThisTrack = false;
    }
  });
  store.select((s) => s.player.currentTime, (t) => {
    if (countedThisTrack) return;
    if (t >= MIN_COUNT_SECONDS) {
      countedThisTrack = true;
      const track = store.get().player.track;
      if (track?.id != null) { bumpPlayCount(track.id); recordHistory(track); }
    }
  });
  // Also count a track that *finished*, in case it's shorter than MIN_COUNT_SECONDS.
  onEnded(() => {
    const track = store.get().player.track;
    if (!countedThisTrack && track?.id != null) { bumpPlayCount(track.id); recordHistory(track); }
    // Re-arm for the next round. On repeat-one the track id never changes, so
    // the id-change reset above won't fire — without this, a looped track would
    // only ever be counted once.
    countedThisTrack = false;
  });
}

function bumpPlayCount(id) {
  const now = Date.now();
  store.set((s) => ({
    ...s,
    library: {
      ...s.library,
      tracks: s.library.tracks.map((t) =>
        t.id === id ? { ...t, playCount: (t.playCount || 0) + 1, lastPlayedAt: now } : t
      ),
    },
  }));
  schedulePersist();
}

// Append-only event log of plays — separate from `library` because:
// (a) library is a slowly-changing mirror of 我喜欢; history grows monotonically
// (b) the Tape variants in echo need event-level granularity
//     (24h timeline, 7d bars, 30d/365d heatmaps) that aggregate counters can't
//     reconstruct
// (c) keeping it under its own store key means the library file stays small.
// The event shape is intentionally minimal — echo derives a cover
// hue from picUrl on its side rather than us baking it in.
function recordHistory(track) {
  const event = {
    at: Date.now(),
    songId: track.id,
    name: track.name || '',
    artist: (track.ar || []).map((a) => a.name).join(', '),
    album: track.al?.name || '',
    picUrl: track.al?.picUrl || '',
    durationMs: track.dt || 0,
  };
  window.muse.history.add(event).catch((e) => console.warn('[library] history-add failed', e.message));
}

// ---- Internals -------------------------------------------------------------

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { tracks, likedPlaylistId } = store.get().library;
    window.muse.store.set(STORE_KEY, { tracks, likedPlaylistId, savedAt: Date.now() })
      .catch((e) => console.warn('[library] persist failed', e.message));
  }, PERSIST_DEBOUNCE_MS);
}

// Fetch the logged-in user's 我喜欢 playlist. Returns `{ tracks, likedPlaylistId }`;
// the playlist id is cached in the store and used as the `sourceid` for scrobbles
// (NCM silently drops scrobbles with sourceid=0, so without this the listen
// history would never update).
// NCM flow: /user/playlist?uid -> first entry is 我喜欢 -> /playlist/detail
// for its trackIds -> /song/detail batched. `at` inside the playlist row is
// the time the track was added (ms).
async function fetchLikedPlaylist() {
  const uid = store.get().user?.uid;
  if (!uid) throw new Error('not signed in');

  const pls = await api('/user/playlist', { uid, limit: 1 });
  const liked = pls?.playlist?.[0];
  if (!liked?.id) throw new Error('could not find liked playlist');
  const likedPlaylistId = liked.id;

  // Full playlist detail gives us the trackIds[] + the `at` timestamps we
  // need for addedAt. `songs` in this response is a truncated preview, so
  // we always fall back to /song/detail for the full track info.
  const detail = await api('/playlist/detail', { id: likedPlaylistId });
  const trackIds = (detail?.playlist?.trackIds || []).map((r) => ({ id: r.id, at: r.at || 0 }));
  if (!trackIds.length) return { tracks: [], likedPlaylistId };

  const { songs, privileges } = await fetchSongDetailsFull(trackIds.map((r) => r.id));
  const addedByIdMap = new Map(trackIds.map((r) => [r.id, r.at]));
  // st < 0 → NetEase has pulled the track (暂无版权 etc.). Kept in the library
  // so 红心 stays a faithful mirror, but flagged so modes don't queue it —
  // otherwise the player burns ~2.5s per dead track discovering url=null.
  const unavailableIds = new Set(privileges.filter((p) => typeof p?.st === 'number' && p.st < 0).map((p) => p.id));

  const tracks = songs.map((s) => ({
    id: s.id,
    name: s.name,
    ar: (s.ar || []).map((a) => ({ id: a.id, name: a.name })),
    al: { id: s.al?.id, name: s.al?.name, picUrl: s.al?.picUrl },
    dt: s.dt || 0,
    addedAt: addedByIdMap.get(s.id) || Date.now(),
    lastPlayedAt: 0,
    playCount: 0,
    unavailable: unavailableIds.has(s.id),
  }));
  return { tracks, likedPlaylistId };
}
