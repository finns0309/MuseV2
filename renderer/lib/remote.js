// What agents can do, done here in the window — where the player, the
// library and the DJ live. main.js carries each call in from the control API
// (lib/control.js) and the answer back; agent/specs.js is the contract.
//
// Everything an agent changes is signed: playlists it makes or edits carry
// its name ("claude-code"), and what it did lands in recentActivity() for
// /agents. Results speak the agents' track shape:
//   { id, name, artists, album, duration_s, cover }

import { store } from '../store.js';
import * as player from '../player.js';
import * as col from './collections.js';
import * as dj from './dj.js';
import * as memory from './memory.js';
import { api, fetchSongDetails } from '../api.js';
import { toggleHeart } from './library.js';
import { fetchSimilar } from './similar.js';
import * as neteasePlaylists from '../playlist.js';
import { setAskSession, setMusePlaylistSession, setManualSession } from '../modes/session.js';

// ---- Activity ------------------------------------------------------------------

const activity = [];            // newest first: { agent, tool, summary, at }
const activitySubs = new Set();
export const recentActivity = () => activity;
export function onActivity(cb) { activitySubs.add(cb); return () => activitySubs.delete(cb); }
function did(meta, tool, summary) {
  activity.unshift({ agent: meta.agent || 'an agent', tool, summary, at: Date.now() });
  activity.length = Math.min(activity.length, 30);
  for (const cb of activitySubs) { try { cb(); } catch {} }
}

// Where the CLI and MCP server live and where the API listens (for /agents).
let info = null;
export function controlInfo() {
  if (!info?.port) window.muse.controlInfo?.().then((i) => { const was = info?.port; info = i; if (i?.port && !was) activitySubs.forEach((cb) => cb()); }).catch(() => {});
  return info;
}

export function mount() {
  controlInfo();
  window.muse.onRemoteCall?.(async ({ id, name, args, meta }) => {
    try {
      const fn = HANDLERS[name];
      if (!fn) throw new Error(`no tool named ${name}`);
      const result = await fn(args || {}, meta || {});
      window.muse.remoteReply({ id, ok: true, result: result ?? null });
    } catch (e) {
      window.muse.remoteReply({ id, ok: false, error: e?.message || String(e) });
    }
  });
}

// ---- Shapes --------------------------------------------------------------------

const artistsOf = (t) => (t.ar || t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
const out = (t) => ({
  id: t.id,
  name: t.name || '',
  artists: artistsOf(t),
  album: t.al?.name || '',
  duration_s: Math.round((t.dt || 0) / 1000),
  cover: t.al?.picUrl || '',
});
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const clampInt = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : dflt);
const isLiked = (id) => store.get().library.tracks.some((t) => t.id === id);

function madeBy(pl) {
  if (pl.source?.kind === 'ask') return 'Muse DJ';
  if (pl.source?.kind === 'agent') return pl.source.agent || 'an agent';
  return 'you';
}

function sessionInfo(s) {
  if (!s) return null;
  return { kind: s.kind, label: s.label || '', ask_id: s.askId || null, playlist_id: s.playlistId ?? null };
}

// Song ids → playable tracks, in the order asked. Whatever Muse already
// holds (library, queue, Muse playlists) is used as is; the rest comes from
// NetEase. Unknown ids are reported, not invented.
async function resolveTracks(ids) {
  const want = [...new Set((ids || []).filter((x) => Number.isInteger(x)))];
  const known = new Map();
  const note = (t) => { if (t?.id && !known.has(t.id)) known.set(t.id, t); };
  store.get().library.tracks.forEach(note);
  store.get().player.queue.forEach(note);
  for (const p of col.list('playlists')) p.tracks.forEach(note);
  const missing = want.filter((id) => !known.has(id));
  if (missing.length) {
    const songs = await fetchSongDetails(missing);
    for (const s of songs) note({ id: s.id, name: s.name, ar: s.ar, al: s.al, dt: s.dt });
  }
  const tracks = want.filter((id) => known.has(id)).map((id) => col.compactTrack(known.get(id)));
  return { tracks, missing: want.filter((id) => !known.has(id)) };
}

function musePlaylist(id) {
  const pl = typeof id === 'string' ? col.get('playlists', id) : null;
  if (!pl) throw new Error(`no Muse playlist ${JSON.stringify(id)} — list_playlists shows the ids`);
  return pl;
}

const neteaseId = (id) => (Number.isInteger(id) ? id : /^\d{5,}$/.test(String(id)) ? Number(id) : null);

