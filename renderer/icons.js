// Line icons for menu rows — 24-unit viewBox, stroked with currentColor so
// every theme tints them (mono inverts them with the selected row). Drawn in
// the spirit of lucide: 1.75 stroke, round caps and joins.
//
// Row glyphs that are *text* (♥ ▶ ↓) still live in glyphs.js; these are the
// pictures that sit in a menu row's icon tile.

const P = {
  queue:    '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  heart:    '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  playlist: '<path d="M21 15V6"/><circle cx="18.5" cy="18" r="2.5"/><path d="M12 12H3M16 6H3M12 18H3"/>',
  radio:    '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/>',
  palette:  '<path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-1.8a2 2 0 0 0-1.5 3.3 1.7 1.7 0 0 1-1.3 2.7Z"/><circle cx="7.5" cy="11.5" r=".8" fill="currentColor"/><circle cx="10" cy="7" r=".8" fill="currentColor"/><circle cx="15" cy="7.5" r=".8" fill="currentColor"/>',
  droplet:  '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7Z"/>',
  sun:      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:     '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  shuffle:  '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  compass:  '<circle cx="12" cy="12" r="9.5"/><path d="m15.8 8.2-1.9 5.7-5.7 1.9 1.9-5.7Z"/>',
  history:  '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7.5V12l3 2"/>',
  mic:      '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M19 10.5v1a7 7 0 0 1-14 0v-1M12 18.5v3"/>',
  sparkle:  '<path d="M12 3.5 13.9 9 19.5 11l-5.6 2L12 18.5 10.1 13 4.5 11l5.6-2Z"/><path d="M19 3v3M17.5 4.5h3"/>',
  repeat1:  '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  dot:      '<circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  check:    '<path d="M20 6 9 17l-5-5"/>',
  chevron:  '<path d="m9 18 6-6-6-6"/>',
  music:    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  next:     '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  listPlus: '<path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6"/>',
  heartFill:'<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" fill="currentColor"/>',
  arrowUp:  '<path d="m5 12 7-7 7 7M12 19V5"/>',
  arrowDown:'<path d="M12 5v14M19 12l-7 7-7-7"/>',
  x:        '<path d="M18 6 6 18M6 6l12 12"/>',
  play:     '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" fill="currentColor" stroke="none"/>',
  refresh:  '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  layers:   '<path d="m12 2.5 9.5 5-9.5 5-9.5-5Z"/><path d="m2.5 12 9.5 5 9.5-5"/><path d="m2.5 16.5 9.5 5 9.5-5"/>',
  info:     '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4.5M12 8h.01"/>',
  menubar:  '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M2.5 8.5h19M15 6.25h3"/>',
  timer:    '<path d="M10 2.5h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
  waves:    '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  volume:   '<path d="M11 4.7 6.3 8.5H3v7h3.3L11 19.3Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  clock:    '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.2 2"/>',
  sliders:  '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>',
};

export function icon(name) {
  const body = P[name] || P.dot;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
