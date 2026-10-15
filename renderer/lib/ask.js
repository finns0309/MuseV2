// Ask — "What would you like to hear?" answered from your own listening.
//
// One Responses call (lib/llm.js in main): the request, plus a compact index
// of every candidate — the liked library and songs you've played lately that
// aren't liked — plus a listening timeline (your most-played candidates per
// month) and what's playing now. The model answers with a title, a sentence
// or two, and indexes into the candidate list; we map those back to tracks.
//
// Deliberately no tool loop: on this endpoint every round trip costs 10–20s,
// so everything the model could ask for is already in the one prompt.

import { store } from '../store.js';
import { loadHistory } from './memory.js';

const EXTRA_RECENT = 300;   // non-library songs from history offered as candidates
const TIMELINE_MONTHS = 6;
const TIMELINE_TOP = 15;

const artists = (t) => (t.ar || []).map((a) => a.name).join('/');
const yymm = (ms) => { const d = new Date(ms); return `${String(d.getFullYear()).slice(2)}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ym = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export async function available() {
  try { return !!(await window.muse.llm?.available()); } catch { return false; }
}

// The candidate table, the timeline, and the lookup back to tracks.
function buildContext(hist) {
  const lib = store.get().library.tracks.filter((t) => !t.unavailable);
  const tracks = lib.slice();
  const index = new Map(tracks.map((t, i) => [t.id, i]));
  const plays = new Map();
  for (const h of hist) plays.set(h.songId, (plays.get(h.songId) || 0) + 1);

  for (let i = hist.length - 1, n = 0; i >= 0 && n < EXTRA_RECENT; i--) {
    const h = hist[i];
    if (!h?.songId || index.has(h.songId)) continue;
    index.set(h.songId, tracks.length);
    tracks.push({
      id: h.songId, name: h.name,
      ar: String(h.artist || '').split(/\s*[,/]\s*/).filter(Boolean).map((name) => ({ name })),
      al: { name: h.album, picUrl: h.picUrl }, dt: h.durationMs || 0,
      notLiked: true,
    });
    n++;
  }

  const lines = tracks.map((t, i) =>
    `${i}|${t.name}|${artists(t)}|${t.playCount || plays.get(t.id) || 0}|${t.notLiked ? '-' : t.addedAt ? yymm(t.addedAt) : '?'}`);

  // Most-played candidates per month, newest first: "2026-08: 12×31, 55×20, …"
  const byMonth = new Map();
  for (const h of hist) {
    const i = index.get(h.songId);
    if (i === undefined || !h.at) continue;
    const m = ym(h.at);
    if (!byMonth.has(m)) byMonth.set(m, new Map());
    const c = byMonth.get(m);
    c.set(i, (c.get(i) || 0) + 1);
  }
  const timeline = [...byMonth.keys()].sort().reverse().slice(0, TIMELINE_MONTHS).map((m) => {
    const top = [...byMonth.get(m)].sort((a, b) => b[1] - a[1]).slice(0, TIMELINE_TOP);
    return `${m}: ${top.map(([i, n]) => `${i}×${n}`).join(', ')}`;
  });
  // And the last seven days, since "lately" is the most common time word.
  const weekAgo = Date.now() - 7 * 86400000;
  const week = new Map();
  for (const h of hist) {
    const i = index.get(h.songId);
    if (i !== undefined && h.at >= weekAgo) week.set(i, (week.get(i) || 0) + 1);
  }
  const lastWeek = [...week].sort((a, b) => b[1] - a[1]).slice(0, TIMELINE_TOP).map(([i, n]) => `${i}×${n}`).join(', ');

  return { tracks, index, lines, timeline, lastWeek };
}

const INSTRUCTIONS = `You are the DJ inside Muse, a music player. The user says what they want to hear; you build a queue ONLY from CANDIDATES (index|title|artists|plays|liked yy-mm, "-" = not liked yet).
- Use what you know about these songs and artists: mood, tempo, language, vocals, instrumentation, era.
- TIMELINE lists the user's most-played candidates per month and for the last 7 days (index×plays). Use it for anything about time ("last summer", "lately", "back when…", "my most played").
- Usually 15–30 songs; follow the request if it implies a number. At most 3 songs per artist unless the request is about one artist. Interleave artists and order the songs for flow.
- title: 1–4 words naming the queue. reply: one or two warm, specific sentences about what you picked and why — no generic filler.
- Write title and reply in the language of the REQUEST (a Chinese request gets a Chinese reply), even when the songs are Japanese or English.
- If nothing fits, return an empty picks list and say so honestly in reply.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'reply', 'picks'],
  properties: {
    title: { type: 'string' },
    reply: { type: 'string' },
    picks: { type: 'array', items: { type: 'integer' } },
  },
};

// → { title, reply, tracks, model, ms }. `avoid`: track ids from a previous
// answer to steer away from ("try again").
export async function ask(request, { avoid = [] } = {}) {
  const t0 = Date.now();
  const ctx = buildContext(await loadHistory());
  const now = store.get().player.track;
  const nowIdx = now ? ctx.index.get(now.id) : undefined;
  const avoidIdx = avoid.map((id) => ctx.index.get(id)).filter((i) => i !== undefined);
  const d = new Date();
  const input = [
    'CANDIDATES', ...ctx.lines, '',
    'TIMELINE', ...ctx.timeline, `last 7 days: ${ctx.lastWeek || '—'}`, '',
    `NOW PLAYING: ${now ? (nowIdx !== undefined ? `${nowIdx}|${now.name}` : `${now.name} — ${artists(now)}`) : 'nothing'}`,
    `NOW: ${d.toISOString().slice(0, 10)} ${d.toLocaleDateString('en', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    avoidIdx.length ? `ALREADY OFFERED (pick a clearly different set): ${avoidIdx.join(', ')}` : '',
    '', `REQUEST: ${request}`,
  ].filter((l) => l !== null).join('\n');

  const res = await window.muse.llm.respond({
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: input }],
    text: { format: { type: 'json_schema', name: 'queue', schema: SCHEMA, strict: true } },
  });
  const text = (res.output || []).filter((o) => o.type === 'message')
    .flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('the DJ answered in a way I couldn’t read — try again'); }
  const seen = new Set();
  const tracks = (out.picks || [])
    .map((i) => ctx.tracks[i])
    .filter((t) => t && !seen.has(t.id) && seen.add(t.id))
    .map(({ notLiked, ...t }) => t);
  return { title: (out.title || '').trim(), reply: (out.reply || '').trim(), tracks, model: res.model, ms: Date.now() - t0 };
}

// Does this query read like a request rather than a title? Decides whether
// the Ask row sits above the search results or below them.
export function looksLikeAsk(q) {
  const s = String(q || '').trim();
  const cjk = (s.match(/[぀-ヿ㐀-鿿]/g) || []).length;
  const words = s.split(/\s+/).filter(Boolean).length;
  return words >= 3 || cjk >= 6 || /[,，。？?！!]/.test(s)
    || /^(play|something|some|songs?|music|anything)\b/i.test(s)
    || /^(来点|放点|想听|给我|一些|适合|有没有|帮我)/.test(s);
}
