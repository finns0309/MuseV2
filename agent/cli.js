#!/usr/bin/env node
// muse — MuseV2 from the terminal (and from any agent that can run one).
// Talks to the running app through its control API (agent/client.js);
// every command is one of the tools in agent/specs.js.
//
//   muse                         what's playing
//   muse queue [n]               the queue
//   muse play [mpl_… | song id …]   a Muse playlist or songs; nothing resumes
//   muse play --playlist <id>    a NetEase playlist
//   muse pause | resume | next | prev
//   muse add <song id …> [--next]   queue songs at the end (or next)
//   muse search <words>          all of NetEase
//   muse lib [words]             your liked songs
//   muse similar <song id>
//   muse history [days] [--top]
//   muse like <song id> | unlike <song id>
//   muse pl                      playlists
//   muse pl show <id>
//   muse pl new <name> [song id …]
//   muse pl add <id> <song id …> [--at n]
//   muse pl rm <id> <song id …>
//   muse pl order <id> <song id …>
//   muse pl rename <id> <name>
//   muse pl delete <id>
//   muse ask <request> [--play] [--no-wait] [--in <ask id>]
//   muse asks [n] | muse asks show <id>
//   muse tools | muse call <tool> '<json>'
//
// --json prints the raw result. MUSEV2_PROFILE=dev talks to the dev profile.

const { call, request } = require('./client');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--at', '--in'].includes(argv[i - 1])));
const JSON_OUT = flags.has('--json');

const tty = process.stdout.isTTY && !JSON_OUT;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const accent = (s) => (tty ? `\x1b[38;5;173m${s}\x1b[39m` : s);
const time = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '');
const ids = (xs) => xs.map(Number).filter(Number.isInteger);
const songs = (n) => `${n} ${n === 1 ? 'song' : 'songs'}`;
const plId = (x) => (/^\d+$/.test(String(x)) ? Number(x) : x);

function songLine(t, n) {
  const head = n === undefined ? '' : `${dim(String(n).padStart(3))}  `;
  return `${head}${t.name}${dim(' — ')}${t.artists}  ${dim(time(t.duration_s))}  ${dim(`[${t.id}]`)}${t.plays ? dim(`  ×${t.plays}`) : ''}`;
}

function showNow(r) {
  if (!r?.track) return 'Nothing playing.';
  const t = r.track;
  return [
    `${r.playing ? accent('▶') : dim('❙❙')} ${t.name}${dim(' — ')}${t.artists}${t.liked ? accent(' ♥') : ''}`,
    dim(`  ${time(r.position_s)} / ${time(r.duration_s)} · ${r.queue_position + 1} of ${r.queue_length}${r.session?.label ? ` · ${r.session.label}` : ''}`),
  ].join('\n');
}

function showSongs(list, empty = 'Nothing.') {
  return list?.length ? list.map((t, i) => songLine(t, i + 1)).join('\n') : empty;
}

function showPlaylist(p) {
  return [
    `${accent('♪')} ${p.name}${p.read_only ? dim('  (NetEase, read-only)') : ''}  ${dim(String(p.id))}`,
    p.description ? dim(`  ${p.description}`) : '',
    p.made_by ? dim(`  by ${p.made_by}${p.edited_by && p.edited_by !== p.made_by ? `, edited by ${p.edited_by}` : ''}`) : '',
    showSongs(p.tracks, '  (empty)'),
  ].filter(Boolean).join('\n');
}

function showAsk(a) {
  const head = `${accent('✻')} ${a.title || '(untitled)'}  ${dim(a.ask_id)}`;
  const turns = (a.turns || []).map((t) => `  ${dim('you')}  ${t.request}\n  ${dim('dj ')}  ${t.reply}`).join('\n');
  return [head, turns || (a.reply ? `  ${a.reply}` : ''), a.playlist_id ? dim(`  playlist ${a.playlist_id}`) : '', showSongs(a.tracks, '')]
    .filter(Boolean).join('\n');
}

