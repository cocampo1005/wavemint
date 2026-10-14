<div align="center">

<img src="src/assets/Horizontal%20Logo.png" alt="WaveMint" width="420" />

### A desktop music library manager for Windows

Organize, tag, edit and play your music collection. Add songs from YouTube as tagged MP3s,<br />
replace songs with better-quality versions, and keep every change undoable.

</div>

---

## Contents

**Using WaveMint**
[Overview](#overview) · [Features](#features) · [Project status](#project-status) · [Installation](#download-and-installation) · [System requirements](#system-requirements) · [Getting started](#getting-started) · [YouTube access](#youtube-access-and-optional-sign-in) · [Keeping extraction working](#keeping-extraction-working) · [Troubleshooting](#troubleshooting) · [Privacy and your data](#privacy-and-your-data)

**Developing WaveMint**
[Building from source](#building-from-source) · [Architecture](#architecture) · [Testing](#testing) · [Releasing](#releasing)

**Legal**
[Responsible use and copyright](#responsible-use-and-copyright) · [Third-party software](#third-party-software-and-non-affiliation) · [Disclaimer](#disclaimer-of-warranty-and-limitation-of-liability) · [License](#license)

---

## Overview

WaveMint started as a small tool for turning YouTube videos into tagged MP3s and grew into a music library manager for people who keep their own collection of audio files. It reads the folders you already have (an old iTunes Media folder, a curated collection, downloads) without changing them, helps you clean up their metadata, artwork, duplicates and quality problems, and keeps the result in a tidy **WaveMint Library** folder.

It's built around a few principles:

- **Your files are safe by default.** Music folders you add are read-only unless you allow writing. Every file change is copied, verified, journaled and undoable from History; nothing is deleted without asking (deletions go to the Recycle Bin).
- **Local first.** Your library, metadata and history live on your computer. Online services are only contacted when you use a feature that needs them.
- **One place for the whole workflow:** browsing and playback, metadata and artwork, audio trimming, adding new songs, upgrading old ones, and preparing files for Apple Music on an iPhone.

## Features

**Library**
- Browse and search songs, albums, artists, genres, favorites and playlists, starting from an Overview of recently added music, genres and top artists.
- Add any number of music folders. Scans are read-only; folders stay untouched unless you mark them writable.
- Edit metadata for one song, many songs at once, or a whole album, with a preview of every change. Changes are stored in WaveMint and written into files only when you choose **Write Tags**, after a verified backup.
- Organize copies of your songs into the **WaveMint Library** folder with a naming pattern (default `Album Artist/Album/Track Title`).
- Manual and smart playlists (rules on genre, artist, album and more), with M3U8 import and export.
- **History** lists every change, and almost all of them can be undone.

**Playback**
- A player with a queue (Play Next, Add to Queue, drag to reorder), shuffle and repeat, and Windows media keys.
- **Listen Mode**: fullscreen-ready large artwork with a visualizer whose translucent contours flow from the artwork's edges, driven by the music that's playing.

**Adding music**
- **Add Music** analyzes a YouTube video or playlist, pre-fills title, artist, album and genre (including YouTube Music's "Provided to YouTube by…" details), and lets you edit everything before adding.
- Artwork from the original thumbnail, a centered 1000 × 1000 square crop, or your own image, previewed before extraction.
- Songs are converted to MP3 with ID3v2.3 tags and embedded artwork, and added straight to your library. A playlist can also be imported as an album, with a review step before anything is added.

**Editing and upgrading**
- A built-in **audio editor** trims songs and adds fades, with a waveform and live preview (for library songs and for new songs before they're added).
- **Upgrade Track** replaces a song's file with a better version, either a file from your computer or a URL. The song's current details are prefilled and editable; WaveMint writes your final metadata and artwork into the new file, compares quality side by side (with A/B listening and spectrograms), warns about likely live or alternate versions, and keeps the old file so the upgrade can be undone.
- **Quality & Upgrades** flags low-bitrate, transcoded and damaged files.

**Maintenance**
- **Merge & Duplicates** finds the same song across folders and merges them into one entry with several file versions.
- **Review** collects metadata problems (missing artwork, inconsistent albums, unclassified genres).
- **Identify** (optional, off by default) looks songs and albums up on MusicBrainz and the Cover Art Archive.
- **Storage** shows WaveMint's disk usage and cleans up old backups and previous versions after a retention period you choose.

**Apple Music and iPhone**
- **Prepare for iPhone** keeps an export folder of finished files for Apple Music or iTunes (FLAC is converted to Apple Lossless; MP3, AAC and ALAC are copied as they are), plus playlists and a report of what changed. WaveMint never edits Apple's library or talks to the iPhone; see [limitations](#apple-music-and-itunes).

**Extraction engine**
- yt-dlp, Deno and FFmpeg are bundled; nothing else needs to be installed.
- The YouTube extraction engine (yt-dlp) can be updated from Settings without reinstalling. Updates are verified against yt-dlp's signed checksums and tested before use, and the built-in version is always the fallback.
- Requests are paced, brief connection problems are retried, and WaveMint pauses itself if YouTube rate-limits the session. Errors are explained in plain language with technical details one click away.

## Project status

- **Platform:** Windows 10 and 11 (64-bit) only. The build configuration, bundled tools and file handling target Windows; other platforms are not supported.
- **Releases:** no release has been published yet. Until one is, build WaveMint from source ([below](#building-from-source)).
- **License:** not yet chosen; see [License](#license).
- WaveMint is an independent personal project, maintained in spare time.

## Download and installation

When a release is published, it will be on the **[Releases page](https://github.com/cocampo1005/wavemint/releases)** as `WaveMint-Setup-<version>.exe`, with a `SHA256SUMS.txt` file to verify the download.

1. Download and run the installer. It installs for your Windows account only (no administrator rights needed); you can choose the folder and whether to add a desktop shortcut.
2. Start **WaveMint** from the Start menu.

> [!NOTE]
> Builds are not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info**, then **Run anyway**, after checking the download's hash: `Get-FileHash .\WaveMint-Setup-<version>.exe` in PowerShell should match `SHA256SUMS.txt`.

**Uninstalling:** Windows Settings → Apps → Installed apps → WaveMint → Uninstall. This removes the app **and its data folder `%APPDATA%\WaveMint`, including the library database** (your edits, playlists and history). Your music files, the WaveMint Library folder and any exported files are not touched. If you might reinstall, back up `%APPDATA%\WaveMint\library` first.

## System requirements

| | |
|---|---|
| Operating system | Windows 10 or 11, 64-bit |
| Disk space | About 650 MB for the app and its bundled tools, plus room for your WaveMint Library, backups and caches |
| Internet | Only for adding music from YouTube, engine updates and the optional MusicBrainz lookups. The library, player and editors work offline. |
| Other software | None. yt-dlp, Deno, FFmpeg and FFprobe are included. |

## Getting started

### 1. Set up your library

1. WaveMint opens on the **Overview**. Choose **Add iTunes / Legacy Folder** there, or go to **Manage → Sources** and choose **Add Curated Folder**, **Add Legacy Folder** or **Add Other…**, then pick a folder of music. It's scanned read-only; the folder's role decides which copy is preferred when the same song appears in several folders.
2. Under **Manage → WaveMint Library**, choose the folder where WaveMint should keep its own organized copies. Songs you add or upgrade are saved there.
3. Browse with **Songs**, **Albums**, **Artists** and **Genres**; double-click a song to play it.

### 2. Add music from YouTube

1. Click **Add Music** at the top of the navigation.
2. Choose **Single Video** or **Playlist**, paste the link and click **Analyze**.
3. Check the title, artist, album and genre. For a playlist, tick the songs you want and optionally use **Apply to all songs**.
4. Pick the artwork under the preview: **Original**, **Square** or **Custom**.
5. Click **Add to Library** (or **Add Selected to Library**). Tick **Edit audio before adding** to trim or fade a song first.

You can cancel an analysis or extraction from its progress bar. Songs that can't be added (removed, private, region-locked) are skipped and marked; the others are added.

### 3. Edit metadata and artwork

Select a song to open its details, edit the fields and **Save**. Select several songs for bulk editing, or open an album to edit it as a whole. Use **Choose Image…** for artwork. Edits are saved in WaveMint first; songs with unsaved file changes show **Write to File…**, which writes them after a verified backup (only for formats WaveMint can tag: MP3, M4A/AAC, ALAC and FLAC).

### 4. Trim or fade a song

Select a song and choose **Edit Audio…**. Drag the handles to trim, set fade-in and fade-out lengths, preview, and save. The edited audio becomes the song's new version; the previous one is kept and the edit can be undone from **History**.

### 5. Upgrade a song

1. Select the song and choose **Upgrade Track…**.
2. Choose **Choose File** to pick a replacement from your computer, or **Analyze URL**, paste a video link, **Analyze**, then **Extract for Comparison**.
3. Compare the quality, listen to both, and adjust the prefilled metadata and the artwork (**Current**, **Source**, **Custom** or **None**). Detected details are never applied automatically; **Use Detected Metadata…** lets you pick fields to take.
4. Click **Upgrade Track**. The new file is written with your details into the WaveMint Library; the old file is kept and the upgrade can be undone from **History**.

### 6. Keep things tidy

Check **Review** for metadata problems, **Merge & Duplicates** for songs found in several folders, **Quality & Upgrades** for files worth replacing, and **Storage** for disk usage.

## YouTube access and optional sign-in

Public videos work without any setup. Some videos (age-restricted, members-only, or private videos shared with you) need a signed-in account; WaveMint says when that's the case. Signing in can help with those videos, but it doesn't guarantee access or lift YouTube's rate limits.

**Settings → YouTube Access → Advanced Authentication** offers:

| Method | How it works |
|---|---|
| **Off** (default) | No cookies are used. |
| **Browser Cookies** | yt-dlp reads your YouTube sign-in from a browser profile on this PC (Chrome, Edge, Firefox, Brave, Opera, Vivaldi, Chromium, Whale). |
| **Cookies File** | A `cookies.txt` file (Netscape format) you exported from your browser. |

**Test Authentication** makes one small request (nothing is downloaded) and reports separately whether the cookies could be read and whether YouTube accepted them as a signed-in session.

> [!WARNING]
> Recent Chromium-based browsers on Windows protect cookies with app-bound encryption and lock them while the browser is open. If the test says the cookies couldn't be accessed, close the browser completely and retry, or use a cookies file. WaveMint does not try to bypass these protections.

A cookies file is as sensitive as a password: it can give access to your Google account. Keep it private and delete it when you no longer need it. WaveMint stores only the file's location, never cookie values; yt-dlp may update the file with refreshed cookies.

## Keeping extraction working

YouTube changes frequently, and extraction sometimes needs a newer yt-dlp. **Settings → Extraction Engine → Check for Updates** finds the latest official release; **Install** downloads it, verifies its signature and checksum, tests it, and switches to it. **Use Built-in Version** and a button to return to the previous version are always available. By default WaveMint checks quietly at most once a day and never installs anything on its own; you can turn the check off.

Extraction from YouTube is never guaranteed to work: YouTube can change or restrict access at any time, and a fix can take days to appear.

## Troubleshooting

<details>
<summary><b>"Some of WaveMint's built-in components could not be started"</b></summary>

A bundled tool is missing or was blocked, often by antivirus software. Restore or allow it, or reinstall WaveMint. In a source checkout, run `npm run binaries:fetch`.
</details>

<details>
<summary><b>"Paste the web address of a video or playlist"</b></summary>

The text isn't a web link WaveMint can analyze (for example a local file path). Paste the link from the browser's address bar.
</details>

<details>
<summary><b>The video is unavailable, private or region-locked</b></summary>

These are final for that video. For private or age-restricted videos, set up [sign-in](#youtube-access-and-optional-sign-in) with an account that has access.
</details>

<details>
<summary><b>"YouTube temporarily rate-limited this session"</b></summary>

YouTube is throttling requests from your connection. WaveMint pauses analysis and extraction for up to an hour and shows how long is left.
</details>

<details>
<summary><b>"YouTube refused to send the audio" / "extraction components may need an update"</b></summary>

WaveMint already tried the safe alternatives. Use **Check for Updates** in the message (or Settings → Extraction Engine), install the newest engine, and try again.
</details>

<details>
<summary><b>A file can't be tagged, edited or upgraded</b></summary>

- WAV and AIFF files are read and played, but WaveMint doesn't write tags into them.
- Files in a read-only source keep their tags; your edits stay in WaveMint and are written into copies (WaveMint Library, Prepare for iPhone).
- "In use" or permission errors: close other apps using the file (media players, tag editors, cloud-sync tools) and check that the folder isn't read-only. Failed operations leave the original file unchanged.
</details>

<details>
<summary><b>An upgrade or edit failed</b></summary>

The song keeps its current file: replacements are prepared and verified before anything moves, and a failure rolls back. If WaveMint was closed mid-operation, it finishes or rolls back the operation at the next start.
</details>

<details>
<summary><b>Reporting a problem</b></summary>

Click **Details** in the error, then **Copy Error Details**, and include that in your report. Cookies, sign-in tokens, signed media URLs and your Windows user folder are removed from these details.
</details>

### Apple Music and iTunes

WaveMint never writes to Apple's library database. Apple Music and iTunes keep their own copy of each song's details and point at specific files. If you edit or upgrade a song that lives in your iTunes folder, Apple Music keeps showing (and playing) the old file and details until you update or re-add the song there. **Prepare for iPhone** lists replaced and changed songs in its report so you know what to refresh.

## Privacy and your data

WaveMint has no accounts, analytics, telemetry or crash reporting.

**Stored on your computer**

| What | Where |
|---|---|
| Library database: song details, file paths, playlists, history, settings | `%APPDATA%\WaveMint\library\` |
| Artwork store, caches, verified backups of files before tag writes, previous versions | `%APPDATA%\WaveMint\library\` and your WaveMint Library's `.wavemint-archive` folder |
| App settings: YouTube access method, chosen browser and profile, the cookies file's **location**, engine preferences (never cookie values) | `%APPDATA%\WaveMint\settings.json` |
| Updated yt-dlp versions, yt-dlp's cache | `%APPDATA%\WaveMint\engine\`, `%APPDATA%\WaveMint\yt-dlp-cache\` |
| Player preferences (volume, shuffle, column widths) | the app's local browser storage |

Error details are kept in memory only (the last 25), sanitized, and shared only if you copy them. Logs go to the console and aren't written to files.

**Network connections**

| Service | When | What's sent |
|---|---|---|
| YouTube / Google (through yt-dlp) and thumbnail servers | When you analyze or extract a link, or test sign-in | The link; with sign-in turned on, your YouTube cookies (read locally by yt-dlp) |
| GitHub | Engine update checks (at most daily, can be turned off) and installs | Standard requests for yt-dlp's release information and files |
| MusicBrainz and Cover Art Archive | Only if you turn on Identify | Song and album details you look up, with an app identifier as required by MusicBrainz |

Third-party services handle these requests under their own privacy policies.

## Building from source

**Prerequisites:** Windows 10/11 x64, [Node.js](https://nodejs.org/) 24 or newer (npm included), and Git.

```powershell
git clone https://github.com/cocampo1005/wavemint.git
cd wavemint
npm install
npm run binaries:fetch   # downloads the pinned yt-dlp, Deno and FFmpeg into resources/bin and verifies them
npm start                # Vite dev server + Electron, with hot reload
```

| Command | Description |
|---|---|
| `npm start` | Dev server (`http://localhost:5173`) and Electron together |
| `npm run dev` / `npm run electron` | The two halves separately |
| `npm run build` | Build the UI into `dist/` |
| `npm run lint` | ESLint (UI, main process, scripts, tests) |
| `npm test` | All tests (`node --test`) |
| `npm run binaries:fetch` / `binaries:verify` | Fetch or re-verify the pinned tools |
| `npm run binaries:check-updates` | Show newer upstream tool versions (`-- --write` updates the pins) |
| `npm run check:release` | Release safety checks on the build inputs |
| `npm run pack:win` | Unpacked app in `release/<version>/win-unpacked/` |
| `npm run dist:win` | Installer `release/<version>/WaveMint-Setup-<version>.exe` |
| `npm run icon` | Regenerate `build/icon.ico` from the logo |

**Development notes**

- Without `npm run binaries:fetch`, development falls back to `yt-dlp`, `ffmpeg`, `ffprobe` and `deno` on your `PATH`; `WAVEMINT_USE_SYSTEM_BINARIES=1` forces that.
- Development uses `%APPDATA%\WaveMint-Dev`, separate from an installed copy. `--user-data-dir=<folder>` overrides it (handy for testing with a throwaway profile).
- `WAVEMINT_RENDERER=dist` makes Electron load the built `dist/` instead of the dev server.
- If Electron starts as plain Node, unset `ELECTRON_RUN_AS_NODE` (some editors set it).

## Architecture

WaveMint is an Electron app with a strict split between the sandboxed React UI and the privileged main process:

```
React UI (src/)                       sandboxed, no Node access, strict CSP
   │  window.waveMintAPI (electron/preload.cjs): an explicit allowlist
   ▼
Main process (electron/)              every handler rejects other pages (ipc/trustedIpc.cjs)
   ├─ ipc/extractionHandlers.cjs      analyze, extract, previews, cancel (per request id)
   │     ├─ youtubeMetadata.cjs       yt-dlp JSON → song details and thumbnails (pure)
   │     └─ songExtraction.cjs        URL → tagged MP3: extraction.cjs (yt-dlp, retries,
   │                                  rate limits), artwork.cjs (download, square crop), FFmpeg
   ├─ ipc/engineHandlers.cjs          verified yt-dlp updates (engine.cjs, pgp.cjs)
   ├─ ipc/authHandlers.cjs            YouTube sign-in options (auth.cjs, settings.cjs)
   └─ library/host.cjs                schema-validated library API, dialogs, media protocols
         │  worker thread
         ▼
   library/worker.cjs + service.cjs   SQLite (node:sqlite) and the library's domain modules:
                                      scanner, edits/fileops, merge, consolidate, upgrade,
                                      audioedit, playlists, exporter, identify, storage…
```

Key decisions:

- **Security boundary.** The renderer never receives file paths or runs commands. Files and folders are chosen in main-process dialogs; songs are referred to by database ids and served through custom `wavemint-media://` and `wavemint-art://` protocols. Renderer input is validated against schemas; IPC senders are checked; external processes run with argument arrays, never a shell; browser permissions are denied except fullscreen.
- **File safety.** Every change to a music file is a journaled operation: copy to a temporary file, verify (SHA-256, tags read back, audio stream unchanged), then move into place. Interrupted operations are finished or rolled back at the next start, and History undoes them.
- **One extraction path.** All yt-dlp runs go through `extraction.cjs`, which classifies failures and applies a deliberately conservative retry policy (a pure, tested function). Analysis, extraction, album imports and Upgrade Track share it.
- **Off the main thread.** The library runs in a worker thread so scans of large collections never block the UI. The renderer has no state library: a player context, small hooks and paged, virtualized lists.
- **Tools are pinned.** Bundled binaries are pinned by SHA-256 to upstream checksums, and the release check fails the build if anything credential-like or unpinned would ship.

More detail: [`docs/ENGINEERING.md`](docs/ENGINEERING.md) (extraction, engine updates, evaluations), [`docs/LIBRARY.md`](docs/LIBRARY.md) (library design, data model, safety model) and [`CLAUDE.md`](CLAUDE.md) (a module-by-module map).

## Testing

`npm test` runs the whole suite with Node's built-in test runner; no extra framework. Tests build synthetic music libraries in temporary folders (never a real library) and cover metadata parsing and resolution, artwork crop and download rules, extraction arguments and the retry policy, IPC validation and sender checks, request-scoped cancellation, tag writing with verification, upgrades with rollback and undo, imports, merging, playlists, storage cleanup, the player queue and the visualizer model. Tests that need FFmpeg run when the tools have been fetched. Network services are replaced by fakes; no test downloads from YouTube.

## Releasing

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on a version tag (`v1.2.3`, matching `package.json`): it fetches and verifies the tools, runs lint and tests, builds the installer, and creates a **draft** GitHub Release with the installer, its blockmap, `SHA256SUMS.txt` and the FFmpeg source archive (for the LGPL). Test the draft with [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) before publishing.

Installers are unsigned. To sign them, add a code-signing certificate (or Azure Trusted Signing) to electron-builder, and sign only WaveMint's own executables: the bundled third-party tools must stay byte-identical to their pinned hashes, which the release check enforces.

---

## Responsible use and copyright

WaveMint is intended for lawful management and processing of your own music collection.

- Only access, download, copy, convert or modify media when you have the rights or permission to do so. Music, videos, artwork and other content remain the property of their respective rights holders, and WaveMint grants no license to any third-party content.
- Content being available on a streaming or video platform doesn't mean downloading or converting it is permitted. Platforms' terms of service (including YouTube's) may restrict downloading, and the law differs between countries. You are responsible for complying with the laws and terms that apply to you.
- WaveMint is not designed or intended to circumvent technical protection measures, and must not be used to access protected services without authorization, to infringe copyright, or to redistribute content without permission.

## Third-party software and non-affiliation

WaveMint builds on [Electron](https://www.electronjs.org/), [React](https://react.dev/), [Vite](https://vite.dev/), [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Deno](https://deno.com/), [FFmpeg](https://ffmpeg.org/) (LGPL build), [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) and the [Poppins](https://github.com/itfoundry/Poppins) typeface, and can use [MusicBrainz](https://musicbrainz.org/) and the [Cover Art Archive](https://coverartarchive.org/). Each is distributed under its own license; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). License texts are installed in `resources\licenses\` and `resources\bin\licenses\`.

WaveMint is an independent project. It is not affiliated with, sponsored or endorsed by YouTube, Google, Apple, MusicBrainz or any other platform or service it works with, or by the authors of the software it uses. Product names and trademarks belong to their owners. Third-party services can change their interfaces, policies or availability at any time, so features that depend on them may stop working. Using a particular tool does not make downloading or converting any content lawful.

## Disclaimer of warranty and limitation of liability

WaveMint is provided **"as is"**, without warranty of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose and non-infringement.

Although WaveMint is designed to protect your files (verified copies, backups, journaled and undoable operations), software can fail. Possible problems include corrupted or replaced audio files, lost or incorrect metadata, library and Apple Music/iTunes synchronization differences, unsupported formats, crashes, and failed downloads or conversions, including failures of third-party services. **Keep backups of your music library before large operations** such as writing tags, consolidating, upgrading or deleting files.

To the extent permitted by applicable law, the author and contributors are not liable for any damages or losses arising from the use of, or inability to use, WaveMint. Some jurisdictions don't allow certain warranty exclusions or liability limitations, so parts of this section may not apply to you.

## License

No license has been chosen for WaveMint yet, so there is no `LICENSE` file. Until one is added, the source code is copyright © 2026 Christian Ocampo, all rights reserved: you may view it on GitHub, but no other rights are granted. The third-party components WaveMint includes are covered by their own licenses (see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).