async function neteasePlaylistTracks(id) {
  const d = await api('/playlist/detail', { id });
  const ids = (d?.playlist?.trackIds || []).map((r) => r.id).slice(0, 500);
  const songs = ids.length ? await fetchSongDetails(ids) : [];
  return { name: d?.playlist?.name || `#${id}`, tracks: songs.map((s) => col.compactTrack({ id: s.id, name: s.name, ar: s.ar, al: s.al, dt: s.dt })) };
}

// Start a Muse playlist playing, under a session that names it.
export function playMusePlaylist(pl, startIdx = 0) {
  player.setQueue(pl.tracks, { startIdx });
  const ask = pl.source?.kind === 'ask' ? col.get('asks', pl.source.askId) : null;
  if (ask) setAskSession({ prompt: pl.source.prompt, title: pl.name, trackCount: pl.tracks.length, askId: ask.id });
  else setMusePlaylistSession(pl);
}

// ---- Tools ---------------------------------------------------------------------

const HANDLERS = {
  now_playing() {
    const s = store.get();
    const p = s.player;
    return {
      track: p.track ? { ...out(p.track), liked: isLiked(p.track.id) } : null,
      playing: !!p.playing,
      position_s: Math.round(p.currentTime || 0),
      duration_s: Math.round(p.duration || 0),
      queue_position: p.queueIdx,
      queue_length: p.queue.length,
      session: sessionInfo(s.playbackSession),
    };
  },

  get_queue({ limit }) {
    const { queue, queueIdx } = store.get().player;
    const n = clampInt(limit, 1, 500, 30);
    const at = (k) => ({ position: k, ...out(queue[k]) });
    const upcoming = [];
    for (let k = queueIdx + 1; k < queue.length && upcoming.length < n; k++) upcoming.push(at(k));
    const played = [];
    for (let k = queueIdx - 1; k >= 0 && played.length < 5; k--) played.push(at(k));
    return {
      current: queue[queueIdx] ? at(queueIdx) : null,
      up_next: upcoming,
      more_after: Math.max(0, queue.length - (queueIdx + 1) - upcoming.length),
      recently_played: played,
      session: sessionInfo(store.get().playbackSession),
    };
  },

  async listening_history({ days, mode, limit }) {
    const hist = await memory.loadHistory();
    const since = Date.now() - clampInt(days, 1, 3650, 7) * 86400000;
    const n = clampInt(limit, 1, 500, 50);
    const rows = hist.filter((h) => h?.songId && h.at >= since);
    const shape = (h) => ({
      id: h.songId, name: h.name || '', artists: h.artist || '', album: h.album || '',
      duration_s: Math.round((h.durationMs || 0) / 1000), cover: h.picUrl || '',
    });
    if (mode === 'top') {
      const counts = new Map();
      for (const h of rows) {
        const c = counts.get(h.songId) || { plays: 0, last: 0, h };
        c.plays++; c.last = Math.max(c.last, h.at); c.h = h;
        counts.set(h.songId, c);
      }
      return {
        days: Math.round((Date.now() - since) / 86400000),
        songs: [...counts.values()].sort((a, b) => b.plays - a.plays || b.last - a.last).slice(0, n)
          .map((c) => ({ ...shape(c.h), plays: c.plays, last_played: iso(c.last) })),
      };
    }
    return { plays: rows.slice(-n).reverse().map((h) => ({ ...shape(h), played_at: iso(h.at) })) };
  },

  async search_catalog({ query, limit }) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is empty');
    const r = await api('/cloudsearch', { keywords: q, type: 1, limit: clampInt(limit, 1, 30, 10) });
    return { songs: (r?.result?.songs || []).map((s) => ({ ...out({ id: s.id, name: s.name, ar: s.ar, al: s.al, dt: s.dt }), liked: isLiked(s.id) })) };
  },

  search_library({ query, limit }) {
    const n = clampInt(limit, 1, 200, 20);
    const lib = store.get().library.tracks;
    const q = String(query || '').trim().toLowerCase();
    const hits = q
      ? lib.filter((t) => (t.name || '').toLowerCase().includes(q) || artistsOf(t).toLowerCase().includes(q) || (t.al?.name || '').toLowerCase().includes(q))
      : lib.slice().sort((a, b) => (b.lastPlayedAt || b.addedAt || 0) - (a.lastPlayedAt || a.addedAt || 0));
    return { total: hits.length, songs: hits.slice(0, n).map((t) => ({ ...out(t), plays: t.playCount || 0, liked_at: iso(t.addedAt) })) };
  },

  async similar_songs({ track_id, limit }) {
    const songs = await fetchSimilar(track_id, { limit: clampInt(limit, 1, 50, 15) });
    return { songs: songs.map((t) => ({ ...out(t), liked: isLiked(t.id) })) };
  },

  list_playlists() {
    return {
      muse: col.list('playlists').map((p) => ({
        id: p.id, name: p.name, description: p.description || '', tracks: p.tracks.length,
        made_by: madeBy(p), edited_by: p.editedBy || null,
        ask_id: p.source?.kind === 'ask' ? p.source.askId : null, updated: iso(p.updatedAt),
      })),
      netease: neteasePlaylists.getAll().map((p) => ({ id: p.id, name: p.name, tracks: p.trackCount, read_only: true })),
    };
  },

  async get_playlist({ id }) {
    const nid = neteaseId(id);
    if (nid) {
      const { name, tracks } = await neteasePlaylistTracks(nid);
      return { id: nid, name, read_only: true, tracks: tracks.map(out) };
    }
    const pl = musePlaylist(id);
    return {
      id: pl.id, name: pl.name, description: pl.description || '', made_by: madeBy(pl), edited_by: pl.editedBy || null,
      ask_id: pl.source?.kind === 'ask' ? pl.source.askId : null,
      tracks: pl.tracks.map(out),
    };
  },

  async create_playlist({ name, track_ids, description }, meta) {
    const title = String(name || '').trim();
    if (!title) throw new Error('name is empty');
    const { tracks, missing } = await resolveTracks(track_ids || []);
    const now = Date.now();
    const pl = {
      id: col.newId('mpl'), name: title, description: String(description || '').trim(),
      tracks, createdAt: now, updatedAt: now,
      source: { kind: 'agent', agent: meta.agent || 'an agent' },
    };
    col.put('playlists', pl);
    did(meta, 'create_playlist', `made “${title}” · ${tracks.length} songs`);
    return { id: pl.id, name: pl.name, tracks: tracks.length, missing };
  },

  async update_playlist({ id, name, description, add, insert_at, remove, track_ids }, meta) {
    const pl = structuredClone(musePlaylist(id));
    const changes = [];
    let missing = [];
    if (typeof name === 'string' && name.trim()) { pl.name = name.trim(); changes.push('renamed'); }
    if (typeof description === 'string') { pl.description = description.trim(); changes.push('described'); }
    if (Array.isArray(track_ids)) {
      const r = await resolveTracks(track_ids);
      pl.tracks = r.tracks; missing = missing.concat(r.missing);
      changes.push(`set ${r.tracks.length} songs`);
    }
    if (Array.isArray(remove) && remove.length) {
      const drop = new Set(remove);
      const before = pl.tracks.length;
      pl.tracks = pl.tracks.filter((t) => !drop.has(t.id));
      changes.push(`−${before - pl.tracks.length}`);
    }
    if (Array.isArray(add) && add.length) {
      const r = await resolveTracks(add);
      const have = new Set(pl.tracks.map((t) => t.id));
      const fresh = r.tracks.filter((t) => !have.has(t.id));
      const at = clampInt(insert_at, 0, pl.tracks.length, pl.tracks.length);
      pl.tracks.splice(at, 0, ...fresh);
      missing = missing.concat(r.missing);
      changes.push(`+${fresh.length}`);
    }
    if (!changes.length) return { id: pl.id, name: pl.name, tracks: pl.tracks.length, changed: false };
    pl.updatedAt = Date.now();
    pl.editedBy = meta.agent || 'an agent';
    col.put('playlists', pl);
    did(meta, 'update_playlist', `edited “${pl.name}” · ${changes.join(' ')}`);
    return { id: pl.id, name: pl.name, tracks: pl.tracks.length, changed: true, missing };
  },

  delete_playlist({ id }, meta) {
    const pl = musePlaylist(id);
    col.remove('playlists', pl.id);
    const ask = pl.source?.kind === 'ask' ? col.get('asks', pl.source.askId) : null;
    if (ask?.playlistId === pl.id) col.put('asks', { ...ask, playlistId: null });
    did(meta, 'delete_playlist', `deleted “${pl.name}”`);
    return { deleted: pl.id };
  },

  async play({ playlist_id, track_ids, start_index }, meta) {
    const start = clampInt(start_index, 0, 100000, 0);
    if (playlist_id !== undefined && playlist_id !== null) {
      const nid = neteaseId(playlist_id);
      if (nid) {
        const r = await neteasePlaylists.load(nid);
        if (r?.warn) throw new Error(r.warn);
      } else {
        const pl = musePlaylist(playlist_id);
        if (!pl.tracks.length) throw new Error(`“${pl.name}” is empty`);
        playMusePlaylist(pl, Math.min(start, pl.tracks.length - 1));
      }
    } else if (Array.isArray(track_ids) && track_ids.length) {
      const { tracks } = await resolveTracks(track_ids);
      if (!tracks.length) throw new Error('none of those songs were found');
      const k = Math.min(start, tracks.length - 1);
      player.setQueue(tracks, { startIdx: k });
      setManualSession(tracks[k]);
    } else {
      player.play();
    }
    did(meta, 'play', 'changed what’s playing');
    await new Promise((r) => setTimeout(r, 300));
    return HANDLERS.now_playing();
  },

  async queue_tracks({ track_ids, position }, meta) {
    const { tracks, missing } = await resolveTracks(track_ids);
    if (!tracks.length) throw new Error('none of those songs were found');
    if (!store.get().player.track) {
      player.setQueue(tracks, { startIdx: 0 });
      setManualSession(tracks[0]);
    } else if (position === 'next') {
      for (const t of [...tracks].reverse()) player.playNext(t);
    } else {
      for (const t of tracks) player.enqueue(t);
    }
    did(meta, 'queue_tracks', `queued ${tracks.length} songs`);
    return { queued: tracks.length, missing, position: position === 'next' ? 'next' : 'end' };
  },

  async playback({ action }, meta) {
    const fns = { pause: player.pause, resume: player.play, toggle: player.toggle, next: player.next, previous: player.prev };
    if (!fns[action]) throw new Error(`unknown action ${action}`);
    fns[action]();
    did(meta, 'playback', action);
    await new Promise((r) => setTimeout(r, 350));
    return HANDLERS.now_playing();
  },

  async like({ track_id, liked = true }, meta) {
    const { tracks } = await resolveTracks([track_id]);
    if (!tracks.length) throw new Error(`no song ${track_id}`);
    if (isLiked(track_id) !== !!liked) await toggleHeart(tracks[0]);
    did(meta, 'like', `${liked ? 'liked' : 'unliked'} “${tracks[0].name}”`);
    return { id: track_id, liked: isLiked(track_id) };
  },

  async ask_dj({ request, follow_up, wait = true, play = false }, meta) {
    const q = String(request || '').trim();
    if (!q) throw new Error('request is empty');
    if (follow_up && !col.get('asks', follow_up)) throw new Error(`no ask ${follow_up}`);
    const id = dj.send(q, { followUpOf: follow_up || null, via: meta.agent || 'an agent', land: play ? 'play' : 'keep' });
    did(meta, 'ask_dj', `asked the DJ “${q}”`);
    if (!wait) return { ask_id: id, status: 'thinking' };
    const ask = await dj.whenLanded(id);
    return askOut(ask, { full: false });
  },

  list_asks({ limit }) {
    return {
      asks: col.list('asks').slice(0, clampInt(limit, 1, 300, 20)).map((a) => {
        const last = dj.lastTurn(a);
        const pl = a.playlistId ? col.get('playlists', a.playlistId) : null;
        return {
          id: a.id, title: a.title || '', requests: a.turns.map((t) => t.q),
          status: last?.status || 'done', playlist_id: pl?.id || null, tracks: pl?.tracks.length || 0,
          updated: iso(a.updatedAt),
        };
      }),
    };
  },

  get_ask({ id }) {
    const ask = col.get('asks', id);
    if (!ask) throw new Error(`no ask ${id}`);
    return askOut(ask, { full: true });
  },
};

function askOut(ask, { full }) {
  const last = dj.lastTurn(ask);
  const pl = ask.playlistId ? col.get('playlists', ask.playlistId) : null;
  const base = {
    ask_id: ask.id, status: last?.status, title: ask.title || last?.title || '',
    reply: last?.reply || last?.error || '',
    suggestions: last?.suggestions || [],
    playlist_id: pl?.id || null,
    tracks: (pl?.tracks || dj.lastAnswer(ask)?.tracks || []).map(out),
  };
  if (!full) return base;
  return {
    ...base,
    turns: ask.turns.map((t) => ({ request: t.q, at: iso(t.at), status: t.status, title: t.title || '', reply: t.reply || t.error || '', songs: t.tracks?.length || 0 })),
  };
}
