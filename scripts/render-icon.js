// Icon renderer. Rasterises SVG through Chromium's <canvas> (exact alpha, any
// size — no window capture) and writes:
//   assets/icon.icns + assets/icon.png      app icon, from assets/icon-source.svg
//   assets/trayTemplate(@2x).png            menu-bar spark, playing (solid)
//   assets/trayPausedTemplate(@2x).png      the same spark at reduced alpha
//   assets/traySpin{1..5}Template(@2x).png  turn frames, played on a track change
// Tray images are macOS templates: black + alpha, tinted by the system.
//
// Usage: npx electron scripts/render-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'assets');
const ICONSET = path.join(__dirname, '..', 'icon.iconset');

// The spark on a 22-unit grid — eight petals, the same proportions as the
// composer's ✻ and the app icon. `turn` rotates the whole spark (degrees).
function sparkSvg({ turn = 0, alpha = 1 } = {}) {
  const petals = Array.from({ length: 8 }, (_, k) =>
    `<ellipse cx="11" cy="5.4" rx="1.6" ry="3.7" transform="rotate(${k * 45 + turn} 11 11)"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><g fill="#000" fill-opacity="${alpha}">${petals}</g></svg>`;
}

// Rasterise an SVG string to PNG bytes at w×h in the hidden page.
async function raster(win, svg, w, h) {
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, ${w}, ${h});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const tmp = path.join(os.tmpdir(), 'musev2-icon.html');
  fs.writeFileSync(tmp, '<!doctype html><meta charset="utf-8"><body></body>');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(tmp);

  // App icon
  const appSvg = fs.readFileSync(path.join(OUT, 'icon-source.svg'), 'utf8');
  fs.mkdirSync(ICONSET, { recursive: true });
  const map = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, px] of map) fs.writeFileSync(path.join(ICONSET, name), await raster(win, appSvg, px, px));
  fs.writeFileSync(path.join(OUT, 'icon.png'), await raster(win, appSvg, 1024, 1024));
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(OUT, 'icon.icns')]);
  fs.rmSync(ICONSET, { recursive: true, force: true });

  // Tray: 18pt canvas (36px @2x), the menu bar's comfortable glyph size.
  const tray = async (name, opts) => {
    fs.writeFileSync(path.join(OUT, `${name}.png`), await raster(win, sparkSvg(opts), 18, 18));
    fs.writeFileSync(path.join(OUT, `${name}@2x.png`), await raster(win, sparkSvg(opts), 36, 36));
  };
  await tray('trayTemplate', {});
  await tray('trayPausedTemplate', { alpha: 0.42 });
  // Eight-fold symmetry: a 45° turn looks like a full revolution.
  for (let i = 1; i <= 5; i++) await tray(`traySpin${i}Template`, { turn: (45 / 6) * i });

  win.destroy();
  fs.rmSync(tmp, { force: true });
  console.log('[icon] wrote icon.icns, icon.png, tray (playing, paused, 5 spin frames)');
  app.quit();
});
