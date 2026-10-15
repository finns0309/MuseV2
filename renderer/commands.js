// Command builders. Each is a pure function (query) => Entry[] that produces
// the list items for a given input. Sync builders run on every keystroke;
// async builders race against the latest input via store.race('cmdk').

import { store, actions } from './store.js';
import { MODES } from './modes/index.js';
import {
  buildQueueForPickedTrack,
  describeSession,
  setManualSession,
  setRadioSession,
} from './modes/session.js';
import * as player from './player.js';
import { fetchSimilar } from './lib/similar.js';
import { toggleHeart } from './lib/library.js';
import { api } from './api.js';
import * as playlist from './playlist.js';
import { GLYPH, prefix } from './glyphs.js';
import { THEMES, byId as themeById } from './themes.js';

// ---- Shared entry factories -------------------------------------------------

export function formatArtists(track) {
  return (track.ar || track.artists || []).map((a) => a.name).join(', ');
}

function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function sharedActions(track) {
  const isHearted = store.get().library.tracks.some((t) => t.id === track.id);
  return {
    altRun: async () => {
      const ok = store.race('song-run');
      player.stageTrack(track);
      let similars;
      try { similars = await fetchSimilar(track.id, { limit: 30 }); }
      catch (e) { player.unstage(); throw e; }
      if (!ok()) return {};
      setRadioSession(track);
      Promise.resolve(player.setQueue([track, ...similars], { startIdx: 0 })).catch((e) => console.warn('[cmdk] setQueue', e));
      return similars.length
        ? { home: true, ok: `radio · 1 + ${similars.length} tracks` }
        : { home: true, warn: 'no similar tracks found, playing this one only' };
    },
    altLabel: 'start radio',
    heartRun: () => toggleHeart(track).then((r) => ({
      ok: r.isHearted ? `liked · ${track.name}` : `unliked · ${track.name}`,
    })),
    heartLabel: isHearted ? 'unlike' : 'like',
  };
}

// Structured song row: glyph + name + artist (sub) + duration. `group` tags it
// for the section header (e.g. "library" / "from netease"); `dim` softens the
// glyph for cloud hits.
export function songEntry(track, { glyph = GLYPH.LIKED, dim = false, group } = {}) {
  const isHearted = store.get().library.tracks.some((t) => t.id === track.id);
  return {
    kind: isHearted ? 'library-song' : 'song',
    home: true,          // Enter lands on the keypress; playback catches up (see cmdk.execute)
    glyph, dim, group,
    name: track.name || '',
    sub: formatArtists(track) || track.al?.name || '',
    dur: fmtDur(track.dt),
    run: async () => {
      const ok = store.race('song-run');
      // Show the pick in the hero right now; the queue build below may take
      // seconds (mode rebuilds hit the network). Rolled back on failure.
      player.stageTrack(track);
      let result;
      try { result = await buildQueueForPickedTrack(track, { preserveMode: isHearted }); }
      catch (e) { player.unstage(); throw e; }
      if (!ok()) return {};
      if (!result.mode) setManualSession(track);
      // Not awaited: setQueue puts the track in the store synchronously and
      // then fetches the stream URL. The landing must start on the keypress,
      // not when the audio is ready — playback errors are handled in player.js
      // (skip-forward fallback), so nothing here needs the promise.
      Promise.resolve(player.setQueue(result.queue, { startIdx: 0 })).catch((e) => console.warn('[cmdk] setQueue', e));
      player.setLoop(!!result.mode?.singleLoop);
      // `home`: the palette returns to idle and the hero landing with the new
      // cover is the confirmation (see cmdk.land). No toast for the track.
      return { home: true };
    },
    ...sharedActions(track),
  };
}

function queueEntry(track, idx, isCurrent) {
  return {
    kind: isCurrent ? 'queue-current' : 'queue-item',
    home: true,
    glyph: isCurrent ? GLYPH.PLAYING : GLYPH.QUEUED,
    name: track.name || '',
    sub: formatArtists(track) || track.al?.name || '',
    dur: fmtDur(track.dt),
    run: () => {
      if (isCurrent) return { home: true };
      player.playAt(idx);
      return { home: true };
    },
    ...sharedActions(track),
  };
}

// ---- List builders ----------------------------------------------------------

function buildQueueEntries(filter, queue, queueIdx) {
  if (!queue.length) {
    return [{ kind: 'queue-empty', label: 'queue · empty', hint: 'search for a song first', run: () => ({}) }];
  }
  const f = (filter || '').trim().toLowerCase();
  const out = [];
  queue.forEach((track, i) => {
    if (f) {
      const name = (track.name || '').toLowerCase();
      const artists = (track.ar || []).map((a) => a.name).join(' ').toLowerCase();
      if (!name.includes(f) && !artists.includes(f)) return;
    }
    out.push(queueEntry(track, i, i === queueIdx));
  });
  return out;
}

