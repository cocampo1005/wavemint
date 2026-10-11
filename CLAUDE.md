# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WaveMint is an Electron + React (Vite) desktop app for Windows, distributed as a standalone NSIS installer. It analyzes YouTube video/playlist URLs, lets the user edit ID3 metadata (title/artist/album/genre) and pick artwork, then extracts audio to MP3 with embedded cover art and tags. yt-dlp, Deno (yt-dlp's JavaScript runtime for YouTube challenges), FFmpeg and FFprobe are bundled with the installer.

## Commands

- `npm start`: Vite dev server (`http://localhost:5173`) + Electron. The normal way to run locally.
- `npm run dev` / `npm run electron`: the two halves separately.
- `npm run build`: renderer production build into `dist/`.
- `npm run lint`: ESLint (renderer, `electron/*.cjs`, scripts, tests).
- `npm test`: `node --test "tests/*.test.*"`. No extra test framework. The binaries integration test is skipped unless the tools have been fetched.
- `npm run binaries:fetch`: downloads the pinned yt-dlp/Deno/FFmpeg from `scripts/binaries.manifest.json` into `resources/bin/win32-x64/` (gitignored), verifying SHA-256.
- `npm run pack:win` / `npm run dist:win`: unpacked app / NSIS installer in `release/<version>/`. Both run build → binaries:fetch → check:release first.

Electron must not run with `ELECTRON_RUN_AS_NODE` set (some tool environments set it); unset it when launching Electron from scripts.

## Architecture

Two-process Electron app with a hard split between privileged logic and UI:

- **`electron/main.cjs`**: main process and IPC handlers (`analyze-url`, `download-mp3`, `choose-output-folder`, `choose-artwork-file`, `generate-square-crop-preview`, `open-file`, `open-folder`, `get-app-status`, `auth-*`). Metadata/artwork helpers live above the handlers. Loads the dev server when unpacked, `dist/index.html` when `app.isPackaged`.
- **`electron/binaries.cjs`**: the only place tool paths are decided. Packaged: always `process.resourcesPath/bin`. Dev: `resources/bin/<platform>-<arch>` if fetched, else PATH (`WAVEMINT_USE_SYSTEM_BINARIES=1` forces PATH). `getYtDlpRuntimeArgs()` adds `--ignore-config`, the bundled Deno (`--no-js-runtimes --js-runtimes deno:<path>`) and `--ffmpeg-location`. Also the startup dependency check.
- **`electron/processes.cjs`**: `runCommand()` spawns with argument arrays (never a shell), hidden windows, line-buffered output, timeouts, and process-tree cleanup on quit. `main.cjs`'s `runProcess(tool, args)` wraps it with yt-dlp error normalization and rate-limit tracking.
- **`electron/auth.cjs`**: YouTube auth modes (`none` | `browser` | `cookies_file`), browser allowlist and profile discovery, `cookies.txt` validation (never returns cookie values), `buildYtDlpAuthArgs()`, error classification for yt-dlp cookie failures, and `redactSensitiveText()` for any tool output before it's logged or shown.
- **`electron/settings.cjs`**: validated JSON settings in `userData/settings.json` (`%APPDATA%\WaveMint`; dev uses `WaveMint-Dev`). Stores paths and choices only, never cookie values.
- **`electron/preload.cjs`**: the only renderer bridge (`window.waveMintAPI`). New main-process capabilities must be wired here. Cookies-file/profile/output-folder paths are always chosen via main-process dialogs.
- **`src/App.jsx`**: the main UI (no router/state library). Styles are CSS classes in `src/App.css` with tokens in `src/index.css`. **`src/SettingsDialog.jsx`**: Settings → YouTube Authentication. **`src/ipcErrors.js`**: strips Electron's IPC error wrapper and reads WaveMint's `[auth]`/`[rate-limit]`/`[dependency]` error tags (created by `createUserError` in `main.cjs`).

### Key flows (span both processes)

1. **Analyze**: `waveMintAPI.analyzeUrl({ url, mode })` → `yt-dlp --dump-single-json` (playlists use `--flat-playlist`) → `getExtractedMetadata` / `extractYouTubeMusicDescriptionMetadata` → video or playlist shape.
2. **Artwork**: `original_thumbnail`, `square_crop`, `custom_file` (`ARTWORK_OPTIONS` in App.jsx and `ARTWORK_MODES` in main.cjs must stay in sync). Previews come back as data URLs from FFmpeg in main.
3. **Download**: `download-mp3` runs yt-dlp with `--write-info-json`, merges user edits with extracted info (`resolveFinalMetadata`), prepares artwork, then tags with FFmpeg. On HTTP 403 the fallback ladder is: configured auth → (only if auth configured) no auth → `mweb` client.
4. **Authentication**: `getYtDlpAuthArgs()` in main.cjs is the single source of auth args for analyze, download and retries. Misconfiguration throws an `[auth]` error instead of silently dropping auth. The Settings "Test Authentication" probe requests the Watch Later list (`--flat-playlist --playlist-items 1`), which only resolves for a signed-in session. Note that yt-dlp rewrites a `--cookies` file in place after each run.
5. **Rate limiting**: module-level `youtubeRateLimitedUntil` cooldown; `assertYouTubeSessionIsAvailable` blocks analyze/download/auth-test. Pacing flags are always passed.

Prefer editing helper functions in `main.cjs` over duplicating metadata/artwork logic in the renderer. Artwork cropping, FFmpeg processing and metadata embedding have been debugged extensively; change them only for a concrete reason.

### Packaging

`electron-builder.yml`: only `dist/`, `electron/`, `package.json` go into `app.asar`. Bundled tools are `extraResources` → `resources/bin`. `afterPack` runs `scripts/check-release.cjs`, which fails the build on credential-like files/contents or unpinned/modified tools. `build/installer.nsh` adds the optional desktop-shortcut checkbox and cleans up on uninstall. Never add cookie files or personal paths to the repo; the release check will fail the build.
