// Thin wrapper around the local NCM API server. All requests carry the saved
// cookie + a stable realIP so VIP-region checks pass + a timestamp to bypass
// NCM's internal cache.

const NCM = window.muse.ncmBase;
const DEFAULT_TIMEOUT_MS = 15_000;

let cookie = '';
export function setCookie(c) { cookie = c || ''; }
export function getCookie() { return cookie; }

// Subscribers notified when NCM signals an auth failure (cookie expired etc.)
// auth.js attaches the re-login flow here so any caller can drop in.
const authFailHandlers = new Set();
export function onAuthFail(fn) { authFailHandlers.add(fn); return () => authFailHandlers.delete(fn); }

export class ApiError extends Error {
  constructor(message, { code, status, path }) { super(message); this.code = code; this.status = status; this.path = path; }
}

// HTTP statuses we retry on — network glitches, overloaded NCM edge, gateway
// hiccups. Excludes 4xx client errors (bad request, not found, auth) because
// those won't get better with a second try.
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 300 };

// Public entry. Thin retry orchestration around `apiOnce`. Callers can pass
// `retry: false` (one shot) or `retry: { attempts, baseDelayMs }` to override.
// All NCM reads are idempotent so retry-by-default is safe — mutations
// (/like, /scrobble) are also safe to retry because NCM dedupes server-side.
export async function api(path, params = {}, opts = {}) {
  const cfg = opts.retry === false
    ? { attempts: 0, baseDelayMs: 0 }
    : { ...DEFAULT_RETRY, ...(typeof opts.retry === 'object' ? opts.retry : {}) };

  let lastErr;
  for (let attempt = 0; attempt <= cfg.attempts; attempt++) {
    try {
      return await apiOnce(path, params, opts);
    } catch (e) {
      lastErr = e;
      // Stop immediately on non-transient conditions. Retrying an auth failure
      // would mask the re-login flow; retrying a 4xx won't change the answer;
      // a user-cancelled AbortSignal must be honored right away.
      if (opts.signal?.aborted) throw e;
      if (e.code === 301 || e.code === 401) throw e;
      if (e.code && e.code >= 400) throw e;
      if (e.status && !TRANSIENT_STATUSES.has(e.status)) throw e;
      if (attempt >= cfg.attempts) throw e;
      // Exponential backoff with ±30% jitter so parallel retries don't
      // stampede NCM when it's already struggling.
      const base = cfg.baseDelayMs * Math.pow(3, attempt);
      const delay = Math.round(base * (0.7 + Math.random() * 0.6));
      console.warn(`[api] ${path} attempt ${attempt + 1}/${cfg.attempts + 1} failed: ${e.message} — retrying in ${delay}ms`);
      try { await sleep(delay, opts.signal); }
      catch { throw e; } // abort during backoff — surface the original error
    }
  }
  throw lastErr;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(signal.reason); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    }
  });
}

async function apiOnce(path, params, { timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const u = new URL(NCM + path);
  if (cookie) u.searchParams.set('cookie', cookie);
  u.searchParams.set('realIP', '116.25.146.177');
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, v);
  }
  u.searchParams.set('timestamp', Date.now());

  // Compose caller-supplied AbortSignal (if any) with our timeout.
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(new Error(`NCM ${path} timed out after ${timeout}ms`)), timeout);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });

  let r;
  try { r = await fetch(u, { signal: ctrl.signal }); }
  catch (e) {
    clearTimeout(tid);
    if (e.name === 'AbortError') throw new ApiError(e.message || 'aborted', { path });
    throw new ApiError(`NCM ${path} fetch failed: ${e.message}`, { path });
  } finally { clearTimeout(tid); }

  if (!r.ok) throw new ApiError(`NCM ${path} → HTTP ${r.status}`, { status: r.status, path });

  const j = await r.json().catch(() => null);
  if (j == null) throw new ApiError(`NCM ${path} → invalid JSON`, { path });

  // NCM piggybacks status in `code`. 200 = ok, 301 / 401 = need re-auth,
  // others (400/500/...) are real errors. Some endpoints nest code under
  // .data, but the top-level field is the canonical signal.
  // Exception: the QR-login endpoints repurpose 8xx as flow states
  // (800 expired, 801 waiting, 802 scanned, 803 confirmed) — pass those
  // through so auth.js can interpret them.
  const code = typeof j.code === 'number' ? j.code : 200;
  const isQrFlow = path.startsWith('/login/qr/');
  if (code === 301 || code === 401) {
    for (const fn of authFailHandlers) { try { fn(); } catch {} }
    throw new ApiError(`NCM ${path} → not logged in (code ${code})`, { code, path });
  }
  if (!isQrFlow && code >= 400) throw new ApiError(`NCM ${path} → code ${code}: ${j.message || ''}`, { code, path });

  return j;
}

// Common batched fetch — /song/detail caps at ~1000 ids per call but smaller
// chunks behave better and stream progress via the optional onProgress.
export async function fetchSongDetails(ids, onProgress, opts) {
  return (await fetchSongDetailsFull(ids, onProgress, opts)).songs;
}

// Same call, but also returns the parallel `privileges` array. `privileges[i].st`
// is NetEase's availability flag: < 0 means the track has been pulled (no
// license in this region, delisted, ...) and /song/url/v1 will answer with
// url=null for it — worth knowing before we try to play it.
export async function fetchSongDetailsFull(ids, onProgress, opts) {
  const songs = [];
  const privileges = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const d = await api('/song/detail', { ids: chunk.join(',') }, opts);
    songs.push(...(d.songs || []));
    privileges.push(...(d.privileges || []));
    onProgress?.(Math.min(i + 200, ids.length), ids.length);
  }
  return { songs, privileges };
}
