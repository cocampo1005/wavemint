<div align="center">

<img src="src/assets/Horizontal%20Logo.png" alt="WaveMint" width="420" />

### Turn YouTube videos and playlists into clean, tagged MP3s.

Paste a link, review the metadata, pick your cover art, and extract. WaveMint handles the rest.

![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-4A8DFF?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-41-1FC8FF?style=flat-square&logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-8A5CFF?style=flat-square&logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-4A8DFF?style=flat-square&logo=vite&logoColor=white)

**[Download for Windows](https://github.com/cocampo1005/wavemint/releases/latest)**

</div>

---

## Contents

**For users**

- [Features](#features)
- [Download and install](#download-and-install)
- [Using WaveMint](#using-wavemint)
- [Optional: YouTube sign-in](#optional-youtube-sign-in)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

**For developers**

- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Building the Windows installer](#building-the-windows-installer)
- [Bundled tools](#bundled-tools)
- [Publishing a release](#publishing-a-release)
- [Code signing and SmartScreen](#code-signing-and-smartscreen)
- [Future: automatic updates](#future-automatic-updates)

---

## Features

| | |
|---|---|
| 🎵 **Single videos & playlists** | Analyze one video, or a whole playlist and choose which tracks to extract. |
| 🏷️ **Smart metadata** | Title, artist, album and genre are pre-filled, including details parsed from YouTube Music's *"Provided to YouTube by…"* descriptions. Everything stays editable. |
| 🖼️ **Cover art your way** | Use the **Original** thumbnail, a centered **Square** 1000 × 1000 crop, or a **Custom** image from your computer, with a live preview before you extract. |
| 📚 **Bulk editing** | Apply an artist, album, genre, or cover image to every track in a playlist at once. |
| 🎧 **High-quality MP3s** | Best available audio, encoded to MP3 with ID3v2.3 tags and embedded cover art. |
| ▶️ **Straight to your library** | Open finished files in your default player (e.g. iTunes) with one click, individually or all at once. |
| 🔐 **Optional YouTube sign-in** | Use cookies from your browser or a `cookies.txt` file for videos that need a signed-in account. |
| 📦 **Nothing else to install** | yt-dlp, FFmpeg and everything they need are built in. |
| 🛡️ **Rate-limit aware** | Requests are paced automatically, and WaveMint pauses itself if YouTube rate-limits the session. |

---

## Download and install

1. Open the **[latest release](https://github.com/cocampo1005/wavemint/releases/latest)** and download **`WaveMint-Setup-x.y.z.exe`**.
2. Run the installer. It installs for your Windows account only, so no administrator rights are needed. You can choose the install folder and whether to add a desktop shortcut.
3. Launch **WaveMint** from the Start menu.

That's it. You don't need Node.js, Python, FFmpeg, yt-dlp, or a terminal.

> [!NOTE]
> **"Windows protected your PC"?** WaveMint isn't code-signed yet, so Microsoft SmartScreen may warn you the first time you run the installer. Select **More info**, then **Run anyway**. To check that your download is genuine, compare its SHA-256 hash with `SHA256SUMS.txt` on the release page. In PowerShell, run `Get-FileHash .\WaveMint-Setup-x.y.z.exe`.

**Requirements:** Windows 10 or 11, 64-bit.

---

## Using WaveMint

1. **Choose a source.** Select **Single Video** or **Playlist**.
2. **Paste a YouTube URL** and click **Analyze**.
3. **Review the details.** Edit the title, artist, album, and genre as needed.
4. **Pick your artwork.** Choose **Original**, **Square**, or **Custom** under the preview.
5. **Choose an output folder** where your MP3s will be saved.
6. **Extract.**
   - *Single video:* click **Extract MP3**.
   - *Playlist:* tick the tracks you want (use **Select All** / **Clear All**), optionally fill in **Apply to all tracks**, then click **Extract Selected**.
7. **Open your music.** When extraction finishes, click **Open in iTunes** (or **Open All in iTunes** for playlists). Files open in whichever app is your default for MP3s.

> [!TIP]
> Analyzing a new URL resets the previous results, so you can work through links one after another.

> [!IMPORTANT]
> Only download or extract content you own or have permission to use, in line with YouTube's Terms of Service and the laws where you live.

---

## Optional: YouTube sign-in

Public videos and playlists work without signing in. Some videos (age-restricted, members-only, or private videos shared with you) need a signed-in YouTube account. Signing in can help with those. It doesn't guarantee access, and it doesn't remove YouTube's rate limits.

Open **Settings** (top right) → **YouTube Authentication** and pick a method:

| Method | How it works |
|---|---|
| **No Authentication** (default) | No cookies are used. |
| **Browser Cookies** | WaveMint asks yt-dlp to read your YouTube sign-in from a browser profile on this PC. Choose the browser and the profile you use for YouTube. |
| **Cookies File** | Use a `cookies.txt` file you exported from your browser. |

Then click **Test Authentication**. The test makes one small request to YouTube and nothing is downloaded. It reports two things separately:

- **Cookie source:** could WaveMint read the cookies at all?
- **YouTube session:** did YouTube accept them as a signed-in account?

A green **Signed in** result is shown only when YouTube itself confirmed the session.

### Browser support

WaveMint supports the browsers yt-dlp supports on Windows: **Chrome, Edge, Firefox, Brave, Opera, Vivaldi, Chromium** and **Naver Whale**. Settings shows which ones it found on your PC and lists their profiles. If your browser or profile is in an unusual location, choose **Choose a profile folder…**.

> [!WARNING]
> **Chrome and other Chromium-based browsers.** Recent versions on Windows encrypt cookies so that only the browser itself can read them ("app-bound encryption"). Chromium-based browsers also lock their cookie database while they're open. If the test says the cookies **could not be accessed**, close the browser completely and try again. If it still fails, use a **Cookies File** instead. WaveMint does not try to bypass these protections.
>
> **Firefox** cookies can usually be read while Firefox is open.

### Using a cookies file

1. In your browser, sign in to youtube.com.
2. Export cookies for youtube.com in **Netscape `cookies.txt` format** with a cookie-export extension you trust (for example *"Get cookies.txt LOCALLY"*). JSON exports won't work.
3. In WaveMint, choose **Settings → Cookies File → Choose cookies.txt…**, then **Test Authentication**.

WaveMint uses the file where you saved it and does not copy it. yt-dlp may update the file with refreshed cookies from YouTube. If YouTube signs the session out, the test tells you to export a fresh file. **Remove** only makes WaveMint forget the file; it doesn't delete it.

### Privacy and security

- Cookies never leave your computer. They're only passed to the yt-dlp copy built into WaveMint, which uses them for its requests to YouTube.
- WaveMint stores your choices (method, browser, profile, and the file's location) in `%APPDATA%\WaveMint\settings.json`. It never stores cookie values.
- Browser cookies are read only when you choose **Browser Cookies**, and only by yt-dlp.
- **A cookies file is as sensitive as a password.** It can give access to your Google account. Keep it private, don't share it, and delete it when you no longer need it.

---

## Troubleshooting

<details>
<summary><b>"Some of WaveMint's built-in components could not be started"</b></summary>

A file in the WaveMint installation is missing or was blocked, often by antivirus software. Restore or allow it in your antivirus, or run the installer again to repair WaveMint.

</details>

<details>
<summary><b>"Chrome cookies could not be accessed" (or Edge, Brave…)</b></summary>

Close the browser completely, including any windows in the system tray, and click **Test Authentication** again. If it still fails, the browser is protecting its cookies with app-bound encryption. Switch to **Cookies File**.

</details>

<details>
<summary><b>"YouTube rejected the selected authentication session"</b></summary>

Your sign-in has expired or YouTube rotated it. Sign in to YouTube again in your browser and retest, or export a fresh `cookies.txt`.

</details>

<details>
<summary><b>"…but YouTube didn't see a signed-in account" / "doesn't contain any cookies"</b></summary>

WaveMint could read the cookies, but that browser profile isn't signed in to YouTube. Choose the profile you actually use for YouTube, or sign in to YouTube in that profile first.

</details>

<details>
<summary><b>"YouTube temporarily rate-limited this WaveMint session"</b></summary>

YouTube has throttled requests from your connection. WaveMint pauses itself for up to an hour and shows how long is left. Wait it out before analyzing or extracting again.

</details>

<details>
<summary><b>Downloads fail with HTTP 403 / "Forbidden"</b></summary>

WaveMint already retries with different strategies automatically. YouTube changes often, so make sure you're on the [latest WaveMint release](https://github.com/cocampo1005/wavemint/releases/latest), which includes the newest yt-dlp.

</details>

<details>
<summary><b>Private or age-restricted videos won't work</b></summary>

Set up [YouTube sign-in](#optional-youtube-sign-in) with an account that has access, and use **Test Authentication** to confirm YouTube accepts it.

</details>

---

## Uninstalling

Use **Settings → Apps → Installed apps → WaveMint → Uninstall** in Windows. This removes the app, its shortcuts and its settings. MP3s you extracted and any `cookies.txt` files you exported are not touched.

---

## Development setup

**Prerequisites:** Windows 10/11 x64, [Node.js](https://nodejs.org/) 22 LTS or newer, and Git.

```powershell
git clone https://github.com/cocampo1005/wavemint.git
cd wavemint
npm install
npm run binaries:fetch   # downloads the pinned yt-dlp, Deno and FFmpeg into resources/bin
npm start                # Vite dev server + Electron
```

`npm start` runs the Vite dev server on `http://localhost:5173` and opens Electron against it, with hot reload. You can also run the parts separately: `npm run dev` in one terminal, `npm run electron` in another.

**How development differs from the installed app**

- **Tools:** development uses the binaries fetched into `resources/bin/win32-x64/`. If you haven't fetched them, it falls back to `yt-dlp`, `ffmpeg`, `ffprobe` and `deno` on your `PATH`, which was the original setup. Set `WAVEMINT_USE_SYSTEM_BINARIES=1` to force your `PATH` copies.
- **Settings:** development keeps its settings in `%APPDATA%\WaveMint-Dev`, separate from an installed copy (`%APPDATA%\WaveMint`). To use a personal `cookies.txt` while developing, select it in **Settings → Cookies File** once. Nothing personal is ever stored in the repository.
- **Built UI:** set `WAVEMINT_RENDERER=dist` to make development Electron load the built `dist/` instead of the dev server.

---

## Project structure

```
wavemint/
├── electron/
│   ├── main.cjs          # Main process: IPC handlers, analysis/download/artwork/tagging flows
│   ├── preload.cjs       # Secure bridge exposing window.waveMintAPI to the UI
│   ├── binaries.cjs      # Resolves bundled yt-dlp/FFmpeg/FFprobe/Deno; startup dependency check
│   ├── processes.cjs     # Runs child processes (argument arrays, no shell, timeouts, cleanup)
│   ├── auth.cjs          # YouTube auth: browser/profile discovery, cookies.txt checks, yt-dlp args
│   ├── settings.cjs      # Per-user settings (validated JSON in %APPDATA%)
│   └── assets/icon.png   # Window icon in development
├── src/
│   ├── App.jsx           # The main interface (single-video + playlist flows)
│   ├── SettingsDialog.jsx# Settings → YouTube Authentication
│   ├── App.css / index.css
│   └── assets/           # WaveMint logos
├── build/
│   ├── icon.ico          # Multi-resolution app/installer icon (npm run icon)
│   └── installer.nsh     # NSIS customizations (optional desktop shortcut, cleanup)
├── scripts/
│   ├── binaries.manifest.json  # Pinned tool versions, URLs and SHA-256 hashes
│   ├── fetch-binaries.mjs      # Downloads + verifies the pinned tools
│   ├── check-binary-updates.mjs# Finds newer upstream releases
│   ├── check-release.cjs       # Release safety checks (also electron-builder afterPack)
│   └── generate-icon.cjs
├── tests/                # node --test unit and integration tests
├── electron-builder.yml  # Packaging configuration
└── .github/workflows/release.yml
```

The UI never touches the file system or runs commands directly. Everything goes through `window.waveMintAPI` (defined in `preload.cjs`), which calls narrowly scoped handlers in `main.cjs`. Paths for cookies files, profiles, output folders and artwork are chosen through main-process dialogs. The UI can only open MP3s that WaveMint created.

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Run the dev server and Electron together. |
| `npm run dev` | Start only the Vite dev server on `http://localhost:5173`. |
| `npm run electron` | Launch only Electron (requires the dev server). |
| `npm run build` | Build the interface into `dist/`. |
| `npm run lint` | Run ESLint (UI, main process, scripts, tests). |
| `npm test` | Run the unit and integration tests (`node --test`). |
| `npm run binaries:fetch` | Download and verify the pinned yt-dlp, Deno and FFmpeg (skips if already current). |
| `npm run binaries:verify` | Re-hash the fetched binaries without downloading. |
| `npm run binaries:check-updates` | Show newer upstream versions (`-- --write` updates the manifest). |
| `npm run check:release` | Run the release safety checks on the build inputs. |
| `npm run pack:win` | Build an unpacked app in `release/<version>/win-unpacked/` for testing. |
| `npm run dist:win` | Build the installer `release/<version>/WaveMint-Setup-<version>.exe`. |
| `npm run icon` | Regenerate `build/icon.ico` from `src/assets/Logomark.png`. |

---

## Building the Windows installer

```powershell
npm run dist:win
```

This runs, in order:

1. `vite build`: the UI is compiled into `dist/` with relative asset paths and a strict Content-Security-Policy.
2. `binaries:fetch`: the pinned tools are downloaded if needed and checked against their SHA-256 hashes.
3. `check:release`: the build fails if anything credential-like (cookie files, cookie contents, YouTube session values, hardcoded cookie paths, browser credential stores, keys, `.env` files) would be packaged, or if the bundled tools are missing or differ from the pinned versions.
4. `electron-builder`: packages the app and runs the same checks again on the packaged output, including inside `app.asar`. It then creates the NSIS installer.

**Output:** `release/<version>/WaveMint-Setup-<version>.exe`, with an unpacked copy in `release/<version>/win-unpacked/`.

Only `dist/`, `electron/` and `package.json` go into `app.asar`. No `node_modules`, sources, scripts or tests are packaged. The tools are placed outside the archive in `resources\bin\`, and license texts in `resources\bin\licenses\` and `resources\licenses\`.

---

## Bundled tools

| Tool | Version | Source | License |
|---|---|---|---|
| yt-dlp (`yt-dlp.exe`, includes yt-dlp-ejs) | 2026.08.19 | [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) | Unlicense + bundled licenses |
| Deno | 2.9.7 | [Deno releases](https://github.com/denoland/deno/releases) | MIT |
| FFmpeg + FFprobe (LGPL, shared) | n8.1.3 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (end-of-month build) | LGPL-3.0 |

Pins live in [`scripts/binaries.manifest.json`](scripts/binaries.manifest.json). Every hash there comes from the upstream project's own checksum file, and `fetch-binaries` rejects any download that doesn't match. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for licensing details.

**How WaveMint finds them at runtime** (`electron/binaries.cjs`): the installed app always uses `<install dir>\resources\bin\` and never your `PATH`. Every yt-dlp call gets `--ignore-config`, `--no-js-runtimes --js-runtimes deno:<bundled deno.exe>` and `--ffmpeg-location <bundled bin>`, so yt-dlp solves YouTube's JavaScript challenges with the bundled Deno and converts audio with the bundled FFmpeg. At startup WaveMint runs each tool once in the background to confirm it works, and shows a clear message if one is missing or blocked.

**Updating the tools.** YouTube changes often, so expect to refresh yt-dlp regularly, independently of app changes:

```powershell
npm run binaries:check-updates            # see what's new
npm run binaries:check-updates -- --write # update pins (URLs + official hashes)
npm run binaries:fetch -- --force
npm test
```

Then update the versions in `THIRD_PARTY_NOTICES.md` and this table, test analysis, extraction, artwork and authentication in `npm start` and in `npm run pack:win`, bump the app version, and release. BtbN removes daily FFmpeg builds after a few weeks, so the checker only proposes end-of-month builds, which are kept for over a year.

---

## Publishing a release

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on GitHub's Windows runners.

1. Bump `"version"` in `package.json` (for example `1.0.1`) and commit.
2. Tag and push: `git tag v1.0.1 && git push origin v1.0.1`
3. The workflow installs dependencies, fetches and verifies the tools, runs lint and tests, builds the installer (with the safety checks), and creates a **draft** GitHub Release. The draft contains the installer, its `.blockmap`, `SHA256SUMS.txt`, and the FFmpeg source archive (for the LGPL).
4. Download the installer from the draft and test it on a clean Windows PC with the [release checklist](docs/RELEASE_CHECKLIST.md).
5. Edit the draft notes if needed, then **Publish**. Nothing becomes public before this step.

You can also run the workflow manually (**Actions → Windows release → Run workflow**) to get the installer as a build artifact without creating a release. The workflow needs no secrets: it uses the built-in `GITHUB_TOKEN`, and builds are unsigned.

---

## Code signing and SmartScreen

Unsigned installers work, but Windows SmartScreen warns users until a download builds reputation. To sign releases:

1. Get a code-signing certificate (an OV or EV certificate from a certificate authority) or set up [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/).
2. For a `.pfx` certificate, add repository secrets `WIN_CSC_LINK` (base64-encoded `.pfx`) and `WIN_CSC_KEY_PASSWORD`, and expose them as environment variables on the **Build installer** step. electron-builder signs automatically when they're present. For Azure Trusted Signing, add `win.azureSignOptions` to `electron-builder.yml` and the Azure credentials as secrets.
3. **Bundled tools:** by default electron-builder signs every `.exe`, including the third-party tools in `resources\bin`. That changes their bytes, so the release check (which verifies them against the pinned hashes) will fail. That's intentional. Either keep the upstream files unmodified by using a custom `win.signtoolOptions.sign` hook that signs only `WaveMint.exe`, the uninstaller and the installer (recommended), or update `check-release.cjs` to compare the files without their signatures.

Never commit certificates or passwords. The release check fails the build if `.pfx`, `.p12`, `.pem` or `.key` files would be packaged.

---

## Future: automatic updates

The packaging is ready for [electron-updater](https://www.electron.build/auto-update) with GitHub Releases. It uses the NSIS target, a stable `appId`, generates `.blockmap` files for differential downloads, and the installer caches itself for that purpose. To enable it:

1. `npm install electron-updater` (as a regular dependency, since it runs in the main process).
2. In `electron-builder.yml`, replace `publish: null` with
   ```yaml
   publish:
     provider: github
     owner: cocampo1005
     repo: wavemint
   ```
   so builds also produce `latest.yml`. Upload it with the installer and blockmap (add it to the workflow's release files).
3. In `main.cjs`, call `autoUpdater.checkForUpdatesAndNotify()` after the window opens, only when `app.isPackaged`.
4. Sign releases first. Unsigned auto-updates trigger SmartScreen on every update.

Bundled yt-dlp updates then reach users through regular WaveMint releases.

---

<div align="center">
<img src="src/assets/Logomark.png" alt="" width="56" />
<br />
<sub>Built with Electron, React, yt-dlp, Deno, and FFmpeg.</sub>
</div>
