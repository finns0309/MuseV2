# Releasing & maintaining MuseV2

> MuseV2 has **no GitHub repo yet**. `build.publish` points at
> `finns0309/MuseV2`, so `npm run release` fails until that repo exists —
> by design, so a V2 build can never land on muse v1's releases page. The
> v1 links below are kept for reference. `npm run build` (local install)
> works today and produces `MuseV2.app`.

Three separate workflows — don't mix them up:

| Goal | Command | Notes |
|------|---------|-------|
| **Develop** (iterate on code) | `npm start` | Instant. No packaging. This is 90% of the time. |
| **Install locally** (use the real app yourself) | `npm run build` then drag `dist/Muse-*.dmg` | Makes the menu-bar app on *this* machine. |
| **Distribute** (let others download) | `npm run release` | Uploads a DMG to GitHub Releases at a fixed URL. |

Fixed download link for testers (always newest):
**`github.com/finns0309/muse/releases/latest`**

---

## One-time setup (for distribute)

Create a GitHub **Personal Access Token** with write access to repo contents.
Either kind works:

- **Classic** (simplest): Settings → Developer settings → Personal access tokens
  → Tokens (classic) → Generate → check **`repo`** → copy.
- **Fine-grained**: Settings → Developer settings → Personal access tokens →
  Fine-grained → select the `muse` repo → Repository permissions →
  **Contents: Read and write** → copy.
  ⚠️ Without Contents:write you get `403 Resource not accessible by token`.

Optionally add `export GH_TOKEN=...` to `~/.zshrc` so you don't retype it.
**Treat the token as a secret** — never commit it; revoke + regenerate if it leaks.

## Cut a release

```bash
npm version patch          # bump 0.1.1 → 0.1.2, commit + tag locally
GH_TOKEN=ghp_xxx npm run release   # build DMG + upload to a GitHub DRAFT release
git push && git push --tags        # push the version commit + tag
```

`npm run release` builds `dist/Muse-<version>-arm64.dmg` and uploads it (plus
`latest-mac.yml` + a blockmap) to a **draft** GitHub Release named `v<version>`.

`npm version`: use `patch` (bugfix), `minor` (features), or `major` (breaking).

## Publish it

electron-builder leaves the release as a **draft** so you review first:

1. Open `github.com/finns0309/muse/releases` → the draft `v<version>`.
2. Paste the tester instructions (below) into the description.
3. Click **Publish release**.

Now `…/releases/latest` resolves to it. Send testers that one link.

---

## Tester install instructions (paste into the release description)

> **Install muse** (Apple Silicon Macs)
>
> 1. Download `Muse-x.y.z-arm64.dmg` below and open it.
> 2. Drag **Muse** to Applications.
> 3. **First launch:** right-click `Muse.app` → **Open** → **Open** again.
>    (Double-clicking shows "Muse is damaged / can't verify developer" — that's
>    macOS Gatekeeper blocking an unsigned app, not a real problem.)
>    Still stuck? Run once: `xattr -cr /Applications/Muse.app`
> 4. muse lives in the **menu bar** (no Dock icon). Summon it with **⌥Space**.
>    First run asks you to scan a QR with the NetEase Cloud Music app to log in.

---

## Troubleshooting

**`403 Resource not accessible by personal access token`** — the token lacks
repo Contents:write. Fix the token (see One-time setup), then re-run
`npm run release` (no need to bump the version again if it's already tagged).

**Tester sees "Muse is damaged" / "can't verify developer"** — expected for an
ad-hoc-signed build. Right-click → Open, or `xattr -cr /Applications/Muse.app`.
To remove the warning entirely you'd need an Apple Developer ID ($99/yr) for
signing + notarization (then `electron-updater` silent auto-update also becomes
possible — not set up today).

**Icon didn't change after reinstall** — Finder/Dock icon cache. Trash the old
`Muse.app`, empty Trash, reinstall; if still stale, `killall Dock Finder`.

**"muse 已经在运行" on launch** — another instance holds port 10755 (`/now`).
Quit it from the menu-bar tray (or `pkill -f Muse`) and relaunch.

**Regenerate the app icon** — edit `assets/icon-source.svg`, then
`npx electron scripts/build-icon-from-svg.js` (rebuilds `icon.icns` + `icon.png`).
Or, if you exported a PNG from Figma → save as `assets/icon.png` →
`npx electron scripts/png-to-icns.js`.

## What's NOT set up

- **Silent in-app auto-update** — needs Apple code signing ($99/yr). The
  `latest-mac.yml` is already uploaded, so wiring `electron-updater` later is
  a small step once signing exists.
- **Windows / Intel builds** — only `--mac` (arm64) is configured.
