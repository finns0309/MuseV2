// The DJ at work. A request becomes an ask — a conversation main keeps —
// and runs on its own: closing the window, Esc, typing something else, none
// of it stops it. When the answer comes it's saved into the ask, the ask's
// Muse playlist is made (or remade, on a try-again), and onLanded tells
// whoever cares — cmdk decides whether to show it, play it, or just say it's
// ready (see cmdk.landAsk).
//
// lib/ask.js makes the one model call; this file is everything around it.

import * as askLib from './ask.js';
import * as col from './collections.js';
import { store } from '../store.js';

const running = new Map();     // askId → { sessionAt } — the playback session when it was sent
const landSubs = new Set();
const pendingSubs = new Set();

export const pending = () => [...running.keys()];
export const isThinking = (id) => running.has(id);
export function onLanded(cb) { landSubs.add(cb); return () => landSubs.delete(cb); }
export function onPending(cb) { pendingSubs.add(cb); return () => pendingSubs.delete(cb); }
const emitPending = () => { for (const cb of pendingSubs) cb(pending()); };

// The answer an ask stands on: its latest turn that came back with songs.
export function lastAnswer(ask) {
  for (let i = (ask?.turns?.length || 0) - 1; i >= 0; i--) {
    const t = ask.turns[i];
    if (t.status === 'done' && t.tracks?.length) return t;
  }
  return null;
}
export const lastTurn = (ask) => ask?.turns?.[ask.turns.length - 1] || null;

// Send a request. → the ask's id. againOf: an ask to try again in — a new
// turn in the same conversation, steering away from its last answer.
export function send(q, { againOf = null } = {}) {
  const now = Date.now();
  const prev = againOf ? col.get('asks', againOf) : null;
  const ask = prev
    ? structuredClone(prev)
    : { id: col.newId('ask'), createdAt: now, title: '', playlistId: null, turns: [] };
  const avoid = (lastAnswer(prev)?.tracks || []).map((t) => t.id);
  ask.turns.push({ q, at: now, status: 'thinking' });
  ask.updatedAt = now;
  col.put('asks', ask);
  running.set(ask.id, { sessionAt: store.get().playbackSession?.startedAt ?? 0 });
  emitPending();

  askLib.ask(q, { avoid }).then(
    (r) => finish(ask.id, {
      status: 'done', title: r.title, reply: r.reply,
      tracks: r.tracks.map(col.compactTrack), model: r.model, ms: r.ms,
    }),
    (e) => finish(ask.id, { status: 'error', error: e?.message || String(e) }),
  );
  return ask.id;
}

function finish(id, outcome) {
  const job = running.get(id);
  running.delete(id);
  const kept = col.get('asks', id);
  if (!kept) { emitPending(); return; }          // forgotten while it was thinking
  const ask = structuredClone(kept);
  const turn = ask.turns.findLast((t) => t.status === 'thinking') || lastTurn(ask);
  Object.assign(turn, outcome);
  const now = Date.now();
  ask.updatedAt = now;
  if (outcome.status === 'done' && outcome.title) ask.title = outcome.title;

  // The conversation keeps one playlist: its latest answer.
  if (outcome.status === 'done' && outcome.tracks.length) {
    const had = ask.playlistId ? col.get('playlists', ask.playlistId) : null;
    const pl = {
      id: had?.id || col.newId('mpl'),
      createdAt: had?.createdAt || now,
      updatedAt: now,
      name: ask.title || turn.title || turn.q,
      tracks: outcome.tracks,
      source: { kind: 'ask', askId: ask.id, prompt: ask.turns[0].q },
    };
    ask.playlistId = pl.id;
    col.put('playlists', pl);
  }
  col.put('asks', ask);
  emitPending();
  for (const cb of landSubs) {
    try { cb({ ask, turn, sessionAt: job?.sessionAt ?? 0 }); } catch (e) { console.warn('[dj] landed', e); }
  }
}

// Forget an ask, and the playlist it made.
export function forget(id) {
  const ask = col.get('asks', id);
  if (!ask) return;
  running.delete(id);
  emitPending();
  if (ask.playlistId) col.remove('playlists', ask.playlistId);
  col.remove('asks', id);
}

// A request still "thinking" on launch was cut off when Muse quit — say so,
// rather than leave it turning forever.
export async function recover() {
  await col.boot();
  for (const ask of col.list('asks')) {
    if (running.has(ask.id) || !ask.turns?.some((t) => t.status === 'thinking')) continue;
    const fixed = structuredClone(ask);
    for (const t of fixed.turns) {
      if (t.status === 'thinking') Object.assign(t, { status: 'error', error: 'Muse closed before the answer came — try again' });
    }
    col.put('asks', fixed);
  }
}
