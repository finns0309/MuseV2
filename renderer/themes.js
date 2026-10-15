// Theme registry. A theme is a *material* — type, radius, shadow, default
// accent — layered under the light/dark scheme (which stays a separate axis:
// every theme has both). Tokens live in style.css under
// body[data-theme="<id>"]; this file only declares what exists so the
// command surface can list and validate them.
//
// followCover: whether the accent tracks the album art (accent.js). muse is
// the chameleon; the others are materials with their own ink, so a blue
// cover can't turn the vermilion stamp, the terminal or the clay blue.
// A pinned /accent still wins either way.

export const THEMES = [
  { id: 'muse',  label: 'muse',  description: 'quiet, airy — the default', followCover: true },
  { id: 'paper', label: 'paper', description: 'printed matter: serif, vermilion ink', followCover: false },
  { id: 'mono',  label: 'mono',  description: 'monochrome terminal', followCover: false },
  { id: 'claude', label: 'claude', description: 'warm ivory, clay, a little spark', followCover: false },
];

export const DEFAULT_THEME = 'muse';
export const byId = Object.fromEntries(THEMES.map((t) => [t.id, t]));
export const isTheme = (id) => Object.prototype.hasOwnProperty.call(byId, id);
