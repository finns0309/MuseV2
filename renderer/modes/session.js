// Playback session glue for modes.
//
// A mode is the policy for "what should play next"; the player queue is just
// the current execution buffer. Keeping this logic near modes lets commands
// and the player ask the same question without each inventing its own rules.

import { store } from '../store.js';
import { byId } from './index.js';

const DEFAULT_EXTEND_LIMIT = 40;
// Sessions whose queue is the whole story — nothing extends them at the end.
const FINITE_SESSIONS = new Set(['manual', 'playlist', 'ask', 'era', 'memory']);

export function setModeSession(modeId) {
  const mode = byId[modeId] || byId.all;
  store.set({
    playbackSession: {
      kind: 'mode',
      modeId: mode.id,
      label: `mode · ${mode.label}`,
      startedAt: Date.now(),
    },
  });
}

export function setManualSession(track) {
  store.set({
    playbackSession: {
      kind: 'manual',
      label: track?.name ? `manual · ${track.name}` : 'manual',
      seedTrackId: track?.id || 0,
      startedAt: Date.now(),
    },
  });
}

export function setRadioSession(track) {
  store.set({
    playbackSession: {
      kind: 'radio',
      modeId: 'similar',
      label: track?.name ? `radio · ${track.name}` : 'radio',
      seedTrackId: track?.id || 0,
      startedAt: Date.now(),
    },
  });
}

export function setPlaylistSession({ id, name, trackCount }) {
  store.set({
    playbackSession: {
      kind: 'playlist',
      playlistId: id,
      label: name ? `playlist · ${name}` : 'playlist',
      trackCount: trackCount || 0,
      startedAt: Date.now(),
    },
  });
}

// A queue the DJ built from a request ("下雨天，安静点的"). Like a playlist it
// ends when it ends — no mode keeps extending it.
export function setAskSession({ prompt, title, trackCount }) {
  store.set({
    playbackSession: {
      kind: 'ask',
      prompt: prompt || '',
      label: title ? `✻ ${title}` : '✻ ask',
      trackCount: trackCount || 0,
      startedAt: Date.now(),
    },
  });
}

// A queue cut from your own history — an era (a month, most-played first) or
// "N months ago today". Ends when it ends.
export function setTimeSession({ kind, label, trackCount }) {
  store.set({
    playbackSession: { kind, label, trackCount: trackCount || 0, startedAt: Date.now() },
  });
}

export function describeSession(session = store.get().playbackSession) {
  return session?.label || 'queue';
}

export async function buildModeQueue(modeId, { seedTrack = null, prepend = [] } = {}) {
  const mode = byId[modeId] || byId.all;
  const state = store.get();
  const player = seedTrack
    ? { ...state.player, track: seedTrack }
    : state.player;

  const result = await mode.build({
    library: playableLibrary(state.library),
    player,
    now: Date.now(),
  });

  const queue = dedupeById([...(prepend || []), ...((result?.queue) || [])]);
  return {
    mode,
    queue,
    startIdx: result?.startIdx || 0,
    error: result?.error || '',
  };
}

export async function buildQueueForPickedTrack(track, { preserveMode = true } = {}) {
  const session = store.get().playbackSession;
  if (preserveMode && session?.kind === 'mode') {
    return buildModeQueue(session.modeId, { seedTrack: track, prepend: [track] });
  }
  return {
    mode: null,
    queue: [track],
    startIdx: 0,
    error: '',
  };
}

export async function extendQueueForCurrentSession({ limit = DEFAULT_EXTEND_LIMIT } = {}) {
  const state = store.get();
  const session = state.playbackSession;
  const current = state.player.track;

  if (!session || FINITE_SESSIONS.has(session.kind)) return [];

  const modeId = session.kind === 'radio' ? 'similar' : session.modeId;
  const mode = byId[modeId] || byId.all;
  if (mode.singleLoop) return [];

  const { queue } = await buildModeQueue(mode.id, { seedTrack: current });
  const existing = new Set((store.get().player.queue || []).map((t) => t?.id));
  let fresh = queue.filter((t) => t?.id && !existing.has(t.id));

  // If the mode's whole candidate space is already in the queue, allow a new
  // pass rather than falling into accidental single-track repeat.
  if (!fresh.length) {
    const currentId = store.get().player.track?.id;
    fresh = queue.filter((t) => t?.id && t.id !== currentId);
  }

  return dedupeById(fresh).slice(0, limit);
}

export function shouldLoopQueueAtEnd() {
  const session = store.get().playbackSession;
  return session?.kind === 'playlist';
}

// Modes get a view of the library without tracks NetEase has pulled
// (`unavailable`, see library.js). The full list stays in the store for cmdk /
// heart state; only queue-building is filtered.
function playableLibrary(library) {
  const tracks = library?.tracks || [];
  const playable = tracks.filter((t) => !t.unavailable);
  return playable.length === tracks.length ? library : { ...library, tracks: playable };
}

function dedupeById(tracks) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}
