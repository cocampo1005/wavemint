# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WaveMint is an Electron + React (Vite) desktop app for Windows, distributed as a standalone NSIS installer. It is a local music library manager (it opens on the library) whose **Add Music** workspace analyzes YouTube video/playlist URLs, lets the user edit ID3 metadata (title/artist/album/genre) and pick artwork, then extracts audio to MP3 with embedded cover art and tags and adds it to the WaveMint Library. A built-in audio editor trims and fades songs (library songs, and new songs before they're added). yt-dlp, Deno (yt-dlp's JavaScript runtime for YouTube challenges), FFmpeg and FFprobe are bundled with the installer.

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

- **`electron/main.cjs`**: main process and IPC handlers (`analyze-url`, `download-mp3`, `cancel-operations`, `choose-artwork-file`, `generate-square-crop-preview`, `get-app-status`, `get-error-details`, `copy-error-details`, `engine-*`, `auth-*`). Metadata/artwork helpers live above the handlers. Loads the dev server when unpacked, `dist/index.html` when `app.isPackaged`.
- **`electron/extraction.cjs`**: the extraction manager, the only code that runs yt-dlp for analysis/downloads. Builds commands (`buildAnalyzeArgs`, `buildDownloadArgs`), adds auth args, runs with cancellation/timeouts, classifies failures, applies the retry policy (`decideNextAttempt`), owns the rate-limit cooldown and records diagnostics. `runTool()` is also used for FFmpeg/FFprobe and the auth probe (it counts running yt-dlp jobs for `isBusy()`).
- **`electron/errors.cjs`**: failure categories (`CATEGORIES`), plain-language messages, allowed UI actions, and `ExtractionError`, whose message carries a `[category:diagnosticsId]` tag. `CATEGORY_ACTIONS` is mirrored in `src/ipcErrors.js` (a test checks they match).
- **`electron/diagnostics.cjs`**: sanitized technical details (last 25 failures, in memory) for the UI's Details / Copy Error Details. `sanitizeDiagnosticText()` strips cookies, tokens, signed URLs, credential headers and the home folder.
- **`electron/engine.cjs`** + **`electron/pgp.cjs`**: in-app yt-dlp updates in `userData/engine/versions/<v>/`. `SHA2-256SUMS` must be signed by yt-dlp's key (pinned by fingerprint, `electron/trust/`), the exe must match it and pass an offline `yt-dlp -v` self-test (version, bundled Deno, EJS). Activation switches `state.json` atomically; previous version kept for rollback; no downgrades; the bundled copy is always the fallback.
- **`electron/binaries.cjs`**: the only place tool paths are decided. Packaged: always `process.resourcesPath/bin`. Dev: `resources/bin/<platform>-<arch>` if fetched, else PATH (`WAVEMINT_USE_SYSTEM_BINARIES=1` forces PATH). yt-dlp resolves to an active verified update first (`setYtDlpOverride`). `getYtDlpRuntimeArgs()` adds `--ignore-config --no-plugin-dirs`, the bundled Deno (`--no-js-runtimes --js-runtimes deno:<path>`), `--ffmpeg-location` and `--cache-dir`. Also the startup dependency check (for yt-dlp: `selfTestYtDlp`, which confirms Deno and EJS are seen).
- **`electron/processes.cjs`**: `runCommand()` spawns with argument arrays (never a shell), hidden windows, line-buffered output, timeouts, `signal` cancellation, and process-tree cleanup on quit. `main.cjs`'s `runProcess(tool, args)` wraps `extraction.runTool` for FFmpeg/FFprobe with short error messages.
- **`electron/auth.cjs`**: YouTube auth modes (`none` | `browser` | `cookies_file`), browser allowlist and profile discovery, `cookies.txt` validation (never returns cookie values), `buildYtDlpAuthArgs()`, error classification for yt-dlp cookie failures, and `redactSensitiveText()` for any tool output before it's logged or shown.
- **`electron/settings.cjs`**: validated JSON settings in `userData/settings.json` (`%APPDATA%\WaveMint`; dev uses `WaveMint-Dev`). Stores paths and choices only, never cookie values.
- **`electron/preload.cjs`**: the only renderer bridge (`window.waveMintAPI`). New main-process capabilities must be wired here. Cookies-file/profile/output-folder paths are always chosen via main-process dialogs.
- **`src/App.jsx`**: the app shell (no router/state library): `AppNav.jsx` sidebar (Add Music, library sections, Settings), the route and library job state, and both workspaces kept mounted (Library, Add Music). **`src/player/`**: the one music player (`PlayerProvider` owns the single `<audio>`; `queue.js` is the pure queue/shuffle/repeat model; `PlayerBar`, `QueuePanel`, `ListenMode` are views of it; use `usePlayer()`; Listen Mode's visualizer is `ArtworkVisualizer.jsx` drawing the pure model in `visualizer.js` from the player's one analyser). Missing or failed artwork always renders through `src/library/Artwork.jsx` (the shared placeholder, `placeholder.js`; display only, never written into files). **`src/addMusic/`**: the extraction workspace (`AddMusicView.jsx`; `parts.jsx` components, `extraction.js` helpers). **`src/editor/`**: `AudioEditor.jsx` (shared by the library and Add Music) and `editMath.js` (pure trim/fade helpers). Styles are CSS classes in `src/App.css` with tokens in `src/index.css`. **`src/SettingsDialog.jsx`**: Settings → YouTube Access (automatic by default; Advanced Authentication collapsed), Extraction Engine, About. **`src/ipcErrors.js`**: strips Electron's IPC error wrapper (including the error class name), reads `[code]` / `[code:diagnosticsId]` tags, maps codes to UI actions and decides which batch failures are skippable.

