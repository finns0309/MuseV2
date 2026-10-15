// Sleep timer — stop the music after a while, gently. Either a duration
// (the last few seconds fade out, then pause) or "end of this song" (the
// player stops at the next `ended` instead of advancing).
//
// State is in-memory only: a timer shouldn't survive a relaunch.

import * as player from '../player.js';

const FADE_S = 8;
let timer = null;
let endsAt = 0;
let endOfSong = false;
const listeners = new Set();

const notify = () => { for (const fn of listeners) fn(state()); };

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function state() {
  return { active: !!timer || endOfSong, endsAt, endOfSong };
}

export function after(minutes) {
  cancel({ quiet: true });
  const ms = minutes * 60_000;
  endsAt = Date.now() + ms;
  timer = setTimeout(async () => {
    timer = null; endsAt = 0; notify();
    await player.fadeOutAndPause(FADE_S);
  }, Math.max(0, ms - FADE_S * 1000));
  notify();
}

export function atEndOfSong() {
  cancel({ quiet: true });
  endOfSong = true;
  player.setStopAfterCurrent(true);
  notify();
}

export function cancel({ quiet = false } = {}) {
  clearTimeout(timer);
  timer = null; endsAt = 0;
  if (endOfSong) { endOfSong = false; player.setStopAfterCurrent(false); }
  if (!quiet) notify();
}

player.onStoppedAfterCurrent(() => { endOfSong = false; notify(); });

// "24m", "1h 05m", "after this song"
export function label(st = state()) {
  if (st.endOfSong) return 'after this song';
  if (!st.endsAt) return '';
  const min = Math.max(0, Math.ceil((st.endsAt - Date.now()) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}