const COMMANDS = {
  async now() { return [await call('now_playing'), showNow]; },
  async queue([n]) {
    const r = await call('get_queue', { limit: Number(n) || 20 });
    return [r, () => [
      r.current ? `${accent('▶')} ${songLine(r.current)}` : 'Nothing queued.',
      ...r.up_next.map((t) => songLine(t, t.position + 1)),
      r.more_after ? dim(`    … ${r.more_after} more`) : '',
    ].filter(Boolean).join('\n')];
  },
  async play(args) {
    const a = !args.length ? {}
      : /^mpl_/.test(args[0]) || flags.has('--playlist') ? { playlist_id: plId(args[0]) }
      : { track_ids: ids(args) };
    return [await call('play', a), showNow];
  },
  async pause() { return [await call('playback', { action: 'pause' }), showNow]; },
  async resume() { return [await call('playback', { action: 'resume' }), showNow]; },
  async toggle() { return [await call('playback', { action: 'toggle' }), showNow]; },
  async next() { return [await call('playback', { action: 'next' }), showNow]; },
  async prev() { return [await call('playback', { action: 'previous' }), showNow]; },
  async add(args) {
    const r = await call('queue_tracks', { track_ids: ids(args), position: flags.has('--next') ? 'next' : 'end' });
    return [r, () => `Queued ${r.queued} ${r.position === 'next' ? 'to play next' : 'at the end'}.`];
  },
  async search(args) { const r = await call('search_catalog', { query: args.join(' '), limit: 15 }); return [r, () => showSongs(r.songs)]; },
  async lib(args) { const r = await call('search_library', { query: args.join(' '), limit: 30 }); return [r, () => showSongs(r.songs)]; },
  async similar([id]) { const r = await call('similar_songs', { track_id: Number(id) }); return [r, () => showSongs(r.songs)]; },
  async history([days]) {
    const top = flags.has('--top');
    const r = await call('listening_history', { days: Number(days) || 7, mode: top ? 'top' : 'recent', limit: 40 });
    return [r, () => showSongs(top ? r.songs : r.plays)];
  },
  async like([id]) { const r = await call('like', { track_id: Number(id), liked: true }); return [r, () => (r.liked ? 'Liked.' : 'Not liked.')]; },
  async unlike([id]) { const r = await call('like', { track_id: Number(id), liked: false }); return [r, () => (r.liked ? 'Still liked.' : 'Unliked.')]; },

  async pl([sub, id, ...rest]) {
    if (!sub) {
      const r = await call('list_playlists');
      return [r, () => [
        r.muse.length ? 'Muse' : '',
        ...r.muse.map((p) => `  ${accent('♪')} ${p.name}  ${dim(`${songs(p.tracks)} · by ${p.made_by} · ${p.id}`)}`),
        r.netease.length ? 'NetEase' : '',
        ...r.netease.map((p) => `  ${p.name}  ${dim(`${songs(p.tracks)} · ${p.id}`)}`),
      ].filter(Boolean).join('\n') || 'No playlists.'];
    }
    if (sub === 'show') { const r = await call('get_playlist', { id: plId(id) }); return [r, showPlaylist]; }
    if (sub === 'new') {
      const name = [id, ...rest.filter((x) => !/^\d{5,}$/.test(x))].join(' ');
      const r = await call('create_playlist', { name, track_ids: ids(rest.filter((x) => /^\d{5,}$/.test(x))) });
      return [r, () => `Made “${r.name}” (${songs(r.tracks)}) — ${r.id}`];
    }
    const edit = async (args) => {
      const r = await call('update_playlist', { id, ...args });
      return [r, () => `“${r.name}” now has ${songs(r.tracks)}.${r.missing?.length ? ` Not found: ${r.missing.join(', ')}` : ''}`];
    };
    if (sub === 'add') return edit({ add: ids(rest), ...(opt('at') ? { insert_at: Number(opt('at')) } : {}) });
    if (sub === 'rm') return edit({ remove: ids(rest) });
    if (sub === 'order') return edit({ track_ids: ids(rest) });
    if (sub === 'rename') return edit({ name: rest.join(' ') });
    if (sub === 'delete') { const r = await call('delete_playlist', { id }); return [r, () => 'Deleted.']; }
    throw new Error(`muse pl ${sub}? — show, new, add, rm, order, rename, delete`);
  },

  async ask(args) {
    const r = await call('ask_dj', {
      request: args.join(' '),
      wait: !flags.has('--no-wait'),
      play: flags.has('--play'),
      ...(opt('in') ? { follow_up: opt('in') } : {}),
    });
    return [r, () => (r.status === 'thinking' ? `The DJ is on it — ${r.ask_id}` : showAsk(r))];
  },
  async asks([sub, id]) {
    if (sub === 'show') { const r = await call('get_ask', { id }); return [r, showAsk]; }
    const r = await call('list_asks', { limit: Number(sub) || 15 });
    return [r, () => r.asks.map((a) => `  ${accent('✻')} ${a.title || a.requests[0]}  ${dim(`“${a.requests.at(-1)}” · ${songs(a.tracks)} · ${a.id}`)}`).join('\n') || 'Nothing asked yet.'];
  },

  async tools() {
    const r = await request('GET', '/v1');
    return [r, () => r.tools.map((t) => `${t.name.padEnd(18)} ${dim(t.description)}`).join('\n')];
  },
  async call([tool, json]) { const r = await call(tool, json ? JSON.parse(json) : {}); return [r, () => JSON.stringify(r, null, 2)]; },
  help() { return [null, () => require('fs').readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//   muse') || l.startsWith('// --json')).map((l) => l.slice(3)).join('\n')]; },
};

(async () => {
  const [cmd = 'now', ...rest] = words;
  const fn = COMMANDS[cmd] || (['-h', 'help'].includes(cmd) ? COMMANDS.help : null);
  if (!fn) { console.error(`muse: no command “${cmd}” — try muse help`); process.exit(2); }
  try {
    const [result, show] = await fn(rest);
    console.log(JSON_OUT ? JSON.stringify(result, null, 2) : show(result));
  } catch (e) {
    console.error(`muse: ${e.message}`);
    process.exit(e.code === 'NOT_RUNNING' ? 3 : 1);
  }
})();
