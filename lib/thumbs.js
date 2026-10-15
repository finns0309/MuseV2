// Cover thumbnails, cached on disk. NetEase's CDN answers a burst of small
// image requests with 429s — a list of 20 songs used to come back with a few
// blank tiles. The renderer asks for muse-thumb://img/<px>/<base64url(url)>;
// this serves it from userData/thumbs, or fetches it once (at most 4 in
// flight, backing off on 429) and keeps it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');

const SCHEME = 'muse-thumb';
const MAX_IN_FLIGHT = 4;
const RETRIES = [400, 1200, 2500];   // ms before each retry on 429 / transport errors

let dir = null;
let inFlight = 0;
const waiting = [];
const pending = new Map();          // cache file → in-flight promise (dedupe)

const slot = () => new Promise((resolve) => {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; resolve(); } else waiting.push(resolve);
});
const release = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, px) {
  const src = url.replace(/^http:/, 'https:') + (url.includes('?') ? '&' : '?') + `param=${px}y${px}`;
  await slot();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await net.fetch(src);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        if (attempt >= RETRIES.length) throw e;
      }
      if (attempt >= RETRIES.length) throw new Error('gave up');
      await sleep(RETRIES[attempt]);
    }
  } finally { release(); }
}

async function load(url, px) {
  const file = path.join(dir, crypto.createHash('sha1').update(`${px}|${url}`).digest('hex') + '.jpg');
  try { return await fs.promises.readFile(file); } catch {}
  if (pending.has(file)) return pending.get(file);
  const p = download(url, px)
    .then(async (buf) => { await fs.promises.writeFile(file, buf).catch(() => {}); return buf; })
    .finally(() => pending.delete(file));
  pending.set(file, p);
  return p;
}

// Call before app 'ready'.
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

// Call after 'ready'.
function serve(protocol, userData) {
  dir = path.join(userData, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  protocol.handle(SCHEME, async (req) => {
    const m = new URL(req.url).pathname.match(/^\/(\d+)\/([A-Za-z0-9_-]+)$/);
    if (!m) return new Response('bad thumb url', { status: 400 });
    const px = Math.min(1024, Math.max(16, Number(m[1])));
    const url = Buffer.from(m[2], 'base64url').toString('utf8');
    if (!/^https?:\/\/[a-z0-9.-]+\.126\.net\//i.test(url)) return new Response('not a NetEase image', { status: 403 });
    try {
      const buf = await load(url, px);
      return new Response(buf, { headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*', 'cache-control': 'max-age=31536000' } });
    } catch {
      return new Response('unavailable', { status: 502 });
    }
  });
}

module.exports = { SCHEME, registerScheme, serve };
