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
- [Keeping extraction working](#keeping-extraction-working)
- [YouTube Access and optional sign-in](#youtube-access-and-optional-sign-in)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

**For developers**

- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [How extraction works](#how-extraction-works)
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
| 🚀 **No setup for public videos** | Install, paste a link, extract. No account, cookies or configuration needed. |
| 🔄 **Self-updating engine** | Install newer, signature-verified versions of the YouTube extraction engine from Settings, without reinstalling. |
| 💬 **Clear messages** | Problems are explained in plain language with a next step (Retry, YouTube Access, Check for Updates). Technical details are one click away. |
| 🔐 **Optional YouTube sign-in** | For videos that need a signed-in account, use cookies from your browser or a `cookies.txt` file. |
| 📦 **Nothing else to install** | yt-dlp, FFmpeg and everything they need are built in. |
| 🛡️ **Rate-limit aware** | Requests are paced automatically, brief connection problems are retried, and WaveMint pauses itself if YouTube rate-limits the session. |

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

You can **Cancel** an analysis or extraction from its progress bar. If a playlist track can't be extracted (for example, it was removed or is private), WaveMint skips it, finishes the others and tells you which ones were skipped.

> [!TIP]
> Analyzing a new URL resets the previous results, so you can work through links one after another.

> [!IMPORTANT]
> Only download or extract content you own or have permission to use, in line with YouTube's Terms of Service and the laws where you live.

---

## Keeping extraction working

YouTube changes often, and sometimes an update to WaveMint's extraction engine (yt-dlp) is needed. You don't have to reinstall WaveMint for that:

1. Open **Settings** → **Extraction Engine** and click **Check for Updates**.
2. If a newer version is available, click **Install**. WaveMint downloads it from yt-dlp's official releases, checks its signature and tests it before using it.
3. If anything goes wrong, **Use Built-in Version** switches back to the version that came with WaveMint.

By default WaveMint also checks quietly in the background, at most once a day. It never installs anything until you click **Install**, and nothing stops working when you're offline. **Stable** is the default channel; **Nightly** gets fixes sooner but is less tested.

> [!NOTE]
> YouTube access is never guaranteed. YouTube can change or restrict access at any time, and a fix may take a few days to appear.

---

## YouTube Access and optional sign-in

WaveMint automatically connects to YouTube for publicly accessible videos. **No account setup is required**, and most people never need to open this part of Settings.

Some videos (age-restricted, members-only, or private videos shared with you) need a signed-in YouTube account. WaveMint tells you when that's the case and offers a **YouTube Access** button. Signing in can help with those videos. It doesn't guarantee access, and it doesn't remove YouTube's rate limits.

Open **Settings** (top right) → **YouTube Access** → **Advanced Authentication** and pick a method:

| Method | How it works |
|---|---|
| **Off** (default) | Automatic access. No cookies are used. |
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
3. In WaveMint, choose **Settings → YouTube Access → Advanced Authentication → Cookies File → Import Cookies File…**, then **Test Authentication**.

> [!TIP]
> Export from a private (InPrivate/Incognito) window and close it right after exporting. YouTube keeps refreshing the cookies of open browser tabs, which can invalidate an exported file.

**Remove Authentication** turns sign-in off and makes WaveMint forget the browser, profile and file location you chose. It never deletes files.

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
<summary><b>"YouTube refused to send the audio" / "extraction components may need an update"</b></summary>

WaveMint already tried the safe alternatives automatically. YouTube changes often: click **Check for Updates** in the message (or open **Settings → Extraction Engine**), install the newest engine, then try again.

</details>

<details>
<summary><b>"WaveMint couldn't connect to YouTube"</b></summary>

WaveMint retries brief connection problems by itself. If you still see this, check your internet connection (and any VPN or proxy), then click **Retry**.

</details>

<details>
<summary><b>Reporting a problem</b></summary>

Click **Details** in the error message, then **Copy Error Details**, and paste that into your report. Cookies, sign-in tokens and your Windows user folder are removed from these details.

</details>

<details>
<summary><b>Private or age-restricted videos won't work</b></summary>

Set up [YouTube sign-in](#youtube-access-and-optional-sign-in) with an account that has access, and use **Test Authentication** to confirm YouTube accepts it.

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
- **Settings:** development keeps its settings in `%APPDATA%\WaveMint-Dev`, separate from an installed copy (`%APPDATA%\WaveMint`). To use a personal `cookies.txt` while developing, select it in **Settings → YouTube Access → Advanced Authentication → Cookies File** once. In-app engine updates made while developing go to `%APPDATA%\WaveMint-Dev\engine`. Nothing personal is ever stored in the repository.
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
│   ├── extraction.cjs    # Extraction manager: yt-dlp commands, retries, rate limits, cancel, progress
│   ├── errors.cjs        # Failure categories and plain-language messages
│   ├── diagnostics.cjs   # Sanitized technical details for "Copy Error Details"
│   ├── engine.cjs        # In-app yt-dlp updates: verify, test, activate, roll back
│   ├── pgp.cjs           # OpenPGP signature check for yt-dlp releases (Node crypto only)
│   ├── trust/            # yt-dlp's release signing key (pinned by fingerprint)
│   ├── settings.cjs      # Per-user settings (validated JSON in %APPDATA%)
│   └── assets/icon.png   # Window icon in development
├── src/
│   ├── App.jsx           # The main interface (single-video + playlist flows)
│   ├── SettingsDialog.jsx# Settings: YouTube Access, Extraction Engine, About
│   ├── ipcErrors.js      # Reads error categories and diagnostics ids from main-process errors
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
├── docs/                 # ENGINEERING.md (architecture, evaluations), release checklist
├── tests/                # node --test unit and integration tests (+ fixtures/)
├── electron-builder.yml  # Packaging configuration
└── .github/workflows/release.yml
```

The UI never touches the file system or runs commands directly. Everything goes through `window.waveMintAPI` (defined in `preload.cjs`), which calls narrowly scoped handlers in `main.cjs`. Paths for cookies files, profiles, output folders and artwork are chosen through main-process dialogs. The UI can only open MP3s that WaveMint created.

---

## How extraction works

All yt-dlp runs go through one **extraction manager** (`electron/extraction.cjs`). It builds the command (bundled Deno and FFmpeg, no user config or plugins, optional sign-in), runs it with cancellation, classifies failures into categories such as *network-timeout*, *unavailable*, *auth-required* or *extractor-outdated*, and decides conservatively whether another attempt is worthwhile:

- brief connection problems: up to two retries with backoff;
- HTTP 403 on the audio stream: the existing ladder (without cookies if sign-in is configured, then yt-dlp's `mweb` client), each step once;
- YouTube rate limits: stop and pause the session for an hour;
- everything else (private, removed, region-locked, sign-in needed…): stop immediately with a clear message.

Technical details stay in the main process, sanitized, and are shown only on request. See [`docs/ENGINEERING.md`](docs/ENGINEERING.md) for the full design, the in-app engine updater's trust model, and the measured evaluations of PO Token providers and YouTube.js (both evaluated and deliberately not integrated).

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

**How WaveMint finds them at runtime** (`electron/binaries.cjs`): the installed app always uses `<install dir>\resources\bin\` and never your `PATH`. Every yt-dlp call gets `--ignore-config`, `--no-js-runtimes --js-runtimes deno:<bundled deno.exe>` and `--ffmpeg-location <bundled bin>`, so yt-dlp solves YouTube's JavaScript challenges with the bundled Deno and converts audio with the bundled FFmpeg. At startup WaveMint runs each tool once in the background to confirm it works (for yt-dlp, that it can use the bundled Deno and its built-in EJS challenge solver), and shows a clear message if one is missing or blocked.

**In-app engine updates** are stored per user in `%APPDATA%\WaveMint\engine\versions\<version>\` and take priority over the bundled yt-dlp once verified; the bundled copy is always the fallback. See [docs/ENGINEERING.md](docs/ENGINEERING.md#extraction-engine-updates).

**Updating the tools.** YouTube changes often, so expect to refresh yt-dlp regularly, independently of app changes:

```powershell
npm run binaries:check-updates            # see what's new (yt-dlp: also verifies the release signature)
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

The extraction engine (yt-dlp) already updates independently from inside the app (Settings → Extraction Engine); app updates would cover WaveMint itself, Deno and FFmpeg.

---

<div align="center">
<img src="src/assets/Logomark.png" alt="" width="56" />
<br />
<sub>Built with Electron, React, yt-dlp, Deno, and FFmpeg.</sub>
</div>
