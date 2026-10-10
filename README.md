<div align="center">

<img src="src/assets/Horizontal%20Logo.png" alt="WaveMint" width="420" />

### Turn YouTube videos and playlists into clean, tagged MP3s.

Paste a link, review the metadata, pick your cover art, and extract. WaveMint handles the rest.

![Platform](https://img.shields.io/badge/platform-Windows-4A8DFF?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-41-1FC8FF?style=flat-square&logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-8A5CFF?style=flat-square&logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-4A8DFF?style=flat-square&logo=vite&logoColor=white)

</div>

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running WaveMint](#running-wavemint)
- [Using WaveMint](#using-wavemint)
- [Optional: YouTube cookies](#optional-youtube-cookies)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Troubleshooting](#troubleshooting)

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
| 🛡️ **Rate-limit aware** | Requests are paced automatically, and WaveMint pauses itself if YouTube rate-limits the session. |

## How it works

WaveMint is an Electron desktop app with a React interface. The heavy lifting is done by two well-known command-line tools that run in the background:

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** reads video/playlist information and downloads the audio.
- **[FFmpeg](https://ffmpeg.org/)** converts audio, prepares artwork, and writes the final tagged MP3.

These tools are **not bundled** with WaveMint, so you'll install them once as part of setup.

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Windows** | 10 or 11 | WaveMint is built and tested for Windows. |
| **[Node.js](https://nodejs.org/)** | 20.19+ or 22.12+ (LTS recommended) | Runs the build tools and Electron. |
| **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** | Latest | Fetches video info and audio. |
| **[FFmpeg](https://ffmpeg.org/)** (includes `ffprobe`) | Any recent build | Audio conversion, artwork, and tagging. |

> [!IMPORTANT]
> `yt-dlp`, `ffmpeg`, and `ffprobe` must be available on your system **PATH**. If they aren't, the Analyze and Extract buttons will fail.

---

## Installation

### 1. Install Node.js, yt-dlp, and FFmpeg

The quickest way on Windows is **winget**, which is built into Windows 10/11. Open **PowerShell** and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

<details>
<summary><b>Prefer to install manually?</b></summary>

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
2. Download `yt-dlp.exe` from the [yt-dlp releases page](https://github.com/yt-dlp/yt-dlp/releases/latest).
3. Download a Windows FFmpeg build (for example from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)) and extract it.
4. Put `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe` in one folder (e.g. `C:\Tools`).
5. Add that folder to your PATH: **Start → "Edit the system environment variables" → Environment Variables → Path → Edit → New**, then paste the folder path.

</details>

**Close and reopen your terminal**, then confirm everything is found:

```powershell
node --version
yt-dlp --version
ffmpeg -version
ffprobe -version
```

Each command should print a version number. If you see *"is not recognized"*, that tool isn't on your PATH yet.

### 2. Get the project

Clone the repository (or download and extract the ZIP):

```powershell
git clone <repository-url> WaveMint
cd WaveMint
```

### 3. Install dependencies

```powershell
npm install
```

This installs React, Vite, Electron, and the bundled Poppins font.

---

## Running WaveMint

Start the app with:

```powershell
npm start
```

This starts the Vite dev server at `http://localhost:5173` and opens the WaveMint window. Leave the terminal open while you use the app; press `Ctrl + C` in it to shut everything down.

<details>
<summary><b>Running the two parts separately</b></summary>

If you'd rather control each process yourself, use two terminals:

```powershell
# Terminal 1: the interface
npm run dev

# Terminal 2: the desktop window (once the dev server is up)
npm run electron
```

</details>

> [!NOTE]
> WaveMint currently runs from the dev server. There is no packaged installer (`.exe`) yet.

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

---

## Optional: YouTube cookies

Some videos are age-restricted, members-only, or private, and need a signed-in YouTube session. WaveMint can use a **cookies file** for this.

1. While signed in to YouTube in your browser, export your cookies in **Netscape `cookies.txt` format** (a browser extension such as *"Get cookies.txt LOCALLY"* works well).
2. Save the file as:

   ```
   D:\yt-dlp\cookies.txt
   ```

3. Restart WaveMint.

If the file isn't there, WaveMint simply continues without it. Public videos work fine either way.

To use a different location, change `YT_DLP_COOKIES_PATH` near the top of [`electron/main.cjs`](electron/main.cjs).

> [!CAUTION]
> A cookies file grants access to your YouTube/Google account. Keep it private and never commit it to version control.

---

## Project structure

```
WaveMint/
├── electron/
│   ├── main.cjs        # Main process: yt-dlp/FFmpeg, metadata, artwork, IPC handlers
│   ├── preload.cjs     # Secure bridge exposing window.waveMintAPI to the UI
│   └── assets/icon.png # App / taskbar icon
├── src/
│   ├── App.jsx         # The entire interface (single-video + playlist flows)
│   ├── App.css         # Component styles
│   ├── index.css       # Design tokens (colors, type, spacing) and base styles
│   ├── constants/      # Genre list
│   └── assets/         # WaveMint logos
├── index.html
├── vite.config.js
└── package.json
```

The UI never touches the file system or runs commands directly. Everything goes through `window.waveMintAPI` (defined in `preload.cjs`), which calls handlers in `main.cjs`.

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Run the dev server and Electron together (the usual way to run the app). |
| `npm run dev` | Start only the Vite dev server on `http://localhost:5173`. |
| `npm run electron` | Launch only the Electron window (requires the dev server to be running). |
| `npm run build` | Build the interface for production into `dist/`. |
| `npm run preview` | Preview the production build in a browser. |
| `npm run lint` | Run ESLint across the project. |

---

## Troubleshooting

<details>
<summary><b>"yt-dlp" / "ffmpeg" is not recognized, or Analyze fails immediately</b></summary>

The tool isn't on your PATH. Re-check [step 1](#1-install-nodejs-yt-dlp-and-ffmpeg), then **fully close and reopen** your terminal (and VS Code, if you launch from there) so it picks up the updated PATH.

</details>

<details>
<summary><b>The window is blank or says it can't connect</b></summary>

Electron loads the interface from `http://localhost:5173`. Make sure the dev server is running (`npm start` handles this) and nothing else is using port 5173.

</details>

<details>
<summary><b>"YouTube temporarily rate-limited this WaveMint session"</b></summary>

YouTube has throttled requests from your connection. WaveMint pauses itself for up to an hour and shows how long is left. Wait it out before analyzing or extracting again.

</details>

<details>
<summary><b>Downloads fail with HTTP 403 / "Forbidden"</b></summary>

YouTube changes things often, so update yt-dlp first:

```powershell
winget upgrade yt-dlp.yt-dlp
# or, if installed manually:
yt-dlp -U
```

WaveMint already retries with different strategies automatically. If it keeps failing, refresh your [cookies file](#optional-youtube-cookies).

</details>

<details>
<summary><b>Private or age-restricted videos won't work</b></summary>

These require a signed-in session. Set up a [cookies file](#optional-youtube-cookies) exported from an account that has access, and re-export it if it has expired.

</details>

<details>
<summary><b>Square artwork preview won't generate</b></summary>

Square previews are created with FFmpeg. Confirm `ffmpeg -version` works in a new terminal. You can still choose **Original** or **Custom** artwork in the meantime.

</details>

---

<div align="center">
<img src="src/assets/Logomark.png" alt="" width="56" />
<br />
<sub>Built with Electron, React, yt-dlp, and FFmpeg.</sub>
</div>
