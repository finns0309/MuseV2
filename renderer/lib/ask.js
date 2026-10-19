// Ask — "What would you like to hear?" answered from your own listening,
// and from anywhere on NetEase when that's what it takes.
//
// The model gets the request plus a compact index of every candidate — the
// liked library and songs you've played lately that aren't liked — a
// listening timeline (your most-played candidates per month), what's
// playing, and, in a conversation, what was said before and the playlist as
// it stands. It answers with a title, a sentence or two, indexes into the
// candidates, and three follow-ups you might say next.
//
// It also has two tools — search_catalog (NetEase, songs you've never heard)
// and similar_songs — for when the request reaches past your listening. Each
// round trip costs ~10s on this endpoint, so they're for discovery, not
// habit: at most two rounds, and the request runs in the background anyway
// (lib/dj.js). What it's doing is reported through onProgress, so the
// thinking line says "Searching NetEase for “Sparkle”…" when it is.

import { store } from '../store.js';
import { loadHistory } from './memory.js';
import { api } from '../api.js';
import { fetchSimilar } from './similar.js';

const EXTRA_RECENT = 300;   // non-library songs from history offered as candidates
const TIMELINE_MONTHS = 6;
const TIMELINE_TOP = 15;
const MAX_TOOL_ROUNDS = 2;
const SEARCH_PER_QUERY = 8;

const artists = (t) => (t.ar || []).map((a) => a.name).join('/');
const yymm = (ms) => { const d = new Date(ms); return `${String(d.getFullYear()).slice(2)}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ym = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export async function available() {
  try { return !!(await window.muse.llm?.available()); } catch { return false; }
}

// The candidate table, the timeline, and the lookup back to tracks. In a
// conversation the playlist as it stands comes first, so its songs keep
// small, stable indices (0…n-1) the model can keep, drop or reorder.
function buildContext(hist, current = []) {
  const libById = new Map(store.get().library.tracks.map((t) => [t.id, t]));
  const plays = new Map();
  for (const h of hist) plays.set(h.songId, (plays.get(h.songId) || 0) + 1);

  const tracks = [];
  const index = new Map();
  const add = (t, extra = {}) => {
    if (!t?.id || index.has(t.id)) return index.get(t?.id);
    index.set(t.id, tracks.length);
    tracks.push({ ...t, ...extra });
    return tracks.length - 1;
  };
  for (const t of current) add(libById.get(t.id) || t, libById.has(t.id) ? {} : { notLiked: true });
  for (const t of store.get().library.tracks) if (!t.unavailable) add(t);
  for (let i = hist.length - 1, n = 0; i >= 0 && n < EXTRA_RECENT; i--) {
    const h = hist[i];
    if (!h?.songId || index.has(h.songId)) continue;
    add({
      id: h.songId, name: h.name,
      ar: String(h.artist || '').split(/\s*[,/]\s*/).filter(Boolean).map((name) => ({ name })),
      al: { name: h.album, picUrl: h.picUrl }, dt: h.durationMs || 0,
    }, { notLiked: true });
    n++;
  }

  const line = (t, i) =>
    `${i}|${t.name}|${artists(t)}|${t.playCount || plays.get(t.id) || 0}|${t.found ? 'new' : t.notLiked ? '-' : t.addedAt ? yymm(t.addedAt) : '?'}`;
  const lines = tracks.map(line);

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

  return { tracks, index, add, line, lines, timeline, lastWeek, plays };
}

const INSTRUCTIONS = `You are the DJ inside Muse, a music player. The user says what they want to hear; you build the queue.
CANDIDATES: index|title|artists|plays|liked — liked is yy-mm when they liked it, "-" heard but not liked, "new" found by your tools and never played.
- Use what you know about these songs and artists: mood, tempo, language, vocals, instrumentation, era.
- TIMELINE lists their most-played candidates per month and for the last 7 days (index×plays). Use it for anything about time ("last summer", "lately", "back when…", "my most played").
- Tools reach past their listening. search_catalog searches all of NetEase; similar_songs finds songs like one candidate. Use them when the request wants something new to them ("haven't heard", "discover", "new", "推荐点新的"), names artists, songs or scenes the candidates don't cover, or the candidates can't fill it well — not out of habit. Queries are short NetEase search keywords: an artist, a song title, "artist title" — never sentences. Batch 3–8 queries in one call. Results join CANDIDATES with new indices. One or two rounds at most, then answer.
- When the request is about discovery, most picks should be "new"; otherwise lean on their own listening, with a few new ones only where they really fit.
- Usually 15–30 songs; follow the request if it implies a number. At most 3 songs per artist unless the request is about one artist. Interleave artists and order the songs for flow.
- In a conversation, CONVERSATION shows what was asked and what you answered, and CURRENT is the playlist as it stands. A follow-up edits it: keep what still fits, drop what doesn't, add what's asked for, and return the whole new list in order. Keep the title unless the change makes it wrong.
- title: 1–4 words naming the queue. reply: one or two warm, specific sentences about what you picked and why — on a follow-up, what changed. No generic filler.
- suggestions: three short things they might say next (2–6 words each), concrete to this playlist — "quieter", "more like <a song in it>", "only Japanese", "longer". Never repeat the request.
- Language: write title, reply and suggestions in the language of the REQUEST line itself — the latest message, not earlier turns or the songs. A Chinese request gets Chinese, an English one English, even when the songs are Japanese.
- If nothing fits, return empty picks and say so honestly in reply.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'reply', 'picks', 'suggestions'],
  properties: {
    title: { type: 'string' },
    reply: { type: 'string' },
    picks: { type: 'array', items: { type: 'integer' } },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
};

