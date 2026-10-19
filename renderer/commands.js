// What the list shows. buildCommands() is the `/` menu (scopes, submenus,
// free search over every leaf); SONG_BUILDERS / ASYNC_BUILDERS are bare-text
// search — sync over the library on every keystroke, async over NetEase,
// racing the latest input via store.race('cmdk').

import { store, actions } from './store.js';
import { MODES } from './modes/index.js';
import {
  buildQueueForPickedTrack,
  describeSession,
  setManualSession,
  setRadioSession,
  setAskSession,
  setTimeSession,
  setMusePlaylistSession,
} from './modes/session.js';
import * as memory from './lib/memory.js';
import * as sleep from './lib/sleep.js';
import * as player from './player.js';
import { fetchSimilar } from './lib/similar.js';
import { toggleHeart } from './lib/library.js';
import { api } from './api.js';
import * as playlist from './playlist.js';
import * as col from './lib/collections.js';
import * as dj from './lib/dj.js';
import * as remote from './lib/remote.js';
import { GLYPH } from './glyphs.js';
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
    // ⌘↵ / ⇧↵ — reshape what comes next without touching what's playing.
    nextRun: () => queueResult(player.playNext(track), track, 'plays next'),
    queueRun: () => queueResult(player.enqueue(track), track, 'added to the queue'),
  };
}

function queueResult(outcome, track, said) {
  if (outcome === 'current') return { warn: 'that’s the one playing' };
  if (outcome === 'playing') return { home: true };
  return { ok: `${track.name} · ${said}` };
}