function buildLibraryEntries(filter, tracks) {
  if (!tracks.length) {
    return [{ kind: 'library-empty', label: 'library · empty', hint: 'like songs on NetEase first', run: () => ({}) }];
  }
  const f = (filter || '').trim().toLowerCase();
  const sorted = tracks.slice().sort((a, b) =>
    (b.lastPlayedAt || b.addedAt || 0) - (a.lastPlayedAt || a.addedAt || 0)
  );
  const filtered = f
    ? sorted.filter((t) => {
        const name = (t.name || '').toLowerCase();
        const artists = (t.ar || []).map((a) => a.name).join(' ').toLowerCase();
        return name.includes(f) || artists.includes(f);
      })
    : sorted;
  if (f && !filtered.length) {
    return [{ kind: 'library-empty', label: 'no matches', hint: '', run: () => ({}) }];
  }
  return filtered.map((t) => songEntry(t, { glyph: GLYPH.LIKED }));
}

// ---- Helpers ----------------------------------------------------------------

function normalizeCommand(s) {
  return String(s || '').toLowerCase().replace(/[\s._-]+/g, '');
}

function commandMatches(q, parts) {
  if (!q) return true;
  const query = normalizeCommand(q);
  return parts.some((p) => normalizeCommand(p).includes(query));
}

