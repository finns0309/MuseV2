# muse

A summon-anywhere command palette for NetEase Cloud Music. Hit
**⌥Space**, change what's playing, and it's gone again. No dock icon, no
windows to manage — it lives in the menu bar and the whole UI is one palette.

When idle it's a small now-playing card: big cover, the title, a progress
line, and an accent color pulled live from the album art that washes the whole
surface. Start typing and it morphs into search. It holds the real `<audio>`
element and plays in the background; closing the window just hides it.

muse is the controller half of a two-app setup. Its companion **[echo](https://github.com/finns0309/echo)**
is a floating-lyrics widget that reads muse's playback state over a local
socket — see [muse ↔ echo](#muse--echo).

> macOS (Apple Silicon), Electron. Built around my own liked-songs library;
> it's a personal tool, not a polished NetEase client.

## Install

**Download** — grab the latest `.dmg` from
[Releases](https://github.com/finns0309/muse/releases/latest), drag to
Applications. The build is unsigned, so on first launch **right-click → Open**
(double-clicking shows a Gatekeeper warning). First run asks you to scan a QR
with the NetEase mobile app.

**From source**

```bash
git clone git@github.com:finns0309/muse.git
cd muse && npm install && npm start
```

## Usage

Everything happens in the palette. Type to search; prefix with `/` for commands.

| Input | Does |
|-------|------|
| `<query>` | search your library (and NetEase cloud at ≥2 chars) |
| `/queue` `/queue <q>` | browse / filter the current queue |
| `/library` `/library <q>` | browse / filter your liked library |
| `/pl` | list saved playlists |
| `/pl <id or url>` | load a NetEase playlist and remember it |
| `/mode`, `/daily`, `/discover`, … | switch listening mode |
| `/light` `/dark` | appearance |
| `/theme` `/theme <muse\|paper\|mono>` | list / switch the material — muse (follows the cover), paper (serif, vermilion ink), mono (monochrome terminal) |
| `/accent #d8b35f` / `/accent auto` | pin the accent color / back to auto (the cover in muse, the theme's own ink in paper & mono) |

| Key | Action |
|-----|--------|
| `⌥Space` | summon from anywhere (also `⌘⇧Space`) |
| `⌘K` | open palette |
| `⌘←` / `⌘→` | previous / next |
| `⌘P` / `Space` | play-pause |
| `Enter` | run the selection |
| `⌥Enter` | alternate action (usually: start a radio from this song) |
| `⌘D` | like / unlike the highlighted song |
| `Esc` | clear the input, then hide the window |

## How it works

**Library** mirrors your NetEase Liked Songs playlist locally, plus lightweight per-song
metadata (`playCount`, `lastPlayedAt`). NetEase stays the source of truth —
songs you only *play* (search, discover, playlists) never pollute the library;
liking one (`⌘D`) calls `/like` and syncs the mirror.

**Modes** are queue builders — pure functions of `(library, player, now)` that
return a queue: `all`, `daily`, `discover`, `dig up`, `immersive`, `similar`,
`single`. A **playback session** tracks *why* the current queue exists
(`mode` / `manual` / `radio` / `playlist`) so picking a song knows whether to
interrupt the mode or extend it.

**The runtime** owns the single `<audio>` element and broadcasts accurate state
on two local channels, so echo (or anything) never has to guess:

```
GET  http://127.0.0.1:10755/now        authoritative now-playing (songId, position, state)
WS   ws://127.0.0.1:10755/spectrum     24-band audio spectrum + RMS, ~30fps while playing
```

Wire format lives in [`NOW_PLAYING.md`](./NOW_PLAYING.md). A second local server
on `10754` is the NetEase API wrapper.

## muse ↔ echo

The split is deliberate: muse stays small, fast, and mostly-backgrounded; echo
gets to be the visual, always-on lyrics layer. They talk one way only — muse
publishes, echo reads:

```
NetEase  →  muse  ──/now + /spectrum──►  echo
            (control, runtime)            (lyrics, ambient)
```

echo can run standalone off `nowplaying-cli`, but that's lossy (sparse events,
stuck elapsed time, fuzzy title matching). When muse is running it gets the
exact `songId` and position instead.

## Local data

Stored under Electron's `userData`, atomic writes (corrupt files quarantined as
`.bad-<ts>.bak`):

- `cookie.txt` — NetEase login
- `data/library.json` — liked-songs mirror + play metadata
- `data/history.json` — play events (365-day retention)
- `data/ui-prefs.json` — mode, appearance, accent
- `data/saved-playlists.json` — playlists remembered via `/pl`

## Project layout

```
main.js              Electron app, window, tray, global shortcuts; NCM API +
                     /now + /spectrum servers; cookie / store / history
preload.js           the window.muse IPC bridge
lib/store.js         JSON store (one file per key, atomic, quarantine-on-corrupt)

renderer/
  app.js             boot: prefs → auth → mount cmdk → library sync → mode runner
  cmdk.js            the palette: DOM, render, cursor, keys, window resize
  commands.js        builders for queue / library / playlist / mode / search
  player.js          the <audio> element, queue, scrobble, /now + spectrum push
  accent.js          pull accent + ambient color from album art
  transitions.js     summon / hide / cover / title / track-change animations
  glyphs.js          the canonical Unicode glyph set (❯ ♥ ▶ ↳ ▸ ◆)
  playlist.js        NetEase playlist load + local bookmarks
  store.js           tiny pub/sub store (select / selectKey / race)
  auth.js  api.js    QR login; NetEase API wrapper (retry, realIP, auth hooks)
  modes/             queue builders + session.js
  lib/               library mirror, similar, artist helpers
```

## Develop & release

`npm start` to develop. `npm run build` for a local `.dmg`. `npm run release`
publishes to GitHub Releases. See [`RELEASING.md`](./RELEASING.md) for the full
flow (token setup, Gatekeeper note, troubleshooting).
