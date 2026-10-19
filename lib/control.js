// Muse's door for agents: a small HTTP API on 127.0.0.1 that the `muse` CLI
// and the MCP server (agent/) talk to.
//
//   GET  /v1                   → { app, version, tools }
//   POST /v1/tools/<name>      → { ok: true, result } | { ok: false, error }
//
// Guarded three ways: it listens on loopback only; every request needs the
// bearer token from control.json (userData, 0600 — readable by you and the
// tools you run, not by a web page); and anything a browser sent (an Origin
// header) or addressed to a foreign Host (DNS rebinding) is refused.
//
// The work happens in the window (renderer/lib/remote.js), where the player,
// the library and the DJ live: each call is forwarded over IPC and its reply
// awaited. control.json also says where to knock: { port, token, pid }.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { byName, TOOLS } = require('../agent/specs');

const MAX_BODY = 1 << 20;

function create({ userData, ports, version, call, onActivity = () => {} }) {
  const file = path.join(userData, 'control.json');
  let token = null;
  try { token = JSON.parse(fs.readFileSync(file, 'utf8')).token || null; } catch {}
  if (!/^[0-9a-f]{64}$/.test(token || '')) token = crypto.randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token);
  let server = null;
  let port = 0;

  const authorized = (req) => {
    const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
    if (!m) return false;
    const got = Buffer.from(m[1].toLowerCase());
    return got.length === tokenBuf.length && crypto.timingSafeEqual(got, tokenBuf);
  };
  const hostOk = (req) => {
    const h = String(req.headers.host || '');
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    if (req.headers.origin || !hostOk(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'missing or wrong token (see control.json)' });

    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1') {
      return send(res, 200, { ok: true, result: { app: 'MuseV2', version, tools: TOOLS } });
    }
    const m = /^\/v1\/tools\/([a-z_]+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return send(res, 404, { ok: false, error: 'not found' });
    const spec = byName[m[1]];
    if (!spec) return send(res, 404, { ok: false, error: `no tool named ${m[1]}` });

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(res, 413, { ok: false, error: 'too large' });
    }
    let args;
    try { args = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { ok: false, error: 'body is not JSON' }); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return send(res, 400, { ok: false, error: 'arguments must be an object' });
    const missing = (spec.input.required || []).filter((k) => args[k] === undefined);
    if (missing.length) return send(res, 400, { ok: false, error: `missing: ${missing.join(', ')}` });

    // Who's asking — the CLI says "muse CLI", the MCP server passes on its
    // client's name ("claude-code"). Shown in Muse beside what they changed.
    const agent = String(req.headers['x-muse-agent'] || 'an agent').slice(0, 40);
    try {
      const result = await call(spec.name, args, { agent });
      onActivity({ tool: spec.name, agent, at: Date.now() });
      send(res, 200, { ok: true, result: result ?? null });
    } catch (e) {
      send(res, 200, { ok: false, error: e?.message || String(e) });
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const tryPort = (i) => {
        const p = ports[i] ?? 0;               // past the preferred ones: any free port
        const s = http.createServer((req, res) => {
          handle(req, res).catch((e) => { try { send(res, 500, { ok: false, error: e.message }); } catch {} });
        });
        s.once('error', (e) => {
          if (e.code === 'EADDRINUSE' && i < ports.length) tryPort(i + 1);
          else reject(e);
        });
        s.listen(p, '127.0.0.1', () => {
          server = s;
          port = s.address().port;
          fs.writeFileSync(file, JSON.stringify({ port, token, pid: process.pid, version }, null, 2), { mode: 0o600 });
          try { fs.chmodSync(file, 0o600); } catch {}
          console.log(`[muse] control API on http://127.0.0.1:${port}/v1`);
          resolve(port);
        });
      };
      tryPort(0);
    });
  }

  return {
    listen,
    close: () => { try { server?.close(); } catch {} },
    port: () => port,
    file,
  };
}

module.exports = { create };
