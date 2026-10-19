// The tools Muse offers an agent. One list, read by three places:
//   lib/control.js  the app's local API — routes POST /v1/tools/<name>
//   agent/cli.js    the `muse` command
//   agent/mcp.js    the MCP server (Claude Code, Claude Desktop, …)
// The app does the work (renderer/lib/remote.js); these are the contracts.
//
// Songs are NetEase song ids (integers). Muse playlists have string ids
// ('mpl_…'); a NetEase playlist is its numeric id. A track comes back as
// { id, name, artists, album, duration_s, cover }.
//
// Plain data, no dependencies — agent/ also ships unpacked inside the app
// (Contents/Resources/agent) so system node can run the CLI and the server.

const IDS = { type: 'array', items: { type: 'integer' }, description: 'NetEase song ids' };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  // ---- What's going on -------------------------------------------------------
  {
    name: 'now_playing',
    description: 'What is playing right now: the track, position, whether it is playing or paused, and why (the session — a mode, an ask, a playlist).',
    input: obj(),
  },
  {
    name: 'get_queue',
    description: 'The play queue: the current track, what comes next and what just played, with their queue positions.',
    input: obj({ limit: { type: 'integer', description: 'How many upcoming tracks (default 30)' } }),
  },
  {
    name: 'listening_history',
    description: 'The user\'s listening history. mode "recent": plays newest first. mode "top": most-played songs in the window, with counts.',
    input: obj({
      days: { type: 'integer', description: 'How far back (default 7)' },
      mode: { type: 'string', enum: ['recent', 'top'], description: 'default "recent"' },
      limit: { type: 'integer', description: 'default 50' },
    }),
  },

  // ---- Finding songs ---------------------------------------------------------
  {
    name: 'search_catalog',
    description: 'Search all of NetEase Cloud Music — songs the user has never heard included. Query by title, artist, album, or a mix ("Tatsuro Yamashita Sparkle").',
    input: obj({
      query: { type: 'string' },
      limit: { type: 'integer', description: 'default 10, max 30' },
    }, ['query']),
  },
  {
    name: 'search_library',
    description: 'Search the user\'s liked songs (their NetEase 红心 library) by title, artist or album. An empty query lists the most recently played.',
    input: obj({
      query: { type: 'string' },
      limit: { type: 'integer', description: 'default 20' },
    }),
  },
  {
    name: 'similar_songs',
    description: 'Songs NetEase considers similar to one song — good for "more like this".',
    input: obj({ track_id: { type: 'integer' }, limit: { type: 'integer', description: 'default 15' } }, ['track_id']),
  },

  // ---- Playlists -------------------------------------------------------------
  {
    name: 'list_playlists',
    description: 'Muse playlists (made by the DJ, by agents, or by hand — editable here) and the user\'s saved NetEase playlists (read-only).',
    input: obj(),
  },
  {
    name: 'get_playlist',
    description: 'A playlist\'s tracks. A Muse playlist id ("mpl_…") or a NetEase playlist id (number).',
    input: obj({ id: { type: ['string', 'integer'] } }, ['id']),
  },
  {
    name: 'create_playlist',
    description: 'Make a Muse playlist. It shows up in Muse right away (/playlists). Returns its id.',
    input: obj({
      name: { type: 'string' },
      track_ids: IDS,
      description: { type: 'string', description: 'A line about it, shown under the name' },
    }, ['name']),
  },
  {
    name: 'update_playlist',
    description: 'Edit a Muse playlist: rename it, add songs (at the end or at a position), remove songs, or set the whole order at once with track_ids. Changes appear in Muse immediately.',
    input: obj({
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      add: IDS,
      insert_at: { type: 'integer', description: 'Where `add` goes (0 = top); default the end' },
      remove: IDS,
      track_ids: { ...IDS, description: 'Replace the whole list with these, in this order' },
    }, ['id']),
  },
  {
    name: 'delete_playlist',
    description: 'Delete a Muse playlist.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },

  // ---- Playing ---------------------------------------------------------------
  {
    name: 'play',
    description: 'Play something now, replacing the queue: a playlist (Muse or NetEase), or a list of songs. Starts at start_index. With nothing given, resumes.',
    input: obj({
      playlist_id: { type: ['string', 'integer'] },
      track_ids: IDS,
      start_index: { type: 'integer' },
    }),
  },
  {
    name: 'queue_tracks',
    description: 'Put songs in the queue without interrupting: right after the current song ("next") or at the end ("end").',
    input: obj({ track_ids: IDS, position: { type: 'string', enum: ['next', 'end'] } }, ['track_ids']),
  },
  {
    name: 'playback',
    description: 'Transport: pause, resume, toggle, next, previous.',
    input: obj({ action: { type: 'string', enum: ['pause', 'resume', 'toggle', 'next', 'previous'] } }, ['action']),
  },
  {
    name: 'like',
    description: 'Like (or unlike) a song on NetEase — it joins (or leaves) the user\'s library. Changes their account; do it only when asked.',
    input: obj({ track_id: { type: 'integer' }, liked: { type: 'boolean', description: 'default true' } }, ['track_id']),
  },

  // ---- The DJ ----------------------------------------------------------------
  {
    name: 'ask_dj',
    description: 'Hand a request to Muse\'s own DJ ("something for a rainy evening, mostly Japanese"). It knows the user\'s library and history and makes a Muse playlist; the conversation is kept in Muse (/asks). follow_up continues an earlier ask ("quieter", "more like the third song"). Takes 10–60s.',
    input: obj({
      request: { type: 'string' },
      follow_up: { type: 'string', description: 'An ask id to continue' },
      wait: { type: 'boolean', description: 'Wait for the answer (default true)' },
      play: { type: 'boolean', description: 'Start playing the answer when it comes (default false)' },
    }, ['request']),
  },
  {
    name: 'list_asks',
    description: 'The user\'s conversations with Muse\'s DJ, newest first: what they asked, the title it got, its playlist.',
    input: obj({ limit: { type: 'integer', description: 'default 20' } }),
  },
  {
    name: 'get_ask',
    description: 'One DJ conversation in full: every request, every reply, and its playlist.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// Tools that only look — an MCP client may run these without asking.
const READ_ONLY = new Set([
  'now_playing', 'get_queue', 'listening_history', 'search_catalog', 'search_library',
  'similar_songs', 'list_playlists', 'get_playlist', 'list_asks', 'get_ask',
]);

module.exports = { TOOLS, byName, READ_ONLY };
