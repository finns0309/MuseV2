// LLM gateway for Ask — main process only, so the API key never reaches the
// renderer. Speaks the OpenAI Responses API (POST {base}/v1/responses) to
// whatever OpenAI-compatible endpoint ~/Library/Application Support/MuseV2/
// llm.json names:
//
//   { "base_url": "https://…", "model": "gpt-6-luna",
//     "fallback_models": ["gpt-5.6-luna", "gpt-6"], "api_key": "sk-…" }
//
// The file lives in userData, never in the repo. If the configured model
// isn't served ("model_not_found"), the fallbacks are tried in order and the
// first one that answers is remembered for the rest of the session.

const fs = require('fs');

const TIMEOUT_MS = 90_000;
let workingModel = null;

function readConfig(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg.base_url || !cfg.api_key || !cfg.model) return null;
    return cfg;
  } catch { return null; }
}

function endpoint(base) {
  const b = String(base).replace(/\/+$/, '');
  return /\/v1$/.test(b) ? `${b}/responses` : `${b}/v1/responses`;
}

// One retry for transport failures ("fetch failed", resets) — not for HTTP
// errors, which come back as JSON and are handled by the caller.
async function post(url, init) {
  try { return await fetch(url, init); }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw e;
    await new Promise((r) => setTimeout(r, 600));
    return fetch(url, init);
  }
}

async function call(cfg, model, body) {
  const res = await post(endpoint(cfg.base_url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ ...body, model, store: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message || `HTTP ${res.status}`);
    err.code = json.error?.type || json.error?.code || res.status;
    throw err;
  }
  return json;
}

function create(configPath) {
  return {
    available: () => !!readConfig(configPath),
    async respond(body) {
      const cfg = readConfig(configPath);
      if (!cfg) throw new Error('Ask isn’t set up — add llm.json to the MuseV2 data folder');
      const models = [...new Set([workingModel, cfg.model, ...(cfg.fallback_models || [])].filter(Boolean))];
      let lastErr;
      for (const model of models) {
        try {
          const json = await call(cfg, model, body);
          workingModel = model;
          return { model, output: json.output, usage: json.usage };
        } catch (e) {
          lastErr = e;
          if (e.code !== 'model_not_found' && !/not supported/i.test(e.message)) throw e;
        }
      }
      throw lastErr;
    },
  };
}

module.exports = { create };
