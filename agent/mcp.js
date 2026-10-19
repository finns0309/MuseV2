#!/usr/bin/env node
// Muse as an MCP server (stdio) — so Claude Code, Claude Desktop or any MCP
// client can see what's playing, search, make and edit Muse playlists, play
// them, and hand requests to Muse's own DJ.
//
//   claude mcp add muse -- node "/Applications/MuseV2.app/Contents/Resources/agent/mcp.js"
//
// The tools are agent/specs.js; each call goes to the running app through
// its control API (agent/client.js), signed with the client's name so Muse
// can say who made or edited a playlist. No dependencies: JSON-RPC 2.0, one
// message per line, the slice of MCP a tools-only server needs.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TOOLS, byName, READ_ONLY } = require('./specs');
const { call } = require('./client');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'Muse is the user’s music player (NetEase Cloud Music), running on their Mac.',
  'Songs are NetEase song ids: find them with search_catalog (everything) or search_library (their liked songs), or from listening_history.',
  'Muse playlists (ids "mpl_…") are yours to make and edit with create_playlist / update_playlist; they appear in Muse at once, signed with your name. play starts one.',
  'ask_dj hands a request to Muse’s own DJ, which knows the user’s whole listening history; follow_up continues one of its conversations.',
  'Changing what plays, or liking songs, changes the user’s day — do it when they ask.',
].join(' ');

let agent = 'an MCP client';

// The app's version: package.json in the repo; inside the app bundle
// (Contents/Resources/agent) plain node can't read the asar, so Info.plist.
function version() {
  try { return require('../package.json').version; } catch {}
  try {
    const plist = fs.readFileSync(path.join(__dirname, '..', '..', 'Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(plist)?.[1] || '0';
  } catch { return '0'; }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      if (params.clientInfo?.name) agent = String(params.clientInfo.name).slice(0, 40);
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'muse', title: 'MuseV2', version: version() },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input,
          annotations: {
            readOnlyHint: READ_ONLY.has(t.name),
            destructiveHint: t.name === 'delete_playlist',
            openWorldHint: ['search_catalog', 'similar_songs', 'like'].includes(t.name),
          },
        })),
      });
    case 'tools/call': {
      const spec = byName[params.name];
      if (!spec) return fail(id, -32602, `no tool named ${params.name}`);
      try {
        const result = await call(spec.name, params.arguments || {}, { agent });
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (method?.startsWith('notifications/') || !isRequest) return undefined;
      return fail(id, -32601, `method not found: ${method}`);
  }
}

const inFlight = new Set();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    const p = handle(m).catch((e) => { if (m.id !== undefined) fail(m.id, -32603, e.message); });
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  }
});
// The client hung up: answer what's already in flight, then go.
rl.on('close', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