### Key flows (span both processes)

1. **Analyze**: `waveMintAPI.analyzeUrl({ url, mode })` → `extraction.analyze` (`yt-dlp --dump-single-json`, playlists `--flat-playlist`) → `getExtractedMetadata` / `extractYouTubeMusicDescriptionMetadata` → video or playlist shape. Results are cached per URL+mode+auth fingerprint for 15 minutes.
2. **Artwork**: `original_thumbnail`, `square_crop`, `custom_file` (`ARTWORK_OPTIONS` in App.jsx and `ARTWORK_MODES` in main.cjs must stay in sync). Previews come back as data URLs from FFmpeg in main.
3. **Download**: `download-mp3` → `extraction.download` (yt-dlp with `--write-info-json`) in a private work folder under `%TEMP%WaveMint<token>` (only the finished, tagged MP3 is moved out, by `moveIntoOutputFolder` in `outputFiles.cjs`, into a library staging folder: the album import's session folder when `importSessionId` is given, otherwise a one-song folder from `prepareExtractionStaging` that is added to the library with `commitStagedExtraction`, or kept for the editor when `holdForEditing`, or handed to Upgrade Track as a replacement candidate when `upgradeTrackId` is given), merges user edits with extracted info (`resolveFinalMetadata`), prepares artwork, then tags with FFmpeg. Progress is sent as `{ phase, percent? }` (labels live in App.jsx; only `downloading` has a real percentage). Retry policy: transient network failures up to 2 retries (only if the attempt failed within 15 s); HTTP 403 ladder configured auth → (only if auth configured) no auth → `mweb` client; everything else stops; max 4 runs.
4. **Authentication**: `buildYtDlpAuthArgs` via the extraction manager is the single source of auth args for analyze, download and retries. Misconfiguration throws an `auth-unavailable` error instead of silently dropping auth. The Settings "Test Authentication" probe requests the Watch Later list (`--flat-playlist --playlist-items 1`), which only resolves for a signed-in session. Note that yt-dlp rewrites a `--cookies` file in place after each run.
5. **Rate limiting**: the extraction manager's one-hour cooldown (`markRateLimited` / `assertAvailable`) blocks analyze/download/auth-test. Pacing flags are always passed.
6. **Engine updates**: Settings → Extraction Engine → `engine-check` / `engine-install` / `engine-use-bundled` / `engine-rollback`. Never modify `resources/bin` at runtime. Background check at most daily, never installs.

Design notes, measured baseline and the PO Token / YouTube.js evaluations (both deliberately not integrated) are in `docs/ENGINEERING.md`.

Prefer editing helper functions in `main.cjs` over duplicating metadata/artwork logic in the renderer. Artwork cropping, FFmpeg processing and metadata embedding have been debugged extensively; change them only for a concrete reason.

### Library (WaveMint 2.0)

The library is the main workspace (the app opens on it). Design, data model, safety model and per-phase notes: `docs/LIBRARY.md`.

- **`electron/library/host.cjs`** (main process): starts **`worker.cjs`** (a worker thread that owns the SQLite database via `node:sqlite`), exposes one allowlisted, schema-validated IPC channel (`library`, `WORKER_METHODS`), runs every file/folder dialog (`HOST_METHOD_NAMES`) and serves `wavemint-media://` / `wavemint-art://`. The renderer never sends paths or SQL; `preload.cjs`'s `LIBRARY_METHODS` must match (a test checks).
- **`storage.cjs`**: disk usage report and cleanup plan (retention of previous versions and Write Tags backups, cache bounds, unused artwork). The main process executes plans (`cleanUpStorage` host method, `isInsideRoots` guard, Recycle Bin for audio) and runs it at most daily (`startStorageMaintenance`).
- **`removal.cjs`**: Remove from Library (undoable, files untouched) and Delete File (the host method `deleteTrackFiles` moves the planned files to the Recycle Bin, then `finishFileDeletion`).
- **`audioedit.cjs`**: trim/fade rendering (stream copy for plain lossy trims, re-encode for fades), editing a library song as a new active version through Upgrade Track (`purpose: "edit"`), and adding staged extractions to the library.
- **`service.cjs`** wires the domain modules: `scanner` (read-only scans), `edits`/`fileops` (metadata, verified tag writes), `genres`, `review`, `match`/`merge`, `consolidate`/`organize` (Managed Library), `quality`/`upgrade`, `identify`/`musicbrainz`/`webclient` (opt-in online lookups), `importer` (playlist import via staging; `download-mp3` with `importSessionId`), `playlists`, `exporter` (Prepare for iPhone). Schema changes go in `migrations.cjs` (new versions only; a backup is taken before migrating).
- Safety rules: sources are read-only unless the user allows writing; file changes are staged, verified and journaled (`operations`/`operation_steps`, recovered at worker start) and undoable from History; nothing in a source is ever moved or deleted. Tests build synthetic libraries in temp folders (`tests/library-fixtures.cjs`); never point tests at a real music library.

### Packaging

`electron-builder.yml`: only `dist/`, `electron/`, `package.json` go into `app.asar`. Bundled tools are `extraResources` → `resources/bin`. `afterPack` runs `scripts/check-release.cjs`, which fails the build on credential-like files/contents or unpinned/modified tools. `build/installer.nsh` adds the optional desktop-shortcut checkbox and cleans up on uninstall. Never add cookie files or personal paths to the repo; the release check will fail the build.
