// Theme registry. A theme is a *material* — type, radius, shadow, default
// accent — layered under the light/dark scheme (which stays a separate axis:
// every theme has both). Tokens live in style.css under
// body[data-theme="<id>"]; this file only declares what exists so the
// command surface can list and validate them.

export const THEMES = [
  { id: 'muse',  label: 'muse',  description: 'quiet, airy — the default' },
  { id: 'paper', label: 'paper', description: 'warm cream & ink, serif titles' },
  { id: 'mono',  label: 'mono',  description: 'terminal: monospace, hard edges' },
];

export const DEFAULT_THEME = 'muse';
export const byId = Object.fromEntries(THEMES.map((t) => [t.id, t]));
export const isTheme = (id) => Object.prototype.hasOwnProperty.call(byId, id);
