# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WaveMint is an Electron + React (Vite) desktop app for Windows. It analyzes YouTube video/playlist URLs, lets the user edit ID3 metadata (title/artist/album/genre) and pick artwork, then extracts audio to MP3 with embedded cover art and tags.

## Commands

- `npm run dev` — start the Vite dev server on `http://localhost:5173` (renderer only).
- `npm run electron` — launch Electron, which loads `http://localhost:5173` (requires the dev server to already be running).
- `npm start` — runs both of the above concurrently; this is the normal way to run the app locally.
- `npm run build` — production build of the renderer via `vite build` (there is no electron-builder/packaging step configured).
- `npm run lint` — ESLint over the whole repo.
- There is no test suite/framework configured in this repo.

### External binaries required on PATH

The Electron main process shells out to `yt-dlp`, `ffmpeg`, and `ffprobe` via `child_process.spawn`. These are not bundled — they must be installed and on the system `PATH` for analyze/download features to work at all.

`electron/main.cjs` also hardcodes a YouTube cookies file path (`YT_DLP_COOKIES_PATH = "D:\\yt-dlp\\cookies.txt"`) used for authenticated `yt-dlp` requests when present; it's optional (falls back to unauthenticated requests) but affects age-restricted/private video handling.

## Architecture

This is a two-process Electron app with a hard split between privileged logic and UI:

- **`electron/main.cjs`** — the Electron main process. This is where essentially all business logic lives: spawning `yt-dlp`/`ffmpeg`/`ffprobe`, parsing yt-dlp's JSON output, resolving/merging metadata, downloading and preparing artwork, and writing the final tagged MP3. It's a single large file organized by IPC handler at the bottom (`analyze-url`, `download-mp3`, `choose-output-folder`, `choose-artwork-file`, `generate-square-crop-preview`, `open-file`, `open-folder`), with plain helper functions above.
- **`electron/preload.cjs`** — the only bridge between renderer and main. Uses `contextBridge`/`ipcRenderer` (context isolation is on, node integration is off) to expose a single `window.waveMintAPI` object with the methods above plus `onAnalyzeProgress`/`onDownloadProgress` event subscriptions. If you add a new main-process capability, it must be wired through here before the renderer can call it.
- **`src/App.jsx`** — the entire renderer UI in one component tree (no router, no state library — plain `useState`/`useEffect`). Styling is inline style objects, not CSS classes (`src/App.css`/`index.css` are unused Vite template leftovers). Handles both the single-video flow and the playlist flow (an array of `entries`, each with its own metadata/artwork state) in the same component.

### Key flows to understand together (span both processes)

1. **Analyze**: renderer calls `waveMintAPI.analyzeUrl({ url, mode })` → main spawns `yt-dlp --dump-single-json` (playlist mode uses `--flat-playlist` to avoid resolving every entry) → main extracts/normalizes metadata (see `getExtractedMetadata`, `extractYouTubeMusicDescriptionMetadata` which parses the "Provided to YouTube by" description format used by YouTube Music uploads) → returns a video or playlist shape to the renderer, which stores it as `result` (single) or `entries` (playlist).
2. **Artwork**: three modes — `original_thumbnail`, `square_crop`, `custom_file` (see `ARTWORK_OPTIONS` in App.jsx / `ARTWORK_MODES` in main.cjs, which must stay in sync). Square crop and custom-file previews are generated on demand in main via `ffmpeg` and returned as data URLs (`generate-square-crop-preview`, `choose-artwork-file`) so the renderer never touches the filesystem directly.
3. **Download**: `download-mp3` re-runs `yt-dlp` (this time fully, with `--write-info-json` to capture final authoritative metadata) into a temp file, resolves final metadata by merging what the user edited with freshly-extracted info (`resolveFinalMetadata` — user edits win, provisional/auto-filled fields get overwritten by better extracted data), downloads/prepares artwork, then muxes audio + artwork + ID3 tags into the final MP3 with `ffmpeg`. Progress for both analyze and download is streamed back via `analyze-progress`/`download-progress` IPC events parsed from yt-dlp's stdout/stderr.
4. **YouTube rate limiting**: main tracks a module-level `youtubeRateLimitedUntil` cooldown and blocks new `analyze-url`/`download-mp3` calls with a friendly error until it expires (`assertYouTubeSessionIsAvailable`). Pacing flags (`--sleep-requests`, `--sleep-interval`) are always passed to `yt-dlp` to reduce the chance of hitting this. The `download-mp3` handler also has a fallback ladder on HTTP 403 (authenticated → unauthenticated → `mweb` player client).

When changing metadata or artwork logic, prefer editing the helper functions in `main.cjs` rather than duplicating logic in the renderer — the renderer treats `metadata`/artwork fields as mostly opaque state it collects and hands back over IPC.