function parseAccentCommand(q) {
  const m = String(q || '').trim().match(/^accent\s+(#[0-9a-f]{6}|auto)$/i);
  return m ? m[1].toLowerCase() : null;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

function scoreLibrary(q, tracks) {
  const query = normalize(q);
  if (!query) return [];
  return tracks
    .map((track) => {
      const name = normalize(track.name);
      const artists = normalize(formatArtists(track));
      const album = normalize(track.al?.name || '');
      let score = 0;
      if (name === query) score += 100;
      else if (name.startsWith(query)) score += 80;
      else if (name.includes(query)) score += 55;
      if (artists.includes(query)) score += 35;
      if (album.includes(query)) score += 20;
      if (!score) return null;
      score += Math.min(12, Math.log2(1 + (track.playCount || 0)) * 3);
      if (track.lastPlayedAt) score += Math.max(0, 8 - (Date.now() - track.lastPlayedAt) / 86400000);
      return { track, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// ---- Exported builder arrays ------------------------------------------------

// `setInput` is injected by cmdk.js so builders can programmatically fill the
// search box (e.g. expanding a hint into a full view). Avoids a circular import.
let setInput = () => {};
export function injectSetInput(fn) { setInput = fn; }

export const COMMAND_BUILDERS = [
  // Queue
  (q) => {
    const tokens = (q || '').trim().split(/\s+/).filter(Boolean);
    const head = normalizeCommand(tokens[0] || '');
    const { queue, queueIdx } = store.get().player;
    if (head && 'queue'.startsWith(head)) {
      return buildQueueEntries(tokens.slice(1).join(' '), queue, queueIdx);
    }
    if (!queue.length) return [];
    if (head) return [];
    const remaining = Math.max(0, queue.length - (queueIdx + 1));
    return [{
      kind: 'queue-hint',
      label: describeSession() + ' · queue',
      hint: remaining ? `${remaining} up next` : 'last track',
      run: () => { setInput('/queue'); return {}; },
    }];
  },
  // Library
  (q) => {
    const tokens = (q || '').trim().split(/\s+/).filter(Boolean);
    const head = normalizeCommand(tokens[0] || '');
    const tracks = store.get().library.tracks;
    if (head && 'library'.startsWith(head) && !'queue'.startsWith(head)) {
      return buildLibraryEntries(tokens.slice(1).join(' '), tracks);
    }
    if (!tracks.length || head) return [];
    return [{
      kind: 'library-hint',
      label: `library · ${tracks.length} songs`,
      hint: 'browse liked',
      run: () => { setInput('/library'); return {}; },
    }];
  },
  // Playlist
  (q) => {
    const tokens = (q || '').trim().split(/\s+/).filter(Boolean);
    const head = normalizeCommand(tokens[0] || '');
    const saved = playlist.getAll();
    if (!head || (!'playlist'.startsWith(head) && head !== 'pl')) {
      if (!head && saved.length) {
        return [{
          kind: 'playlist-hint',
          label: `playlist · ${saved.length} saved`,
          hint: 'browse playlists',
          run: () => { setInput('/pl'); return {}; },
        }];
      }
      return [];
    }
    const rawArg = tokens.slice(1).join(' ').trim();
    const plId = playlist.parseId(rawArg);
    if (plId) {
      const existing = saved.find((p) => p.id === plId);
      return [{
        kind: 'playlist-load',
        label: existing ? `playlist · ${existing.name}` : `playlist · load #${plId}`,
        hint: existing ? `${existing.trackCount} tracks · Enter to play` : 'Enter to load & play',
        run: () => playlist.load(plId),
      }];
    }
    const filter = rawArg.toLowerCase();
    const filtered = filter ? saved.filter((p) => p.name.toLowerCase().includes(filter)) : saved;
    const entries = filtered.map((p) => ({
      kind: 'playlist-saved',
      label: prefix(GLYPH.PLAYLIST) + p.name,
      hint: `${p.trackCount} tracks`,
      run: () => playlist.load(p.id),
    }));
    entries.push({
      kind: 'playlist-add',
      label: 'playlist · add new',
      hint: 'paste ID or URL after /pl',
      run: () => ({ warn: 'usage: /pl <id or URL>' }),
    });
    return entries;
  },
  // Modes
  (q) => MODES
    .filter((m) => commandMatches(q, ['mode', 'radio', m.id, m.label, m.description || '']))
    .map((m) => ({
      kind: 'mode',
      home: true,
      label: prefix(GLYPH.MODE) + m.label,
      hint: m.description || '',
      run: () => { actions.setMode(m.id); return { home: true }; },
    })),
  // Appearance
  (q) => {
    const out = [];
    if (commandMatches(q, ['light', 'appearance', 'scheme'])) {
      out.push({
        kind: 'appearance',
        label: 'appearance · light',
        hint: 'quiet light surface',
        run: () => { actions.setAppearanceScheme('light'); return { ok: 'appearance · light' }; },
      });
    }
    if (commandMatches(q, ['dark', 'appearance', 'scheme'])) {
      out.push({
        kind: 'appearance',
        label: 'appearance · dark',
        hint: 'quiet dark surface',
        run: () => { actions.setAppearanceScheme('dark'); return { ok: 'appearance · dark' }; },
      });
    }
    // /theme, /theme <id> — the material under the scheme (see themes.js)
    const tokens = (q || '').trim().split(/\s+/).filter(Boolean);
    const head = normalizeCommand(tokens[0] || '');
    if (head && 'theme'.startsWith(head)) {
      const f = normalizeCommand(tokens.slice(1).join(' '));
      const cur = store.get().appearance.theme;
      THEMES
        .filter((t) => !f || normalizeCommand(t.id).includes(f) || normalizeCommand(t.description).includes(f))
        .forEach((t) => out.push({
          kind: 'theme',
          label: `theme · ${t.label}`,
          hint: (t.id === cur ? 'current · ' : '') + t.description,
          run: () => { actions.setTheme(t.id); return { ok: `theme · ${t.label}` }; },
        }));
    } else if (!head || commandMatches(q, ['appearance', 'theme'])) {
      out.push({
        kind: 'theme-hint',
        label: `theme · ${store.get().appearance.theme}`,
        hint: 'change the material',
        run: () => { setInput('/theme'); return {}; },
      });
    }
    const accent = parseAccentCommand(q);
    if (accent === 'auto') {
      out.push({
        kind: 'appearance',
        label: 'appearance · accent auto',
        hint: themeById[store.get().appearance.theme]?.followCover === false ? 'back to the theme ink' : 'follow the album cover',
        run: () => { actions.setAccent(null); return { ok: 'accent · auto' }; },
      });
    } else if (accent) {
      out.push({
        kind: 'appearance',
        label: 'appearance · accent',
        hint: accent,
        run: () => { actions.setAccent(accent); return { ok: `accent · ${accent}` }; },
      });
    } else if (commandMatches(q, ['accent', 'color', 'colour'])) {
      out.push({
        kind: 'appearance',
        label: 'appearance · accent #rrggbb | auto',
        hint: `current ${store.get().appearance.accent || 'auto'}`,
        run: () => ({ warn: 'usage: /accent #d8b35f · /accent auto' }),
      });
    }
    return out;
  },
];

export const SONG_BUILDERS = [
  (q) => {
    if (q.length < 1) return [];
    return scoreLibrary(q, store.get().library.tracks)
      .slice(0, 8)
      .map(({ track }) => songEntry(track, { glyph: GLYPH.LIKED, group: 'library' }));
  },
];

export const ASYNC_BUILDERS = [
  async (q, { signal, ok }) => {
    if (q.length < 2) return [];
    let songs = [];
    try {
      const r = await api('/cloudsearch', { keywords: q, type: 1, limit: 8 }, { signal });
      songs = r.result?.songs || [];
    } catch { return []; }
    if (!ok()) return [];
    const inLib = new Set(store.get().library.tracks.map((t) => t.id));
    // Cloud hits live in their own "from netease" group, marked with a dimmed
    // ↓ (not-yet-yours). Library hits keep ♥; ▶ stays reserved for the
    // currently-playing track.
    return songs
      .filter((s) => !inLib.has(s.id))
      .map((s) => songEntry(
        { id: s.id, name: s.name, ar: s.ar, al: s.al, dt: s.dt },
        { glyph: GLYPH.NETEASE, dim: true, group: 'from netease' }
      ));
  },
];