const TOOLS = [
  {
    type: 'function', name: 'search_catalog', strict: true,
    description: 'Search all of NetEase Cloud Music. Each query is a short keyword search (artist / song title / "artist title"); up to 8 songs per query join CANDIDATES.',
    parameters: { type: 'object', additionalProperties: false, required: ['queries'], properties: { queries: { type: 'array', items: { type: 'string' } } } },
  },
  {
    type: 'function', name: 'similar_songs', strict: true,
    description: 'Songs NetEase considers similar to the candidate at `index`; they join CANDIDATES.',
    parameters: { type: 'object', additionalProperties: false, required: ['index'], properties: { index: { type: 'integer' } } },
  },
];

const quote = (s) => `“${String(s).slice(0, 24)}”`;

async function runTool(call, ctx, onProgress) {
  let args = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch {}
  const added = (songs) => songs.map((s) => {
    const i = ctx.add({ id: s.id, name: s.name, ar: s.ar, al: s.al, dt: s.dt }, { notLiked: true, found: true });
    return ctx.line(ctx.tracks[i], i);
  });
  let text;
  try {
    if (call.name === 'search_catalog') {
      const queries = (args.queries || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 8);
      onProgress(`Searching NetEase for ${queries.slice(0, 2).map(quote).join(', ')}${queries.length > 2 ? '…' : ''}`);
      const results = await Promise.all(queries.map((q) =>
        api('/cloudsearch', { keywords: q, type: 1, limit: SEARCH_PER_QUERY }).then((r) => r?.result?.songs || []).catch(() => [])));
      text = queries.map((q, k) => `# ${q}\n${added(results[k]).join('\n') || '(nothing)'}`).join('\n');
    } else if (call.name === 'similar_songs') {
      const seed = ctx.tracks[args.index];
      if (!seed) text = `no candidate ${args.index}`;
      else {
        onProgress(`Finding songs like ${quote(seed.name)}…`);
        const songs = await fetchSimilar(seed.id, { limit: 12 }).catch(() => []);
        text = added(songs.map((t) => ({ ...t, ar: t.ar, al: t.al, dt: t.dt }))).join('\n') || '(nothing)';
      }
    } else text = `no tool ${call.name}`;
  } catch (e) { text = `failed: ${e?.message || e}`; }
  return { type: 'function_call_output', call_id: call.call_id, output: text };
}

// → { title, reply, tracks, suggestions, found, model, ms }.
//   history  earlier turns of this conversation: [{ q, title, reply }]
//   current  the conversation's playlist as it stands (a follow-up edits it)
//   avoid    track ids to steer away from ("try again")
//   onProgress(text) — what it's doing, for the thinking line
export async function ask(request, { history = [], current = [], avoid = [], onProgress = () => {} } = {}) {
  const t0 = Date.now();
  onProgress('Reading your library…');
  const ctx = buildContext(await loadHistory(), current);
  const now = store.get().player.track;
  const nowIdx = now ? ctx.index.get(now.id) : undefined;
  const avoidIdx = avoid.map((id) => ctx.index.get(id)).filter((i) => i !== undefined);
  const d = new Date();
  const convo = history.length
    ? ['CONVERSATION', ...history.flatMap((h) => [`USER: ${h.q}`, `DJ: ${h.title ? `${h.title} — ` : ''}${h.reply || h.error || ''}`]), '']
    : [];
  const cur = current.length ? ['CURRENT (the playlist as it stands, in order):', current.map((t) => ctx.index.get(t.id)).join(', '), ''] : [];
  const input = [
    'CANDIDATES', ...ctx.lines, '',
    'TIMELINE', ...ctx.timeline, `last 7 days: ${ctx.lastWeek || '—'}`, '',
    `NOW PLAYING: ${now ? (nowIdx !== undefined ? `${nowIdx}|${now.name}` : `${now.name} — ${artists(now)}`) : 'nothing'}`,
    `NOW: ${d.toISOString().slice(0, 10)} ${d.toLocaleDateString('en', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    avoidIdx.length ? `ALREADY OFFERED (pick a clearly different set): ${avoidIdx.join(', ')}` : '',
    '', ...convo, ...cur,
    `REQUEST: ${request}`,
  ].join('\n');

  const turns = [{ role: 'user', content: input }];
  const format = { format: { type: 'json_schema', name: 'queue', schema: SCHEMA, strict: true } };
  let res;
  for (let round = 0; ; round++) {
    const last = round >= MAX_TOOL_ROUNDS;
    if (round > 0) onProgress(last ? 'Putting them in order…' : 'Listening through what it found…');
    else onProgress('Picking songs…');
    res = await window.muse.llm.respond({
      instructions: INSTRUCTIONS, input: turns, tools: TOOLS, tool_choice: last ? 'none' : 'auto', text: format,
    });
    const calls = (res.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length || last) break;
    // Hand back the calls (without their item ids — nothing is stored
    // server-side) and what they found.
    const outputs = await Promise.all(calls.map((c) => runTool(c, ctx, onProgress)));
    turns.push(...calls.map(({ type, call_id, name, arguments: a }) => ({ type, call_id, name, arguments: a })), ...outputs);
  }

  const text = (res.output || []).filter((o) => o.type === 'message')
    .flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('the DJ answered in a way I couldn’t read — try again'); }
  const seen = new Set();
  const picked = (out.picks || [])
    .map((i) => ctx.tracks[i])
    .filter((t) => t && !seen.has(t.id) && seen.add(t.id));
  return {
    title: (out.title || '').trim(),
    reply: (out.reply || '').trim(),
    tracks: picked.map(({ notLiked, found, ...t }) => t),
    found: picked.filter((t) => t.found).length,
    suggestions: (out.suggestions || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3),
    model: res.model, ms: Date.now() - t0,
  };
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
