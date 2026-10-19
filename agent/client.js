// How the CLI and the MCP server reach a running Muse. control.json in
// Muse's data folder (written by lib/control.js on launch) says where:
// { port, token }. MUSEV2_PROFILE=dev reaches the dev profile instead;
// MUSEV2_CONTROL points at another control.json outright.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

class NotRunning extends Error {
  constructor() { super('MuseV2 isn’t running — open it, then try again'); this.code = 'NOT_RUNNING'; }
}

function controlFile() {
  if (process.env.MUSEV2_CONTROL) return process.env.MUSEV2_CONTROL;
  const dir = process.env.MUSEV2_PROFILE === 'dev' ? 'MuseV2-dev' : 'MuseV2';
  return path.join(os.homedir(), 'Library', 'Application Support', dir, 'control.json');
}

function readControl() {
  try { return JSON.parse(fs.readFileSync(controlFile(), 'utf8')); } catch { return null; }
}

// One request to the control API. Resolves with `result`, rejects with the
// API's own error message. `agent` signs what it changes in Muse.
function request(method, pathname, body, { agent = 'muse CLI', timeoutMs = 250_000 } = {}) {
  const c = readControl();
  if (!c?.port || !c?.token) return Promise.reject(new NotRunning());
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: c.port, path: pathname, method, timeout: timeoutMs,
      headers: {
        authorization: `Bearer ${c.token}`,
        'x-muse-agent': agent,
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(raw); } catch { reject(new Error(`Muse answered oddly (HTTP ${res.statusCode})`)); return; }
        if (j.ok) resolve(j.result); else reject(new Error(j.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new NotRunning() : e));
    req.on('timeout', () => req.destroy(new Error('Muse took too long to answer')));
    if (data) req.write(data);
    req.end();
  });
}

const call = (name, args = {}, opts) => request('POST', `/v1/tools/${name}`, args, opts);

module.exports = { call, request, controlFile, NotRunning };
