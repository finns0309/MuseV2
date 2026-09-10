// Cover accent — 24×24 canvas, pick the most saturated mid-bright pixel as the
// vivid seed, average as the ambient tint. Cached per URL.
//
// The raw seed is NOT used as-is: it's converted to OKLCH and its lightness is
// clamped to a per-scheme band so the accent is always legible as text and
// as a 2.5px progress line (a dark cover used to yield near-black, a neon one
// an eye-searing tint). Chroma gets a floor so grey covers still tint a little.
//
// Precedence for what actually lands in --muse-accent:
//   user override (/accent #rrggbb)  >  clamped cover accent  >  scheme default
// The override is never clobbered by a track change; `/accent auto` clears it.

const accentCache = new Map();
let lastAccentUrl = '';
let ambientEl = null;

let scheme = 'dark';      // 'dark' | 'light'
let override = null;      // '#rrggbb' or null (auto)
let lastCover = null;     // { vivid:[r,g,b], avg:[r,g,b] } for the current track

export function init(el) { ambientEl = el; render(); }
export function setScheme(s) { scheme = s === 'light' ? 'light' : 'dark'; render(); }
export function setOverride(hex) { override = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex.toLowerCase() : null; render(); }

export function update(coverUrl) {
  if (!coverUrl || coverUrl === lastAccentUrl) return;
  lastAccentUrl = coverUrl;

  const cached = accentCache.get(coverUrl);
  if (cached !== undefined) { lastCover = cached; render(); return; }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let bs = -1, vr = 200, vg = 200, vb = 200;
      let ar = 0, ag = 0, ab = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        ar += r; ag += g; ab += b; n++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        const lum = (r + g + b) / 3;
        const score = sat * 2 + (1 - Math.abs(lum - 150) / 200);
        if (score > bs) { bs = score; vr = r; vg = g; vb = b; }
      }
      const result = { vivid: [vr, vg, vb], avg: [ar / n | 0, ag / n | 0, ab / n | 0] };
      accentCache.set(coverUrl, result);
      if (lastAccentUrl === coverUrl) { lastCover = result; render(); }
    } catch {
      accentCache.set(coverUrl, null);
      if (lastAccentUrl === coverUrl) { lastCover = null; render(); }
    }
  };
  img.onerror = () => { accentCache.set(coverUrl, null); if (lastAccentUrl === coverUrl) { lastCover = null; render(); } };
  img.src = coverUrl;
}

// ---- Resolve + write --------------------------------------------------------

function render() {
  const body = document.body;
  if (!body) return;
  const hex = override || (lastCover ? clampAccent(lastCover.vivid, scheme) : null);
  if (hex) body.style.setProperty('--muse-accent', hex);
  else body.style.removeProperty('--muse-accent');     // fall back to the CSS token
  if (ambientEl) {
    if (lastCover) ambientEl.style.setProperty('--amb', `rgb(${lastCover.avg.join(', ')})`);
    else ambientEl.style.removeProperty('--amb');
  }
}

// Lightness band per scheme, in OKLCH L (0..1). Dark surfaces want a bright
// accent, light surfaces a deep one — both stay readable as 11px text.
const L_BAND = { dark: [0.72, 0.85], light: [0.45, 0.58] };
const C_MIN = 0.05;
const C_MAX = 0.22;

export function clampAccent([r, g, b], forScheme = scheme) {
  let [L, C, H] = rgbToOklch(r, g, b);
  const [lo, hi] = L_BAND[forScheme] || L_BAND.dark;
  L = Math.min(hi, Math.max(lo, L));
  C = Math.min(C_MAX, Math.max(C_MIN, C));
  // Gamut-fit: pull chroma in until the colour is representable in sRGB.
  let rgb = oklchToRgb(L, C, H);
  while (C > 0 && rgb.some((v) => v < 0 || v > 1)) { C -= 0.005; rgb = oklchToRgb(L, C, H); }
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

// ---- sRGB ⇄ OKLCH ----------------------------------------------------------

const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb = (c) => c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function rgbToOklch(r8, g8, b8) {
  const r = toLinear(r8), g = toLinear(g8), b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];
}

function oklchToRgb(L, C, H) {
  const a = C * Math.cos(H), bb = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  return [
    toSrgb( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}
