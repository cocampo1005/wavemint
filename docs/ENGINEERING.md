# WaveMint engineering notes

How extraction works inside WaveMint, why it is built this way, and what was
measured. For building and releasing see the [README](../README.md) and the
[release checklist](RELEASE_CHECKLIST.md).

## Contents

- [Extraction architecture](#extraction-architecture)
- [Errors and retries](#errors-and-retries)
- [Extraction engine updates](#extraction-engine-updates)
- [YouTube access and authentication](#youtube-access-and-authentication)
- [Deno and EJS](#deno-and-ejs)
- [Baseline and measurements](#baseline-and-measurements)
- [PO Token provider evaluation](#po-token-provider-evaluation)
- [YouTube.js evaluation](#youtubejs-evaluation)
- [Dependency maintenance](#dependency-maintenance)
- [Testing](#testing)

---

## Extraction architecture

```
renderer (src/App.jsx, SettingsDialog.jsx)
   │  window.waveMintAPI  (electron/preload.cjs)
   ▼
main process (electron/main.cjs)
   ├─ analyze-url / download-mp3 / cancel-operations
   │     └─ extraction manager (electron/extraction.cjs)
   │           ├─ command construction (buildAnalyzeArgs / buildDownloadArgs)
   │           ├─ auth arguments (auth.cjs → buildYtDlpAuthArgs)
   │           ├─ runtime arguments + executable (binaries.cjs)
   │           ├─ process runner with cancel/timeout (processes.cjs)
   │           ├─ failure classification (errors.cjs)
   │           ├─ retry policy (decideNextAttempt) and rate-limit cooldown
   │           └─ sanitized diagnostics (diagnostics.cjs)
   ├─ artwork + metadata tagging (unchanged helpers in main.cjs, FFmpeg via the manager's runTool)
   └─ engine-* handlers
         └─ engine store + updater (electron/engine.cjs, electron/pgp.cjs)
```

- **`extraction.cjs`** is the only code that runs yt-dlp for analysis and
  downloads. It owns command construction, the attempt loop, retry decisions,
  the session-wide rate-limit cooldown, progress phases and diagnostics.
  `runTool()` is also used for FFmpeg/FFprobe (artwork, tagging) and for the
  authentication probe, so every child process shares the same resolver,
  hidden windows, cancellation and "is busy" tracking.
- **`errors.cjs`** turns yt-dlp's stderr into a fixed set of categories with
  plain-language messages and allowed UI actions.
- **`diagnostics.cjs`** keeps the last 25 failures (sanitized) in memory. The UI
  only receives a category, a friendly message and a diagnostics id; the
  technical text is fetched on demand ("Details", "Copy Error Details").
- **`binaries.cjs`** decides which executable runs. yt-dlp resolves to a
  validated in-app update when one is active, otherwise to the bundled copy.
  Every yt-dlp run gets `--ignore-config --no-plugin-dirs`, the bundled Deno
  (`--no-js-runtimes --js-runtimes deno:<path>`), `--ffmpeg-location` and a
  WaveMint-owned `--cache-dir`.

Artwork cropping, FFmpeg image processing and metadata embedding were not
changed. Their error messages are now short ("FFmpeg couldn't process the
file.") with the FFmpeg output kept in diagnostics.

### Work folders

Each extraction runs in its own folder under `%TEMP%WaveMint<token>`: yt-dlp's download, `.info.json`, the MP3 conversion, artwork and the tagged result all stay there. Only the finished, tagged MP3 is moved out (`electron/outputFiles.cjs`: a rename on the same drive, otherwise a non-overwriting copy) into a staging folder the library chose, and the work folder is always removed. Since 2.1 there is no output folder: the library copies the finished song into the WaveMint Library (see `docs/LIBRARY.md`, "Library-first app, Add to Library and audio editing"). Leftovers from a crash are removed at startup after 24 hours.

This fixed a real failure: with iTunes' **Automatically Add to iTunes** folder as the output folder, iTunes moved yt-dlp's temporary `.webm` into `Not Added` before FFprobe could read it ("unable to obtain file audio codec with ffprobe"), and would otherwise have imported an untagged temporary MP3. When the output folder is an iTunes/Music auto-add folder, WaveMint now reports "added to iTunes automatically" instead of offering **Open in iTunes** for a file iTunes has already moved.

### Progress phases

The main process sends `{ phase, percent?, reason? }`; the renderer maps phases
to labels. Only phases that really happen are reported:

| Phase | Label | Source |
|---|---|---|
| `analyzing` / `loading-playlist` | Analyzing video… / Loading playlist… | analysis started |
| `waiting` | Pausing briefly to avoid YouTube limits… | yt-dlp `Sleeping N seconds` |
| `preparing` | Preparing audio… | download started |
| `downloading` | Downloading audio… + real % | yt-dlp `[download] N%` |
| `converting` | Extracting audio… | yt-dlp `[ExtractAudio]` |
| `artwork` | Processing artwork… | artwork preparation |
| `metadata` | Writing metadata… | FFmpeg tagging |
| `retrying` | Connection interrupted. Retrying… / Trying another way… | retry policy |

The progress bar is determinate only during `downloading`; everything else uses
an indeterminate bar, so no percentage is ever invented. (Before this change
analysis showed fixed 10/30/60/75 % values.)

### Session caches

- **Analysis results** (titles, thumbnails, editable metadata; never media URLs
  or cookies) are reused for 15 minutes per URL + mode + authentication
  fingerprint. Re-analyzing the same link makes no YouTube request. The cache
  is cleared when the engine or authentication changes.
- **Square artwork previews** are cached per thumbnail URL (up to 300) and
  concurrent requests for the same thumbnail share one FFmpeg run. The
  renderer generates playlist previews four at a time instead of all at once.

---

## Errors and retries

### Categories

| Category (`code`) | Example yt-dlp signal | User message (short) | UI actions |
|---|---|---|---|
| `network-unavailable` | `getaddrinfo failed`, `actively refused`, `Unable to connect to proxy` | WaveMint couldn't connect to YouTube… | Retry |
| `network-timeout` | `timed out`, process timeout | The connection to YouTube timed out… | Retry |
| `server-error` | `HTTP Error 5xx`, connection reset | YouTube had a temporary problem… | Retry |
| `rate-limit` | `current session has been rate-limited`, `HTTP Error 429` | YouTube is temporarily limiting requests… | — (cooldown) |
| `auth-required` | `Sign in to confirm your age`, members-only | This video requires a signed-in YouTube session. | YouTube Access |
| `auth-expired` | `cookies are no longer valid`, sign-in rejected with auth configured | …your sign-in may have expired… | YouTube Access |
| `auth-unavailable` | `Could not copy Chrome cookie database`, missing cookie file | (from `auth.cjs`) | YouTube Access |
| `bot-check` | `Sign in to confirm you're not a bot` (no auth configured) | YouTube asked WaveMint to confirm it isn't a bot… | Retry, YouTube Access |
| `unavailable` | `This video is unavailable`, removed, terminated | This video isn't available for extraction. | — |
| `private` | `Private video`, `The playlist does not exist` | This video is private… | YouTube Access |
| `geo-restricted` | `not available in your country` | This video isn't available in your country. | — |
| `unsupported-url` | `is not a valid URL`, `Unsupported URL` | This doesn't look like a supported YouTube link… | — |
| `extractor-outdated` | `Failed to extract any player response`, `Signature extraction failed`, `Requested format is not available` | …extraction components may need an update. | Check for Updates, Retry |
| `media-forbidden` | `HTTP Error 403` (after the fallback ladder) | YouTube refused to send the audio… | Check for Updates, Retry |
| `dependency` | `No supported JavaScript runtime`, `ffmpeg not found`, tool can't start | One of WaveMint's built-in components isn't working… | — |
| `post-processing` | `Postprocessing:` errors, tagging failure | …couldn't convert it to MP3… | Retry |
| `cancelled` | user pressed Cancel | (not shown) | — |
| `unknown` | anything else | WaveMint couldn't process this video. YouTube reported: … | Retry |

Notes:

- yt-dlp appends "please report this issue … `yt-dlp -U`" to many errors,
  including plain connection failures, so that text never implies an outdated
  extractor. Connectivity is checked first.
- A 403 is only `media-forbidden` when nothing more specific (geo, private,
  sign-in) explains it. WaveMint does not assume every 403 needs a PO Token or
  cookies.
- The category list is mirrored in `src/ipcErrors.js` (`getErrorActions`); a
  test checks both agree.

### Retry policy (`decideNextAttempt`)

- **Transient network/server failures:** up to 2 extra attempts with
  exponential backoff (2 s, 4 s, capped at 10 s) plus up to 1 s jitter, and
  only if the failed attempt ended within 15 s. yt-dlp already retries
  connections internally (about 25 s when offline); retrying a slow failure
  only tripled the wait (measured: 81 s → 24.6 s to report a dead connection).
- **HTTP 403 on downloads:** the existing ladder, each step at most once:
  configured auth → without auth (only when auth is configured) → `mweb`
  client. If a fallback fails for an unrelated reason (for example "sign in"
  after cookies were dropped), the original 403 is reported.
- **Rate limit:** stop immediately and block analysis, extraction and the
  authentication test for one hour (session-wide).
- **Everything else:** stop immediately.
- **Hard cap:** 4 yt-dlp runs per operation. Partial files are removed before
  each new attempt.

### Playlists

A batch skips tracks with per-video problems (`unavailable`, `private`,
`geo-restricted`, `auth-required`, `media-forbidden`, `post-processing`,
`unsupported-url`, `unknown`) and continues; it stops on problems that would
affect every remaining track (connection, rate limit, authentication source,
bot check, outdated extractor, missing component, cancel). Finished tracks are
remembered, so **Retry** / **Add Remaining to Library** continues instead of
re-extracting them (songs held for editing count as finished).

### Diagnostics sanitization

`sanitizeDiagnosticText()` (on top of `redactSensitiveText()` from `auth.cjs`)
removes cookie-file lines and cookie values, `Cookie`/`Authorization`/visitor
headers, PO tokens and `po_token` arguments, `visitorData`, signed media URL
query strings (`googlevideo.com` and any URL with `sig`, `pot`, `token`, `n`…),
long token-like blobs, and replaces the user's home folder with
`%USERPROFILE%`. Progress lines are dropped and output is limited to the last
80 lines.

---

## Extraction engine updates

### Layout

```
%APPDATA%\WaveMint\engine\
  state.json                    { active, previous, broken[], lastCheck }
  versions\<version>\yt-dlp.exe one folder per installed version
  staging\                      in-progress downloads (always cleaned up)
```

The install folder (`resources\bin`) and `app.asar` are never modified. The
resolver uses the active version when `state.json` names one **and** its
SHA-256 still matches (checked at startup); otherwise the bundled copy.

### Install sequence (`createEngineUpdater().install`)

1. Read the latest release tag from the GitHub API (`yt-dlp/yt-dlp` for
   Stable, `yt-dlp/yt-dlp-nightly-builds` for Nightly). The tag must look like a
   yt-dlp version and be newer than the current engine (no downgrades, so an
   old signed release can't be replayed) and not previously marked broken.
2. Download `SHA2-256SUMS` and `SHA2-256SUMS.sig` and verify the OpenPGP
   signature with yt-dlp's release key, pinned by fingerprint
   `AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581`
   (`electron/trust/yt-dlp-signing-key.asc`, verified by `electron/pgp.cjs`
   using only Node's crypto).
3. Download `yt-dlp.exe` to `staging\`, hashing while streaming; it must match
   the signed checksum (size capped at 80 MB).
4. Self-test offline: `yt-dlp -v` (no URL, no network) with WaveMint's runtime
   arguments must report the expected version, the bundled Deno under
   "JS runtimes" and a bundled `yt_dlp_ejs`. A yt-dlp that needs a newer Deno
   than WaveMint ships is rejected with "Update WaveMint instead".
5. Move the staged folder to `versions\<version>\` and switch `state.json`
   (written to a temp file, then renamed). The previous version is kept for
   rollback; older ones are pruned when no extraction is running.
6. Re-run the startup component check against the new engine. If an active
   update ever fails that check, it is marked broken and WaveMint falls back to
   the bundled copy automatically.

Every request is HTTPS to an allowlist (`api.github.com`, `github.com`,
`objects.githubusercontent.com`, `release-assets.githubusercontent.com`) and
redirects are followed manually so each hop is checked. Only one install runs
at a time, and installs/switches are refused while an extraction is running.
Executables are never overwritten in place, so a running yt-dlp is never
replaced.

### User controls

Settings → Extraction Engine shows the installed version (built-in or updated,
with channel), the update status (Up to date / Update available / Unable to
check) and buttons: **Check for Updates**, **Install <version>** (only after a
check finds one), **Use Built-in Version**, and **Back to / Use <previous>**.
The channel is Stable by default; Nightly is opt-in with a warning. An optional
background check runs at most once a day, 20 seconds after startup; it never
installs anything and failures (offline) are only recorded.

### Trust limitations

- Authenticity rests on yt-dlp's release signing key. If that key were
  compromised, a malicious release could pass verification (it would still
  have to be newer and pass the self-test). The pinned key is the one published
  in the yt-dlp repository (`public.key`).
- WaveMint does not run its own signed manifest service. A manifest signed by
  WaveMint would add an independent approval step (for example, only versions
  the maintainer tested), but needs signing-key management and hosting. The
  current design keeps that option open: the updater's policy checks
  (`compareVersions`, `broken`, self-test) are where an allowlist would plug in.
- The GitHub API response is not trusted for anything except choosing which
  tag to try; everything executable is verified independently.
- The self-test proves the engine starts and sees Deno/EJS. It can't prove
  YouTube extraction works; the first real failure is reported normally and
  **Use Built-in Version** is always available.
- Deno and FFmpeg are not updated in-app; they change rarely and stay pinned to
  the WaveMint release.

---

## YouTube access and authentication

- Default: anonymous ("Automatic · no sign-in"). Nothing to configure.
- Settings → YouTube Access → **Advanced Authentication** (collapsed unless in
  use, or opened from a sign-in error) keeps the existing modes: browser
  cookies (Chrome, Edge, Firefox, Brave, Opera, Vivaldi, Chromium, Naver Whale,
  with profile selection) and an imported `cookies.txt`, plus **Test
  Authentication** and **Remove Authentication** (turns auth off and forgets
  the saved browser/profile/file path; never deletes files).
- The main window only offers "YouTube Access" for categories where signing in
  can help (`auth-*`, `private`, `bot-check`).
- WaveMint does not work around Chromium's app-bound cookie encryption. On this
  machine, Edge 155's `Local State` contains an `app_bound_encrypted_key`, so
  Edge cookies are expected to be unreadable by yt-dlp even with Edge closed;
  the cookies-file route is the supported alternative.

---

## Deno and EJS

Verified with the bundled builds (`yt-dlp -v`, no network):

```
[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp (win_exe)
[debug] Optional libraries: … yt_dlp_ejs-0.8.0
[debug] JS runtimes: deno-2.9.7
[debug] Plugin directories: none (disabled)
```

- The official `yt-dlp.exe` bundles the matching `yt-dlp-ejs`, so updating
  yt-dlp updates EJS with it. WaveMint never uses `--remote-components`; no
  scripts are downloaded during extraction.
- Deno is passed explicitly (`--no-js-runtimes --js-runtimes deno:<bundled>`),
  so a Node/Deno on the user's PATH is never used and none is required.
- The startup check (one `yt-dlp -v` run, in the background) confirms that the
  active yt-dlp sees the bundled Deno and EJS; a mismatch shows the components
  banner. Deno runs with `DENO_NO_UPDATE_CHECK=1` and `DENO_NO_PROMPT=1`.
- Observed: with Deno unavailable, public extraction still worked through
  yt-dlp's `visionos` client, but yt-dlp warns that formats may be missing; with
  Deno, yt-dlp solved the JS challenge for the Rick Astley video in the same
  run (`[jsc:deno] Solving JS challenges using deno`).

---

## Baseline and measurements

All measurements on 2026-10-11, Windows 11, home connection, bundled yt-dlp
2026.08.19 + Deno 2.9.7, anonymous, with WaveMint's runtime and pacing
arguments. Public test content only; each case run once per configuration.

### yt-dlp baseline (command line, same arguments as the app)

| Case | Result | Time |
|---|---|---|
| Analyze `jNQXAC9IVRw` ("Me at the zoo") | OK, 24 formats (12 audio) | 4.6 s |
| Analyze `dQw4w9WgXcQ` | OK, 49 formats; JS challenge solved by Deno | 6.5 s |
| Flat playlist `UU4QobU6STFB0P71PMvOGN5A` | OK, 1 entry | 2.5 s |
| Analyze `aaaaaaaaaaa` | `This video is unavailable` | 2.6 s |
| Download + MP3 `jNQXAC9IVRw` | OK | 4.0 s |

No public case needed cookies or a PO Token. The default client path
(`visionos` in yt-dlp 2026.08.19) did not request a token.

### In the app (dev and packaged, minimal PATH)

| Flow | Result |
|---|---|
| Analyze single video | OK, 4.3 s; labels "Analyzing video…" → "Complete" |
| Extract MP3, Square artwork | OK, 11–13 s incl. 5–10 s pacing sleep; tags title/artist/album; cover 1000 × 1000 `attached_pic` |
| Re-analyze same URL | served from session cache, no yt-dlp run |
| Unavailable video | "This video isn't available for extraction.", no Retry, Details + Copy |
| Playlist (1 track) + Apply to All + Extract Selected | OK; album tag from bulk edit; Open All in toolbar |
| Cancel during extraction | stopped, no error shown, temp files removed |
| Dead network (proxy to closed port) | "WaveMint couldn't connect to YouTube…", Retry + Details; reported after 24.6 s (81 s before the slow-failure rule) |
| Engine update (Nightly 2026.10.10.233141) | signature verified, downloaded, self-tested and activated in 4.8 s; startup check and a real analysis used it; switched back to built-in |

---

## PO Token provider evaluation

Sources: yt-dlp [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide),
[bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider),
[yt-dlp-getpot-wpc](https://github.com/coletdjnz/yt-dlp-getpot-wpc).

| | BgUtils (bgutil) | wpc |
|---|---|---|
| Maintenance | Active (2.0.2, 2026-10-07; maintained by a yt-dlp maintainer) | Last release v1.1.2, 2026-08 ("experimental") |
| Needs | Node ≥ 22 or Deno ≥ 2, ~100 MB `node_modules` incl. native `canvas` | Chrome/Chromium + Python `nodriver` |
| Works with standalone `yt-dlp.exe` | Yes (plugin zip via `--plugin-dirs`) | No (needs a Python environment) |
| Local only | Yes; HTTP server binds 127.0.0.1/::1 | Opens a visible browser window |
| License | GPL-3.0 | MIT |

**Prototype.** BgUtils 2.0.2 was run in isolation (scratch folder, not the
repo): the server under WaveMint's bundled Deno 2.9.7 on a loopback port, the
plugin through `--plugin-dirs`, and the same URLs as the baseline.

| Configuration | Analyze ×4 | Download | Notes |
|---|---|---|---|
| Default clients, no provider | 4/4 as expected | OK | baseline |
| Default clients, BgUtils | 4/4, identical results | OK | a GVS token was generated but not needed; +1.3 s on one video |
| `mweb` client, no provider | OK, 5 formats (HLS only) | OK | https formats skipped |
| `mweb` client, BgUtils | OK, 34 formats | OK | tokens restore https formats |

Overhead: server ready after ~1.9 s, 140–200 MB RAM, ~100 MB on disk.

**Decision: not integrated.** It made no difference to any tested public
workflow, would add a long-running GPL service with a native dependency to the
installer, and the documented benefit (more formats on token-requiring clients)
did not change success. WaveMint keeps `--no-plugin-dirs`, so a provider can't
be picked up accidentally. If YouTube starts requiring tokens for the default
clients, BgUtils under the bundled Deno is the path to revisit: it would sit
behind the extraction manager as one more strategy, started on demand, bound to
loopback on an ephemeral port and stopped after the operation.

---

## YouTube.js evaluation

[YouTube.js](https://github.com/LuanRT/YouTube.js) 18.1.0 was benchmarked
against yt-dlp on the same public URLs (metadata only):

| | YouTube.js | yt-dlp |
|---|---|---|
| Session setup | 153 ms | — |
| `jNQXAC9IVRw` metadata | 81 ms | 2.1 s |
| `dQw4w9WgXcQ` metadata | 62 ms | 2.7 s |
| Unavailable video | 36 ms, same error | 1.2 s, same error |
| Flat playlist | 66 ms, same entries | 1.3 s, same entries |
| Title / uploader / duration / description | identical | identical |
| Thumbnails | 4–5 | 42–44 |
| Music fields (`track`/`artist`/`album`) | not provided | provided when YouTube has them |
| Playability | reported `UNPLAYABLE` for both public videos | downloadable |

**Decision: not integrated.** It is much faster, but analysis is not where users
wait (pacing and the download dominate), its results can disagree with what
yt-dlp can actually extract (`UNPLAYABLE` above), it lacks the music metadata
WaveMint's auto-fill uses, it would be WaveMint's first runtime npm dependency
inside `app.asar`, and it changes major versions often. yt-dlp remains the only
extraction engine.

---

## Dependency maintenance

- **yt-dlp:** users can update in-app; WaveMint releases should still bump the
  bundled pin regularly (`npm run binaries:check-updates`), which now also
  verifies the release signature with the pinned key.
- **Deno / FFmpeg:** pinned per WaveMint release. Before raising Deno, check the
  EJS wiki for the minimum version; an in-app yt-dlp update that needs a newer
  Deno is rejected automatically.
- **Signing key:** if yt-dlp ever rotates its release key, replace
  `electron/trust/yt-dlp-signing-key.asc`, update
  `YT_DLP_SIGNING_KEY_FINGERPRINT` in `electron/engine.cjs` and the test
  fixtures in `tests/fixtures/yt-dlp-release/`, and ship a WaveMint release.
  Until then in-app updates fail safely with "signature could not be verified".

---

## Testing

```powershell
npm run lint
npm test                 # node --test, no network
npm run pack:win         # unpacked app + release checks
```

The unit tests use recorded yt-dlp output and fakes; none contact YouTube or
GitHub. `tests/engine.test.cjs` replays yt-dlp's real signed 2026.08.19
checksum files through a fake release server; its success-path tests use the
fetched `resources/bin/win32-x64/yt-dlp.exe` and are skipped until
`npm run binaries:fetch` has run.

| Area | Tests |
|---|---|
| Command construction, auth arg order, misconfigured auth | `extraction.test.cjs` |
| Retry limits, backoff, slow failures, 403 ladder, reported failure | `extraction.test.cjs` |
| Rate-limit cooldown, cancellation, busy tracking | `extraction.test.cjs`, `processes.test.cjs` |
| Error classification (recorded messages) | `errors.test.cjs` |
| IPC error parsing, UI actions, batch skip rules | `ipc-errors.test.mjs` |
| Signature verification, tampering, wrong key | `engine.test.cjs` |
| Update check/install, hash mismatch, downgrade, incompatible Deno, wrong version, concurrency, rollback, pruning, corrupted state | `engine.test.cjs` |
| Resolver priority (update → bundled), runtime args | `engine.test.cjs`, `binaries.test.cjs` |
| Diagnostics sanitization | `diagnostics.test.cjs` |
| Settings persistence (auth + engine) | `settings.test.cjs` |

Manual end-to-end checks are listed in the
[release checklist](RELEASE_CHECKLIST.md). The flows in the table under
[Baseline and measurements](#in-the-app-dev-and-packaged-minimal-path) were run
by driving the real app with `playwright-core` from outside the repository.