// Structured song row: cover thumbnail + name (+ ♥ if liked) + artist (sub) +
// duration. `group` tags it for the section header ("Your library", "From
// NetEase", "Up next" …); `dim` softens cloud hits that aren't yours yet.
export function songEntry(track, { glyph = GLYPH.LIKED, dim = false, group } = {}) {
  const isHearted = store.get().library.tracks.some((t) => t.id === track.id);
  return {
    kind: isHearted ? 'library-song' : 'song',
    home: true,          // Enter lands on the keypress; playback catches up (see cmdk.execute)
    glyph, dim, group, track,
    cover: track.al?.picUrl || '',
    liked: isHearted,
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

function queueEntry(track, idx, isCurrent, group) {
  return {
    ...songEntry(track, { group }),
    kind: isCurrent ? 'queue-current' : 'queue-item',
    queueIdx: idx,
    run: () => {
      if (!isCurrent) player.playAt(idx);
      return { home: true };
    },
    // ⌘⌫ / ⌥↑↓ inside /queue. The current track stays put.
    removeRun: isCurrent ? null : () => (player.removeAt(idx) ? {} : { warn: 'can’t remove that one' }),
    moveRun: isCurrent ? null : (delta) => (player.moveBy(idx, delta) >= 0 ? { cursorDelta: delta } : {}),
  };
}

// ---- Command menu -------------------------------------------------------------
//
// `/` is a short menu of scopes — Queue, Library, Playlists, Mode, Appearance,
// Theme, Accent — each one a submenu. A scope is entered by Enter / → / Tab on
// its row, by typing `/theme ` (cmdk turns the prefix into a chip), or from
// the session picker; inside it the rest of the input filters its items.
// Typing after `/` with no scope searches every leaf at once, grouped by the
// scope it lives in — so `/da` finds Dark and Daily side by side.
//
// Menu-row fields (rendered by cmdk.renderList):
//   icon     key into icons.js        swatch   [paper, ink] colour tile instead
//   title    main text                desc     muted text right after it
//   value    right-aligned state      checked  ✓ on the right
//   submenu  scope id → ›, Enter drills in
//   group    section header           inert    not runnable (a note, "N more")

const LISTEN = 'Listen';
const LOOK = 'Look';
const LIST_CAP = 150;   // long scopes (library, queue) render this many, then a note

const cap = (t) => { t = String(t || ''); return t.charAt(0).toUpperCase() + t.slice(1); };

const MODE_ICON = {
  all: 'shuffle', daily: 'calendar', discover: 'compass', digup: 'history',
  immersive: 'mic', similar: 'sparkle', single: 'repeat1',
};

// Mid-tone pins that stay legible on both light and dark surfaces.
const ACCENT_PRESETS = [
  { name: 'Clay',      hex: '#d97757' },
  { name: 'Vermilion', hex: '#d0573e' },
  { name: 'Lake',      hex: '#5b8fd6' },
  { name: 'Moss',      hex: '#7a9e5f' },
  { name: 'Plum',      hex: '#a07ab8' },
];

function matches(filter, ...parts) {
  const f = normalizeCommand(filter);
  return !f || parts.some((p) => normalizeCommand(p).includes(f));
}

function note(title, desc = '') {
  return { kind: 'note', icon: 'dot', title, desc, inert: true, run: () => ({}) };
}

// -- scope items --

function buildQueueEntries(filter) {
  const { queue, queueIdx } = store.get().player;
  if (!queue.length) return [note('Nothing queued', 'pick a song or a mode first')];
  const f = (filter || '').trim().toLowerCase();
  const hit = (t) => !f || (t.name || '').toLowerCase().includes(f) || formatArtists(t).toLowerCase().includes(f);
  const out = [];
  if (queue[queueIdx] && hit(queue[queueIdx])) out.push(queueEntry(queue[queueIdx], queueIdx, true, 'Now playing'));
  let shown = 0, hidden = 0;
  for (let i = queueIdx + 1; i < queue.length; i++) {
    if (!hit(queue[i])) continue;
    if (shown < LIST_CAP) { out.push(queueEntry(queue[i], i, false, 'Up next')); shown++; } else hidden++;
  }
  if (hidden) out.push({ ...note(`${hidden} more up next`, 'type to filter'), group: 'Up next' });
  // Single mode: nothing comes next by design — say so, and offer the way out.
  const s = store.get().playbackSession;
  if (!f && queue.length === 1 && s?.kind === 'mode' && s.modeId === 'single') {
    out.push({
      kind: 'note', icon: 'repeat1', group: 'Up next', submenu: 'mode',
      title: 'Single — this one repeats', desc: 'pick another mode to move on',
      run: () => ({ scope: 'mode' }),
    });
  }
  for (let i = queueIdx - 1, n = 0; i >= 0 && n < 10; i--) {
    if (!hit(queue[i])) continue;
    out.push(queueEntry(queue[i], i, false, 'Played'));
    n++;
  }
  return out.length ? out : [note('No matches in the queue')];
}

// Your history, newest first, a section per day; the time you heard it on
// the right, ×N for a song you looped.
function buildRecentEntries(filter) {
  const f = (filter || '').trim().toLowerCase();
  const rows = memory.recent(f ? 400 : LIST_CAP)
    .filter(({ track: t }) => !f || (t.name || '').toLowerCase().includes(f) || formatArtists(t).toLowerCase().includes(f));
  if (!rows.length) return [note(f ? 'Nothing like that lately' : 'Nothing played yet')];
  return rows.map(({ track, at, count }) => {
    const e = songEntry(track, { group: memory.dayLabel(at) });
    const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return { ...e, dur: count > 1 ? `×${count} · ${time}` : time };
  });
}

function buildLibraryEntries(filter) {
  const tracks = store.get().library.tracks;
  if (!tracks.length) return [note('Your library is empty', 'like songs on NetEase first')];
  const f = (filter || '').trim().toLowerCase();
  const sorted = tracks.slice().sort((a, b) =>
    (b.lastPlayedAt || b.addedAt || 0) - (a.lastPlayedAt || a.addedAt || 0)
  );
  const filtered = f
    ? sorted.filter((t) => (t.name || '').toLowerCase().includes(f) || formatArtists(t).toLowerCase().includes(f))
    : sorted;
  if (!filtered.length) return [note('No matches in your library')];
  const group = f ? 'Matches' : 'Recently played';
  const out = filtered.slice(0, LIST_CAP).map((t) => songEntry(t, { group }));
  if (filtered.length > LIST_CAP) out.push({ ...note(`${filtered.length - LIST_CAP} more`, 'type to filter'), group });
  return out;
}

function buildPlaylistEntries(filter) {
  const saved = playlist.getAll();
  const raw = (filter || '').trim();
  const plId = playlist.parseId(raw);
  if (plId) {
    const existing = saved.find((p) => p.id === plId);
    return [{
      kind: 'playlist-load', home: false, icon: 'playlist',
      title: existing ? existing.name : `Playlist #${plId}`,
      desc: existing ? `${existing.trackCount} tracks` : 'load and play',
      run: () => playlist.load(plId),
    }];
  }
  const out = col.list('playlists')
    .filter((p) => matches(raw, p.name, p.source?.prompt))
    .slice(0, LIST_CAP)
    .map(musePlaylistRow);
  out.push(...saved
    .filter((p) => matches(raw, p.name))
    .map((p) => ({
      kind: 'playlist-saved', icon: 'playlist', group: 'NetEase',
      title: p.name, desc: `${p.trackCount} tracks`,
      run: () => playlist.load(p.id),
    })));
  out.push({ ...note('Add a playlist', 'paste a NetEase link or ID here'), icon: 'plus', group: 'NetEase' });
  return out;
}

function modeLeaves() {
  const cur = store.get().mode;
  return MODES.map((m) => ({
    kind: 'mode', home: true,
    icon: MODE_ICON[m.id] || 'radio',
    title: cap(m.label), desc: m.description || '',
    checked: m.id === cur, keywords: [m.id, 'mode', 'radio'],
    run: () => { actions.setMode(m.id); return { home: true }; },
  }));
}

function appearanceLeaves() {
  const { scheme: cur, menuBar } = store.get().appearance;
  return [
    ...['light', 'dark'].map((scheme) => ({
      kind: 'appearance',
      icon: scheme === 'light' ? 'sun' : 'moon',
      title: cap(scheme), desc: `quiet ${scheme} surface`,
      checked: scheme === cur, keywords: ['appearance', 'scheme'],
      run: () => { actions.setAppearanceScheme(scheme); return { ok: `appearance · ${scheme}` }; },
    })),
    {
      kind: 'appearance', icon: 'menubar',
      title: 'Song in the menu bar', desc: menuBar ? 'on — the title beside the ✻' : 'off — just the ✻',
      checked: menuBar, keywords: ['menu bar', 'menubar', 'tray', 'title'],
      run: () => { actions.setMenuBar(!menuBar); return { ok: `menu bar · ${menuBar ? 'off' : 'on'}` }; },
    },
  ];
}

function themeLeaves() {
  const cur = store.get().appearance.theme;
  return THEMES.map((t) => ({
    kind: 'theme',
    swatch: t.swatch,
    title: cap(t.label), desc: t.description,
    checked: t.id === cur, keywords: [t.id, 'theme'],
    run: () => { actions.setTheme(t.id); return { ok: `theme · ${t.label}` }; },
  }));
}

function accentLeaves(filter) {
  const { accent: cur, theme } = store.get().appearance;
  const followsCover = themeById[theme]?.followCover !== false;
  const out = [];
  const hex = (String(filter || '').trim().match(/^#?([0-9a-f]{6})$/i) || [])[1];
  if (hex) {
    const h = `#${hex.toLowerCase()}`;
    out.push({
      kind: 'accent', swatch: [h, h], title: `Use ${h}`, desc: 'pin this colour',
      checked: cur === h,
      run: () => { actions.setAccent(h); return { ok: `accent · ${h}` }; },
    });
    return out;
  }
  out.push({
    kind: 'accent', icon: 'droplet', title: 'Auto',
    desc: followsCover ? 'follow the album cover' : 'the theme’s own ink',
    checked: !cur, keywords: ['accent', 'auto'],
    run: () => { actions.setAccent(null); return { ok: 'accent · auto' }; },
  });
  for (const p of ACCENT_PRESETS) {
    out.push({
      kind: 'accent', swatch: [p.hex, p.hex], title: p.name, desc: p.hex,
      checked: cur === p.hex, keywords: ['accent', 'color', 'colour'],
      run: () => { actions.setAccent(p.hex); return { ok: `accent · ${p.name.toLowerCase()}` }; },
    });
  }
  if (cur && !ACCENT_PRESETS.some((p) => p.hex === cur)) {
    out.splice(1, 0, {
      kind: 'accent', swatch: [cur, cur], title: 'Pinned', desc: cur, checked: true,
      run: () => ({ ok: `accent · ${cur}` }),
    });
  }
  out.push({ ...note('Any colour', 'type a hex here, like #d8b35f'), icon: 'plus' });
  return out;
}

// Your history as eras: a month each, most-played first — and, when there is
// one, "N months ago today" on top.
function playTime(kind, label, tracks) {
  if (!tracks.length) return { warn: 'nothing there to play' };
  player.setQueue(tracks, { startIdx: 0 });
  setTimeSession({ kind, label, trackCount: tracks.length });
  return { home: true };
}

function eraLeaves() {
  const out = [];
  const day = memory.onThisDay();
  if (day) {
    out.push({
      kind: 'memory', home: true, icon: 'history',
      title: day.label, desc: `${day.tracks.length} songs you played on ${new Date(day.date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`,
      keywords: ['today', 'ago', 'memory', 'era'],
      run: () => playTime('memory', `↺ ${day.label}`, day.tracks),
    });
  }
  for (const e of memory.eras()) {
    out.push({
      kind: 'era', home: true, icon: 'layers',
      title: e.label, desc: `${e.plays} plays · most: ${e.top}`,
      keywords: [e.key, 'era', 'month'],
      run: () => playTime('era', `Era · ${e.label}`, e.tracks()),
    });
  }
  return out;
}

// Playback: the sleep timer, smooth transitions, loudness matching.
function playbackLeaves() {
  const st = sleep.state();
  const { fades, normalize } = store.get().playback || {};
  const timer = (title, minutes) => ({
    kind: 'sleep', icon: 'timer', title, desc: 'fades out, then pauses',
    checked: !!st.endsAt && Math.abs(st.endsAt - Date.now() - minutes * 60_000) < 60_000,
    keywords: ['sleep', 'timer', String(minutes)],
    run: () => { sleep.after(minutes); return { ok: `sleep · in ${sleep.label()}` }; },
  });
  const out = [
    timer('In 15 minutes', 15), timer('In 30 minutes', 30), timer('In 45 minutes', 45), timer('In an hour', 60),
    {
      kind: 'sleep', icon: 'timer', title: 'After this song', desc: 'stop when it ends',
      checked: st.endOfSong, keywords: ['sleep', 'stop', 'end'],
      run: () => { sleep.atEndOfSong(); return { ok: 'stops after this song' }; },
    },
  ];
  if (st.active) {
    out.push({
      kind: 'sleep', icon: 'x', title: 'Cancel the timer', desc: `it would stop ${sleep.label() === 'after this song' ? 'after this song' : `in ${sleep.label()}`}`,
      keywords: ['sleep', 'cancel', 'off'],
      run: () => { sleep.cancel(); return { ok: 'sleep timer off' }; },
    });
  }
  out.push(
    {
      kind: 'playback', icon: 'waves', title: 'Smooth transitions',
      desc: 'fade between songs, and in and out of pauses',
      checked: fades !== false, keywords: ['fade', 'crossfade', 'transition'],
      run: () => { actions.setPlaybackPref('fades', fades === false); return { ok: `transitions · ${fades === false ? 'smooth' : 'cut'}` }; },
    },
    {
      kind: 'playback', icon: 'volume', title: 'Even out loudness',
      desc: 'turn down tracks mastered louder than the rest',
      checked: normalize !== false, keywords: ['loudness', 'normalize', 'volume', 'replaygain'],
      run: () => { actions.setPlaybackPref('normalize', normalize === false); return { ok: `loudness · ${normalize === false ? 'even' : 'as mastered'}` }; },
    },
  );
  return out;
}

// Agents: how to let Claude Code (or anything that speaks MCP, or a shell)
// drive Muse, and what they've been up to. ↵ copies the setup line.
function agentLeaves() {
  const info = remote.controlInfo();
  const dir = info?.agentDir || '/Applications/MuseV2.app/Contents/Resources/agent';
  const q = (p) => `"${p}"`;
  const copy = (text, what) => () => Promise.resolve(window.muse.copyText?.(text)).then(() => ({ ok: `copied · ${what} — paste it in a terminal` }));
  const out = [
    {
      kind: 'agents', icon: 'sparkle', group: 'Connect',
      title: 'Add Muse to Claude Code', desc: 'copies the claude mcp add line',
      keywords: ['mcp', 'claude', 'agent'],
      run: copy(`claude mcp add --scope user muse -- node ${q(`${dir}/mcp.js`)}`, 'the MCP line'),
    },
    {
      kind: 'agents', icon: 'menubar', group: 'Connect',
      title: 'Put muse on your PATH', desc: info?.binDir ? `copies a link into ${info.binDir}` : 'copies the path to the CLI',
      keywords: ['cli', 'terminal', 'command'],
      run: info?.binDir
        ? copy(`ln -sf ${q(`${dir}/cli.js`)} ${q(`${info.binDir}/muse`)} && muse`, 'the link line')
        : copy(`node ${q(`${dir}/cli.js`)}`, 'the CLI path'),
    },
  ];
  const acts = remote.recentActivity();
  for (const a of acts.slice(0, 12)) {
    out.push({ ...note(`${a.agent} ${a.summary}`, memory.ago(a.at) === 'today' ? new Date(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : memory.ago(a.at)), icon: 'dot', group: 'Lately' });
  }
  if (!acts.length) out.push({ ...note('Nothing yet', info?.port ? `listening on 127.0.0.1:${info.port}` : 'the door opens with the app'), group: 'Lately' });
  return out;
}

const filterLeaves = (leaves, f) => leaves.filter((e) => matches(f, e.title, e.desc, ...(e.keywords || [])));

// -- scopes --

const SCOPES = [
  {
    id: 'queue', aliases: ['q'], title: 'Queue', icon: 'queue', group: LISTEN,
    row() {
      const { queue, queueIdx } = store.get().player;
      if (!queue.length) return null;
      const left = Math.max(0, queue.length - (queueIdx + 1));
      return { desc: left ? `${left} up next` : 'last track', value: sessionTitle() };
    },
    items: buildQueueEntries,
  },
  {
    id: 'asks', aliases: ['ask', 'dj', 'chats'], title: 'Asks', icon: 'spark', group: LISTEN,
    row() {
      const asks = col.list('asks');
      if (!asks.length) return null;
      const thinking = dj.pending().length;
      return thinking
        ? { desc: `${asks.length} so far`, value: 'Thinking…' }
        : { desc: `${asks.length} so far · last: ${asks[0].title || asks[0].turns[0]?.q || ''}` };
    },
    items: buildAskEntries,
    leaves: () => col.list('asks').slice(0, 40).map((a) => askRow(a)),
  },
  {
    id: 'recent', aliases: ['history', 'played', 'last'], title: 'Recently played', icon: 'clock', group: LISTEN,
    row() {
      const r = memory.recent(400);
      if (!r.length) return null;
      const today = r.filter((x) => memory.dayLabel(x.at) === 'Today').length;
      return { desc: today ? `${today} today` : `last: ${r[0].track.name}` };
    },
    items: buildRecentEntries,
  },
  {
    id: 'library', aliases: ['lib'], title: 'Library', icon: 'heart', group: LISTEN,
    row() {
      const n = store.get().library.tracks.length;
      return n ? { desc: `${n} liked songs` } : null;
    },
    items: buildLibraryEntries,
  },
  {
    id: 'playlist', aliases: ['pl', 'playlists'], title: 'Playlists', icon: 'playlist', group: LISTEN,
    row() {
      const m = col.list('playlists').length, n = playlist.getAll().length;
      const parts = [m && `${m} from Muse`, n && `${n} from NetEase`].filter(Boolean);
      return { desc: parts.length ? parts.join(' · ') : 'paste a NetEase link' };
    },
    items: buildPlaylistEntries,
  },
  {
    id: 'era', aliases: ['eras', 'month', 'months'], title: 'Eras', icon: 'layers', group: LISTEN,
    row() {
      const n = memory.eras().length;
      return n ? { desc: `${n} months of your listening` } : null;
    },
    items: (f) => filterLeaves(eraLeaves(), f),
    leaves: eraLeaves,
  },
  {
    id: 'playback', aliases: ['sleep', 'timer', 'fade', 'fades', 'loudness'], title: 'Playback', icon: 'sliders', group: LISTEN,
    row() {
      const st = sleep.state();
      return st.active
        ? { desc: 'sleep timer on', value: sleep.label() === 'after this song' ? 'After this song' : `☾ ${sleep.label()}` }
        : { desc: 'sleep timer, fades, loudness' };
    },
    items: (f) => filterLeaves(playbackLeaves(), f),
    leaves: playbackLeaves,
  },
  {
    id: 'mode', aliases: ['modes', 'radio'], title: 'Mode', icon: 'radio', group: LISTEN,
    row() {
      const m = MODES.find((x) => x.id === store.get().mode);
      return { desc: m?.description || '', value: m ? cap(m.label) : '' };
    },
    items: (f) => filterLeaves(modeLeaves(), f),
    leaves: modeLeaves,
  },
  {
    id: 'appearance', aliases: ['scheme'], title: 'Appearance', icon: 'contrast', group: LOOK,
    row: () => ({ desc: 'light, dark, the menu bar', value: cap(store.get().appearance.scheme) }),
    items: (f) => filterLeaves(appearanceLeaves(), f),
    leaves: appearanceLeaves,
  },
  {
    id: 'theme', aliases: ['themes'], title: 'Theme', icon: 'palette', group: LOOK,
    row: () => ({ desc: 'the material', value: cap(themeById[store.get().appearance.theme]?.label) }),
    items: (f) => filterLeaves(themeLeaves(), f),
    leaves: themeLeaves,
  },
  {
    id: 'accent', aliases: ['color', 'colour'], title: 'Accent', icon: 'droplet', group: LOOK,
    row() {
      const { accent: cur } = store.get().appearance;
      const preset = ACCENT_PRESETS.find((p) => p.hex === cur);
      return { desc: 'the one colour', value: cur ? (preset?.name || cur) : 'Auto' };
    },
    items: (f) => {
      const all = accentLeaves(f);
      return /^#?[0-9a-f]{6}$/i.test((f || '').trim()) ? all : filterLeaves(all, f).concat(all.filter((e) => e.inert && f));
    },
    leaves: () => accentLeaves('').filter((e) => !e.inert),
  },
  {
    id: 'agents', aliases: ['agent', 'mcp', 'cli', 'claude'], title: 'Agents', icon: 'sparkle', group: 'Connect',
    row() {
      const n = remote.recentActivity().length;
      const last = remote.recentActivity()[0];
      return { desc: last ? `${last.agent} ${last.summary}` : 'Claude Code and the muse command', value: n ? `${n} lately` : '' };
    },
    items: (f) => filterLeaves(agentLeaves(), f),
    leaves: () => agentLeaves().filter((e) => !e.inert),
  },
];

// The session picker and chips talk about the queue the way a model picker
// talks about a model: "Daily", "Radio · 夜に駆ける".
function sessionTitle() {
  const s = store.get().playbackSession;
  if (!s) return '';
  const mode = s.kind === 'mode' && MODES.find((m) => m.id === s.modeId);
  return mode ? cap(mode.label) : cap(describeSession(s));
}

// `/lib`, `/pl`, `/theme` … → a scope. Exact id or alias, or an unambiguous
// prefix of at least two letters (so `/the claude` still lands in Theme).
export function resolveScope(word) {
  const w = normalizeCommand(word);
  if (!w) return null;
  const exact = SCOPES.find((s) => s.id === w || s.aliases.includes(w));
  if (exact) return { id: exact.id, title: exact.title };
  if (w.length < 2) return null;
  const pre = SCOPES.filter((s) => s.id.startsWith(w));
  return pre.length === 1 ? { id: pre[0].id, title: pre[0].title } : null;
}

function scopeRow(s) {
  const r = s.row();
  if (!r) return null;
  return { kind: 'scope', icon: s.icon, title: s.title, group: s.group, submenu: s.id, ...r, run: () => ({ scope: s.id }) };
}

// text: what follows `/` (or the chip). scopeId: the chip, if any.
export function buildCommands(text, scopeId = null) {
  let t = String(text || '');
  if (!scopeId) {
    const m = t.match(/^(\S+)\s+([\s\S]*)$/);
    const sc = m && resolveScope(m[1]);
    if (sc) { scopeId = sc.id; t = m[2]; }
  }
  if (scopeId) {
    const s = SCOPES.find((x) => x.id === scopeId);
    return s ? s.items(t.trim()) : [];
  }
  const q = t.trim();
  if (!q) return SCOPES.map(scopeRow).filter(Boolean);

  // Free search: matching scope rows, then every matching leaf grouped under
  // the scope it belongs to.
  const out = SCOPES
    .filter((s) => matches(q, s.title, s.id, ...s.aliases))
    .map(scopeRow).filter(Boolean)
    .map((r) => ({ ...r, group: 'Menus' }));
  for (const s of SCOPES) {
    if (!s.leaves) continue;
    for (const leaf of filterLeaves(s.leaves(), q)) out.push({ ...leaf, group: s.title });
  }
  if (/^#?[0-9a-f]{6}$/i.test(q)) out.push(...accentLeaves(q).map((e) => ({ ...e, group: 'Accent' })));
  const plId = /^\d{5,}$/.test(q) || /[?&]id=\d+/.test(q) ? playlist.parseId(q) : null;
  if (plId) out.push(...buildPlaylistEntries(q).map((e) => ({ ...e, group: 'Playlists' })));
  return out.length ? out : [note('No commands match', 'Esc to clear')];
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

// ---- Ask ---------------------------------------------------------------------

// The row that sends a bare query to the DJ (lib/ask.js). cmdk puts it above
// the search results when the query reads like a request, below otherwise.
export function askEntry(q) {
  return {
    kind: 'ask', icon: 'spark', group: 'Ask Muse',
    title: `“${q}”`, desc: 'from your listening — or anywhere on NetEase',
    run: () => ({ ask: q }),
  };
}

// Play what an ask holds (its playlist, as edited since) from song k.
export function playAsk(ask, k = 0) {
  const tracks = dj.tracksOf(ask);
  if (!tracks.length) return { warn: 'nothing to play in that one' };
  const pl = ask.playlistId ? col.get('playlists', ask.playlistId) : null;
  player.setQueue(tracks, { startIdx: k });
  setAskSession({ prompt: ask.turns[0]?.q || '', title: pl?.name || ask.title, trackCount: tracks.length, askId: ask.id });
  return { home: true };
}

// Play a Muse playlist from song k — as its conversation when it has one.
function playMusePlaylist(pl, k = 0) {
  const ask = pl.source?.kind === 'ask' ? col.get('asks', pl.source.askId) : null;
  if (ask) return playAsk(ask, k);
  player.setQueue(pl.tracks, { startIdx: k });
  setMusePlaylistSession(pl);
  return { home: true };
}

// ⌘↵ / ⇧↵ on a whole answer or playlist: after this song, or at the end.
// With nothing playing there's nothing to queue behind — just play it.
function queueAll(tracks, how, label, play) {
  if (!store.get().player.track) return play();
  if (how === 'next') for (const t of [...tracks].reverse()) player.playNext(t);
  else for (const t of tracks) player.enqueue(t);
  return { ok: `${label} · ${how === 'next' ? 'plays next' : 'added to the queue'}` };
}

const coversOf = (tracks) => (tracks || []).slice(0, 4).map((t) => t.al?.picUrl).filter(Boolean);

// Who made a Muse playlist, in a word: the DJ, an agent by name, or you.
export function madeBy(pl) {
  if (!pl) return '';
  if (pl.source?.kind === 'ask') return 'the DJ';
  if (pl.source?.kind === 'agent') return pl.source.agent || 'an agent';
  return 'you';
}

// Edit a Muse playlist's songs by hand (⌘⌫ / ⌥↑↓ in its view). Signed "you".
function editTracks(plId, fn) {
  const pl = col.get('playlists', plId);
  if (!pl) return false;
  const tracks = fn(pl.tracks.slice());
  if (!tracks) return false;
  col.put('playlists', { ...pl, tracks, updatedAt: Date.now(), editedBy: 'you' });
  return true;
}

// A playlist's songs as rows that play the whole list from there — and,
// when the playlist is a Muse one, can be removed (⌘⌫) or moved (⌥↑↓).
function playlistSongs(tracks, { group, play, plId = null, filter = '' }) {
  const f = filter.trim().toLowerCase();
  const out = [];
  tracks.forEach((t, k) => {
    if (f && !(t.name || '').toLowerCase().includes(f) && !formatArtists(t).toLowerCase().includes(f)) return;
    const e = { ...songEntry(t, { group }), run: () => play(k) };
    if (plId) {
      e.removeRun = () => (editTracks(plId, (xs) => xs.filter((x) => x.id !== t.id)) ? { ok: `removed · ${t.name}` } : {});
      e.moveRun = f ? null : (delta) => {
        const ok = editTracks(plId, (xs) => {
          const i = xs.findIndex((x) => x.id === t.id), j = i + delta;
          if (i < 0 || j < 0 || j >= xs.length) return null;
          [xs[i], xs[j]] = [xs[j], xs[i]];
          return xs;
        });
        return ok ? { cursorDelta: delta } : {};
      };
    }
    out.push(e);
  });
  return out;
}

// The conversation's answer: a card (↵ play all · ⌘↵ next · ⇧↵ queue ·
// ⌥↵ try again · the DJ's three ideas for what to say next) over the songs
// it holds now. A turn that came back empty or failed is a card that asks
// again.
export function answerEntries(ask) {
  const turn = dj.lastTurn(ask);
  const again = () => ({ ask: turn.q, againOf: ask.id });
  const tracks = dj.tracksOf(ask);
  // Nothing to stand on yet — the first answer failed or came back empty.
  // (A failed follow-up keeps the playlist; its card says what went wrong.)
  if (!tracks.length) {
    return [{
      kind: 'answer', icon: 'spark',
      title: turn.status === 'error' ? 'Couldn’t ask' : (turn.title || 'Nothing fit'),
      reply: turn.error || turn.reply || 'Nothing in your listening fits that — try saying it differently.',
      covers: [], count: 0,
      run: again, altRun: again,
    }];
  }
  const pl = ask.playlistId ? col.get('playlists', ask.playlistId) : null;
  const title = pl?.name || ask.title || turn.title;
  // Counted from your listening now, not when the DJ answered — a follow-up
  // keeps the discoveries, and a song you've since played isn't new.
  const lib = new Set(store.get().library.tracks.map((t) => t.id));
  const fresh = tracks.filter((t) => !lib.has(t.id) && !memory.statsFor(t.id).plays).length;
  const notes = [
    fresh ? (fresh === tracks.length ? 'all new to you' : `${fresh} new to you`) : '',
    pl?.editedBy ? `edited by ${pl.editedBy}` : '',
  ].filter(Boolean);
  const card = {
    kind: 'answer', home: true,
    title,
    reply: turn.status === 'done' ? turn.reply
      : turn.status === 'error' ? `Couldn’t do that one — ${turn.error || 'try again'}`
      : (dj.lastAnswer(ask)?.reply || ''),
    count: tracks.length, notes,
    suggestions: turn.status === 'done' ? (turn.suggestions || []) : [],
    covers: coversOf(tracks),
    run: () => playAsk(ask, 0),
    nextRun: () => queueAll(tracks, 'next', title, () => playAsk(ask, 0)),
    queueRun: () => queueAll(tracks, 'queue', title, () => playAsk(ask, 0)),
    altRun: again,
  };
  return [card, ...playlistSongs(tracks, { group: title, play: (k) => playAsk(ask, k), plId: pl?.id })];
}

// A Muse playlist opened on its own (one an agent made, say): its card and
// its songs, which the input filters.
export function playlistEntries(pl, filter = '') {
  const by = madeBy(pl);
  const card = {
    kind: 'answer', home: true, title: pl.name,
    reply: pl.description || `Made by ${by}.`,
    count: pl.tracks.length,
    notes: [pl.description ? `by ${by}` : '', pl.editedBy && pl.editedBy !== by ? `edited by ${pl.editedBy}` : ''].filter(Boolean),
    covers: coversOf(pl.tracks),
    run: () => playMusePlaylist(pl, 0),
    nextRun: () => queueAll(pl.tracks, 'next', pl.name, () => playMusePlaylist(pl, 0)),
    queueRun: () => queueAll(pl.tracks, 'queue', pl.name, () => playMusePlaylist(pl, 0)),
  };
  return [card, ...playlistSongs(pl.tracks, { group: pl.name, play: (k) => playMusePlaylist(pl, k), plId: pl.id, filter })];
}

// One ask as a row in /asks: its mosaic, the title it got, what you said.
// ↵ plays it · → opens the conversation · ⌘↵ / ⇧↵ queue it · ⌘⌫ forgets it.
function askRow(ask, group) {
  const turn = dj.lastTurn(ask);
  const thinking = turn?.status === 'thinking';
  const tracks = dj.tracksOf(ask);
  // Named by the DJ once it answered; until then (or if it never did), by
  // what you said.
  const title = (!thinking && ask.title) || turn?.q || '';
  const time = new Date(ask.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const said = ask.turns.length > 1 ? `“${ask.turns[0]?.q || ''}” + ${ask.turns.length - 1} more` : `“${ask.turns[0]?.q || ''}”`;
  return {
    kind: 'convo', group, thinking,
    covers: thinking && !tracks.length ? [] : coversOf(tracks),
    title,
    desc: thinking ? (ask.turns.length > 1 ? `“${turn.q}” · thinking…` : 'thinking…')
      : turn?.status === 'error' && !tracks.length ? 'didn’t come back — open it to try again'
      : !tracks.length ? 'nothing fit — open it to try again'
      : said + (ask.via ? ` · via ${ask.via}` : ''),
    value: tracks.length && !thinking ? `${tracks.length} songs · ${time}` : time,
    keywords: ask.turns.map((t) => t.q),
    home: tracks.length > 0 && !thinking,
    run: () => (tracks.length && !thinking ? playAsk(ask, 0) : { openAsk: ask.id }),
    openRun: () => ({ openAsk: ask.id }),
    nextRun: tracks.length ? () => queueAll(tracks, 'next', title, () => playAsk(ask, 0)) : null,
    queueRun: tracks.length ? () => queueAll(tracks, 'queue', title, () => playAsk(ask, 0)) : null,
    removeRun: () => { dj.forget(ask.id); return { ok: `forgot · ${title}` }; },
  };
}

function buildAskEntries(filter) {
  const asks = col.list('asks');
  if (!asks.length) return [note('Nothing asked yet', 'type what you’d like to hear, then ↵ on Ask Muse')];
  const f = (filter || '').trim();
  const rows = asks
    .filter((a) => matches(f, a.title, ...a.turns.map((t) => t.q)))
    .slice(0, LIST_CAP)
    .map((a) => askRow(a, memory.dayLabel(a.updatedAt)));
  return rows.length ? rows : [note('No asks like that')];
}

// A Muse playlist as a row in /playlists.
function musePlaylistRow(pl) {
  const ask = pl.source?.kind === 'ask' ? col.get('asks', pl.source.askId) : null;
  const by = madeBy(pl);
  return {
    kind: 'convo', group: 'Muse', home: true,
    covers: coversOf(pl.tracks),
    title: pl.name,
    desc: pl.source?.prompt ? `“${pl.source.prompt}”` : pl.description || `by ${by}`,
    value: `${pl.tracks.length} songs`,
    run: () => playMusePlaylist(pl, 0),
    openRun: () => (ask ? { openAsk: ask.id } : { openPlaylist: pl.id }),
    nextRun: () => queueAll(pl.tracks, 'next', pl.name, () => playMusePlaylist(pl, 0)),
    queueRun: () => queueAll(pl.tracks, 'queue', pl.name, () => playMusePlaylist(pl, 0)),
    removeRun: () => {
      col.remove('playlists', pl.id);
      if (ask?.playlistId === pl.id) col.put('asks', { ...ask, playlistId: null });
      return { ok: `removed · ${pl.name}` };
    },
  };
}

// `setInput` is injected by cmdk.js so builders can programmatically fill the
// search box. Avoids a circular import.
let setInput = () => {};
export function injectSetInput(fn) { setInput = fn; }

export const SONG_BUILDERS = [
  (q) => {
    if (q.length < 1) return [];
    return scoreLibrary(q, store.get().library.tracks)
      .slice(0, 8)
      .map(({ track }) => songEntry(track, { glyph: GLYPH.LIKED, group: 'Your library' }));
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
    // Cloud hits live in their own "From NetEase" group, marked with a dimmed
    // ↓ (not-yet-yours). Library hits keep ♥; ▶ stays reserved for the
    // currently-playing track.
    return songs
      .filter((s) => !inLib.has(s.id))
      .map((s) => songEntry(
        { id: s.id, name: s.name, ar: s.ar, al: s.al, dt: s.dt },
        { glyph: GLYPH.NETEASE, dim: true, group: 'From NetEase' }
      ));
  },
];
