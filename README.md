<div align="center">

<img src="src/assets/Horizontal%20Logo.png" alt="WaveMint" width="420" />

### Your music library, your way.

**A Windows desktop app for browsing, editing, organizing and listening to your personal music collection, and keeping it in sync with iTunes and your iPhone.**

Browse and play your music, curate metadata and artwork, build playlists, catch real library problems and duplicates, replace songs with better files, add new music from supported sources, and sync the result to iTunes. All in one place.

</div>

> [!IMPORTANT]
> **Use WaveMint responsibly.** Only download, copy, or process media when you are authorized to do so. A video being publicly accessible does **not** necessarily mean you have permission to download its audio. Read [Responsible use and copyright](#responsible-use-and-copyright) before using online media features.

## At a glance

|                      |                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Platform**         | Windows 10 and 11, 64-bit                                                                          |
| **Download**         | [Latest installer on GitHub Releases](https://github.com/cocampo1005/wavemint/releases/latest)     |
| **Storage**          | Your music stays in your own folders; WaveMint keeps its library database, playlists and history locally |
| **Apple devices**    | Syncs to classic iTunes for Windows, which plays WaveMint's files directly and syncs your iPhone  |
| **Media processing** | Bundled yt-dlp, Deno, FFmpeg, and FFprobe                                                          |
| **Project**          | Independent, personally maintained; [source-use terms](#public-source-code)                        |

## Features

WaveMint is organized around what you do every day. The sidebar has just a few destinations:

| Destination | What it's for |
| --- | --- |
| **Add Music** | Add songs, albums and playlists from supported online sources |
| **Music** | Browse and play your collection: Overview, Songs, Albums, Artists, Genres and Favorites |
| **Playlists** | Manual and smart playlists |
| **Review** | Songs missing important details, possible duplicates, and file problems |
| **Apple Library Sync** | Keep iTunes (and through it, your iPhone) in step with your library |
| **Library Tools** | Sources, library organization, storage, history, library imports and batch identification |

### Browse and listen

- **Music, one place.** Switch between **Overview**, **Songs**, **Albums**, **Artists**, **Genres** and **Favorites** with tabs. Search, filter (artist, album, genre, decade), sort and resize columns; your choices are remembered.
- **Overview.** Recently added music with artwork, what your collection is made of, your top artists, and a short note when something needs your attention.
- **Integrated player.** Play Now, Play Next or Add to Queue from any song; reorder the queue, shuffle, repeat, and control playback with Windows media keys.
- **Listen Mode.** Large artwork with a smooth, audio-reactive visualizer that flows from the artwork's borders, in a window or full screen.

### Edit songs where you find them

Select any song to open its details beside the list. Everything about one song is right there:

- **Edit metadata.** Title, artist, album and genre first (with suggestions from your library so spellings stay consistent), the rest under **Advanced metadata**. Edit several songs or a whole album at once.
- **Artwork.** **Find Artwork** looks up a missing cover from the title, artist and album; **Choose Image…** uses your own. The new cover is previewed and saved with your other changes.
- **Save Changes writes the file.** Tags and artwork are written into the audio file after a verified backup, so other apps (and iTunes) see the same details.
- **Edit Audio…** Trim and fade with a waveform preview. The previous version is kept so the edit can be undone.
- **Upgrade Track…** Replace a song with a better file: choose a local file or analyze a supported URL, compare the technical details, listen to both (A/B and spectrograms), choose which metadata and artwork to keep, then upgrade. The song keeps its identity, playlists, history and its iTunes entry; the earlier file is kept for undo.
- **Identify Song…** Look the song up in MusicBrainz and review suggested details before anything changes (optional; off until you enable it).
- **Sync to iTunes**, **Show in Explorer**, **Remove from Library** (keeps the file, undoable) and **Delete File…** (to the Recycle Bin) from the song menu.

### Review: only what matters

Review answers three questions, one tab each:

1. **Needs Attention: which songs are missing important information?** Only the essentials are checked: title, artist, album and artwork, plus values a ripper filled in ("Unknown Artist", "Track 01"). Optional details such as year, track numbers or genre are never flagged. Each group explains why it was flagged and how to fix it, and you fix it right there: **Find Artwork** (for a song or a whole album), **Use as Single** for a song without an album, **Edit** to open the song beside the list, or **Keep As Is**. If your library is full of singles, you can stop flagging songs without an album.
2. **Possible Duplicates: which songs might be the same recording?** WaveMint compares songs conservatively: identical files, the same artist, title and length, or nearly identical titles ("Blinding Lights" and "The Blinding Lights" by the same artist). Live, remixed, acoustic, instrumental, radio-edit and other versions are never paired. Compare the songs side by side, play them, then **Merge…** (one song stays, the other files are kept as earlier versions, playlists and favorites follow, undoable from History), **Keep Both** (never paired again) or **Dismiss** (until one of the files changes). Nothing is ever merged or removed automatically.
3. **Diagnostics: is anything wrong with my files?** Songs whose file was moved, renamed, deleted or can't be read, each with what happened and the safe ways out: **Locate File…** (the song keeps its history, playlists and iTunes entry), **Replace File…**, or **Remove from Library**. Leftover references from songs you already removed or merged are listed apart and aren't treated as problems; **Forget Reference** only tidies WaveMint's database and never deletes a file.

The Review count in the sidebar is the number of real, unresolved issues.

### Apple Library Sync

WaveMint owns the library and iTunes follows it:

- **Direct reference.** iTunes plays your WaveMint Library files themselves: one copy of each song on your PC. Only files iTunes can't play (such as FLAC) get a converted Apple Lossless copy.
- **Incremental and persistent.** Each song is linked to its iTunes entry, so metadata, artwork, renamed or moved files, upgraded audio and playlists update the same entry, keeping play counts and ratings. A sync with nothing to do changes nothing.
- **Safe by design.** Sync never moves, deletes or writes your music files. Removing songs from iTunes, recreating entries and large batches ask first; a removal is guarded so iTunes can't delete the file. Pending decisions, failures and a **Verify iTunes** check are shown on the screen.
- **Automatic or manual.** Sync everything, only selected songs (**Sync to iTunes** in the song menu), or turn on automatic sync. Then sync your iPhone in iTunes as usual.
- **Portable copy.** For the Apple Music app for Windows or another device, WaveMint can keep a portable export folder of compatible files and playlists.

See [`docs/APPLE_SYNC.md`](docs/APPLE_SYNC.md) for the first-sync guide and recovery steps.

### Add music

- **Analyze media.** Review a YouTube video or playlist and edit the suggested title, artist, album, genre and artwork before adding. Official release information surfaced through YouTube Music is used when available.
- **Add songs, albums and playlists.** Native AAC audio is saved as M4A without re-encoding, with metadata and embedded artwork, straight into your WaveMint Library. Review selected playlist tracks or import a playlist as an album. Sources without a native AAC stream are reported as unavailable.
- **Choose your cover art.** The source thumbnail, **1000 × 1000** square artwork (bars around square covers are removed, and album-art videos supply their full-resolution picture), or your own image. The preview is exactly what gets embedded.
- **Edit audio before adding.** Trim or fade a new song before it joins the library.

### Library Tools

Setup and maintenance utilities, out of the way of everyday browsing:

- **Sources.** Add curated, legacy (such as an old iTunes folder) or other music folders. Scanning is read-only; a folder must be marked writable before WaveMint changes its files.
- **Library Organization.** Choose your WaveMint Library folder and its naming pattern (default `Album Artist/Album/Track Title`), preview the result, and copy songs into it. Moves and renames are followed by Apple Library Sync, so iTunes never loses a file.
- **Storage.** Disk usage and cleanup of old backups and earlier versions (with your chosen retention), the library by **audio format** (files, storage and share per codec, whether iTunes can play them, and the songs of each format), a check for genres stored as ID3 numbers with a one-click fix, and the **earlier versions** kept after upgrades and edits (restore one).
- **History.** Every change WaveMint makes, with undo where available. Recent changes can also be undone from the notice that appears after them.
- **Import & Merge.** Bring a separate library (for example a legacy collection) into WaveMint: copies of the same recording are grouped and your curated copy is preferred. Only WaveMint's library changes; no music file is copied, moved or deleted.
- **Identify Songs.** Batch lookups in MusicBrainz and the Cover Art Archive, with every suggestion reviewed before it's applied.

### Extraction engine

WaveMint bundles yt-dlp, Deno, FFmpeg, and FFprobe in packaged builds. The extraction engine supports separately verified updates, conservative retries, and rate-limit feedback. Availability of online media can change without notice; [learn more](#youtube-access-and-extraction).

## Download and installation

1. Download **`WaveMint-Setup-<version>.exe`** from the [latest GitHub Release](https://github.com/cocampo1005/wavemint/releases/latest).
2. Optionally, verify the download against the release's `SHA256SUMS.txt`:

   ```powershell
   Get-FileHash .\WaveMint-Setup-<version>.exe -Algorithm SHA256
   ```

3. Run the installer and open WaveMint from the Start menu. The installer is per-user and doesn't need administrator rights. No other software is required: the media tools are bundled.

> [!CAUTION]
> **Unsigned installer:** the installer isn't code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway** only if you downloaded it from the official release page above. A checksum comparison helps detect an altered or incomplete download, but a checksum hosted next to the download doesn't independently prove who published it.

### System requirements

| Requirement                | Details                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operating system           | Windows 10 or 11, x64                                                                                                                               |
| App disk space             | Approximately 650 MB for the packaged app and tools, plus space for audio, cache, and backups                                                       |
| Internet                   | Needed for online analysis/extraction, engine updates, and optional MusicBrainz lookups; library browsing, playback, and local editing work offline |
| Apple Library Sync         | Classic iTunes for Windows (the version from Apple's website), installed on the same PC                                                             |
| Additional media utilities | None; the required tools are bundled                                                                                                                |

### Uninstalling and preserving your data

> [!WARNING]
> **Uninstalling removes `%APPDATA%\WaveMint`, including the library database.** Your music files and export folders stay on disk, but saved metadata edits that live only in WaveMint, playlists, history and settings are removed. **Back up your application data before uninstalling or reinstalling.**

To back up your app data, exit WaveMint and copy the entire `%APPDATA%\WaveMint` folder to another location. Then use **Windows Settings → Apps → Installed apps → WaveMint → Uninstall**.

## Getting started

### 1. Bring in your music

1. Open **Library Tools → Sources** and choose **Add Curated Folder**, **Add Legacy Folder**, or **Add Other…** (or use the buttons on the welcome screen of an empty library).
2. Choose the folders that hold your music. A scan indexes them without modifying the files. Source roles decide which copy is preferred when the same recording exists in several places.
3. In **Library Tools → Library Organization**, choose where your WaveMint Library lives. New, upgraded and organized songs are saved there.
4. Open **Music** and browse **Songs**, **Albums**, **Artists** and **Genres**. Double-click a song to play it.

To combine an older collection with your curated one, use **Library Tools → Import & Merge**.

### 2. Add music from a supported online source

> Only process media when you have the necessary rights or permissions, and comply with applicable platform terms. See [Responsible use](#responsible-use-and-copyright).

1. Open **Add Music**, then choose **Single Video** or **Playlist**.
2. Paste the link and click **Analyze**.
3. Review or correct the suggested metadata. For playlists, select the songs you want; **Apply to all songs** can simplify shared fields.
4. Choose **Original**, **Square**, or **Custom** artwork and review the preview.
5. Select **Add to Library** or **Add Selected to Library**. Tick **Edit audio before adding** to trim or fade a recording first.

Progress is shown as it happens, and each operation can be canceled. Some sources may be unavailable because of permissions, access restrictions, removal, or third-party changes.

### 3. Edit metadata and artwork

Select a song to edit its details and click **Save Changes**. Title, artist, album, and genre come first; other tags are under **Advanced metadata**. Select several songs to edit them together, or edit a whole album from its page. **Change Artwork…** chooses an image, and **Find Artwork** looks one up when a song has none.

Saving writes the changes into the audio file after a verified backup. Tags can be written to MP3, M4A (AAC and ALAC) and FLAC files; WAV and AIFF play but keep their tags in WaveMint, as do songs in folders you haven't made writable.

### 4. Review your library

Open **Review** now and then. **Needs Attention** lists songs missing a title, artist, album or artwork; **Possible Duplicates** lets you compare and merge or keep songs that may be the same recording; **Diagnostics** helps you locate files that were moved or renamed outside WaveMint. When everything is in order, each tab says so.

### 5. Upgrade or trim a song

Select a song and choose **Upgrade Track…** to replace its audio with a better file, or **Edit Audio…** to trim and fade it:

1. For an upgrade, use **Choose File** for a local replacement, or **Analyze URL** for an online source.
2. Compare the technical details and listen to both versions. Make sure the replacement is the same recording, not a live version, remix, or alternate take.
3. Review the **prefilled but editable** metadata and choose **Current**, **Source**, **Custom**, or **None** for the artwork. Detected metadata never silently replaces your curated fields.
4. Click **Upgrade Track**. The previous file is kept so the upgrade can be undone from **History**.

### 6. Sync to iTunes and your iPhone

1. In iTunes (**Edit → Preferences → Advanced**), turn off **Keep iTunes Media folder organized** and **Copy files to iTunes Media folder when adding to library**. Keep iTunes open.
2. Open **Apple Library Sync** and choose **Check What's Changed**.
3. Choose **Sync 5 Songs as a Test**, check the songs in iTunes, then **Sync Everything** and **Verify iTunes**.
4. Turn on **Sync automatically** if you like, and sync your iPhone in iTunes.

## File safety and backups

WaveMint is designed never to modify your music folders without your permission. File-changing operations use staged writes, verification, backups and a journal to support recovery and undo. The scope of verification depends on the operation: a metadata-only write verifies that the audio didn't change, whereas a deliberate trim or upgrade changes it on purpose.

Duplicate merges, library imports, Forget Reference and Remove from Library only change WaveMint's database; they never delete music files. Deleting a file always asks first and moves it to the Recycle Bin.

These protections reduce risk; they are **not** a substitute for your own backups or a guarantee against hardware failure, software bugs, or interruption. Keep an independent backup of important music and the WaveMint application-data folder, especially before large imports, consolidations, deletions, or upgrades.

## YouTube access and extraction

Online extraction depends on the third-party platform, the user's permissions, and the current capabilities of yt-dlp. **Not every publicly viewable video is downloadable or permitted to be downloaded.** Some sources require authentication, and authentication does not itself grant permission to copy content.

### Optional sign-in

Under **Settings → YouTube Access → Advanced Authentication**, WaveMint offers:

| Method              | Description                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Off** (default)   | Does not supply account cookies                                                                                          |
| **Browser Cookies** | Asks yt-dlp to read a supported local browser profile (Chrome, Edge, Firefox, Brave, Opera, Vivaldi, Chromium, or Whale) |
| **Cookies File**    | Uses a user-provided Netscape-format `cookies.txt` file                                                                  |

**Test Authentication** performs a small request to check whether cookies can be read and whether the platform recognizes the session; it does not download media. Browser security protections or locked profiles may prevent access. WaveMint does not attempt to defeat browser encryption protections.

> [!WARNING]
> **Protect your cookies.** A cookies file can provide access to an authenticated account and should be treated like a password. Never upload or share it in bug reports. Delete exported cookie files when they are no longer needed. WaveMint stores the selected cookie-file path rather than its values; yt-dlp may update the file during use.

### Engine updates and rate limits

Use **Settings → Extraction Engine → Check for Updates** to check for a newer yt-dlp release. WaveMint verifies downloaded updates, tests them, and keeps the bundled engine as a fallback. Update checks run at most once a day and can be turned off; updates are never installed automatically.

Online services can restrict access, change behavior, or throttle requests. WaveMint reports detected rate limits and can pause processing temporarily. Neither an engine update nor signing in guarantees that extraction will work.

## Troubleshooting

<details>
<summary><strong>A bundled component could not be started</strong></summary>

A required tool may be missing or blocked. Check antivirus or system security notifications and confirm that the software came from a trusted source. For a source checkout, run `npm run binaries:fetch` to fetch the pinned media utilities.

</details>

<details>
<summary><strong>A song says its file is missing</strong></summary>

Open **Review → Diagnostics**. If you moved or renamed the file outside WaveMint, choose **Locate File…** and point to its new location *before* rescanning: the song keeps its details, playlists, history and iTunes entry. If the drive isn't connected, connect it and rescan.

</details>

<details>
<summary><strong>“Paste the web address of a video or playlist”</strong></summary>

The input is not a supported online address (for example, it may be a local file path). Copy a valid source URL instead. For local audio, add its folder under **Library Tools → Sources**, or use **Upgrade Track…** to replace a song's file.

</details>

<details>
<summary><strong>A video is unavailable, restricted, or private</strong></summary>

Access can be restricted or withdrawn. Use only sources you are permitted to access and process. An authorized account may be required for some material, but signing in does not guarantee availability or permission to download.

</details>

<details>
<summary><strong>YouTube rate-limited the session</strong></summary>

WaveMint may temporarily pause analysis and extraction, potentially for up to an hour. Review the application's message before trying again.

</details>

<details>
<summary><strong>Extraction components may need an update</strong></summary>

Use **Settings → Extraction Engine → Check for Updates** to check for a verified engine update. Platform restrictions may still prevent access.

</details>

<details>
<summary><strong>iTunes isn't found or a sync stops</strong></summary>

Apple Library Sync needs classic iTunes for Windows, open on the same PC. If a sync stops because iTunes moved or copied a file, turn off **Keep iTunes Media folder organized** and **Copy files to iTunes Media folder** in iTunes' Advanced preferences, then sync again. Changes that need your decision (removals, entries edited in iTunes) wait on the Apple Library Sync screen. See [`docs/APPLE_SYNC.md`](docs/APPLE_SYNC.md#recovery).

</details>

<details>
<summary><strong>A track cannot be tagged, edited, or upgraded</strong></summary>

- WAV and AIFF can be played but are not supported for tag writing.
- Folders you haven't made writable (Library Tools → Sources) are never modified; their songs keep edits in WaveMint.
- For permission or file-in-use errors, close other programs using the file and check folder permissions.

</details>

<details>
<summary><strong>An edit or upgrade failed</strong></summary>

WaveMint prepares and validates replacements before applying them and recovers incomplete journaled operations at startup. If an operation failed or was interrupted, check **Library Tools → History** and the current file; restore from your backup if necessary.

</details>

<details>
<summary><strong>How do I report an issue?</strong></summary>

Use **Details → Copy Error Details** where available. Review the copied report before sharing it: WaveMint redacts credentials, account data, signed media URLs, and local user paths, but check that no private information remains. Describe the steps to reproduce the issue.

</details>

## Privacy and your data

WaveMint has no user accounts, in-app analytics, telemetry, or crash-report uploading. Library management happens on your PC; only the features listed under [Network activity](#network-activity) contact external services, and only when you use them.

### Local storage

| Data                                                                  | Location                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Song details, library indexes, playlists, edits, history, sync state  | `%APPDATA%\WaveMint\library\`                                             |
| Artwork, caches, backups, previous versions                           | App library folder and your WaveMint Library's `.wavemint-archive` folder |
| App settings and the selected cookie-file **path** (not its contents) | `%APPDATA%\WaveMint\settings.json`                                        |
| Updated yt-dlp and its cache                                          | `%APPDATA%\WaveMint\engine\` and `%APPDATA%\WaveMint\yt-dlp-cache\`       |
| Player preferences                                                    | App-local browser storage                                                 |

WaveMint keeps a limited number of sanitized error details in memory and logs to the console rather than to persistent log files.

### Network activity

| Service                                     | When contacted                                                  | Data involved                                                  |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| YouTube/Google and media or thumbnail hosts | When you analyze/extract media or test authentication           | Source URL; authenticated cookies if you opted into that mode  |
| GitHub                                      | Engine-update checks (at most daily, can be turned off) and installs you start | Requests for release information and binary downloads |
| MusicBrainz / Cover Art Archive             | When identification is enabled and you use Identify or Find Artwork | Music metadata queries and the required application identifier |

Apple Library Sync talks to iTunes on your own PC; it doesn't contact Apple's services. The services above may process request information under their own terms and privacy policies.

## Building from source

**Prerequisites:** Windows 10/11 x64, [Node.js](https://nodejs.org/) 24 or later, npm, and Git.

```powershell
git clone https://github.com/cocampo1005/wavemint.git
cd wavemint
npm install
npm run binaries:fetch
npm start
```

`binaries:fetch` downloads and verifies the pinned yt-dlp, Deno, FFmpeg, and FFprobe binaries. `npm start` runs Vite and Electron together with hot reload.

| Command                                              | Purpose                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `npm start`                                          | Launch Vite and Electron together (separate `WaveMint-Dev` profile) |
| `npm run start:library`                              | Development run with the installed app's profile (your real library); refused while WaveMint is open |
| `npm run dev` / `npm run electron`                   | Start the renderer or Electron separately                   |
| `npm run build`                                      | Build the renderer into `dist/`                             |
| `npm run lint`                                       | Run ESLint                                                  |
| `npm test`                                           | Run the unit and integration tests                          |
| `npm run test:e2e`                                   | Build, then drive the real app with a temporary profile and synthetic songs |
| `npm run binaries:fetch` / `npm run binaries:verify` | Fetch or validate pinned media tools                        |
| `npm run binaries:check-updates`                     | Check for upstream tool versions; `-- --write` updates pins |
| `npm run check:release`                              | Validate release inputs                                     |
| `npm run pack:win`                                   | Generate an unpacked Windows application                    |
| `npm run dist:win`                                   | Build the Windows installer                                 |
| `npm run icon`                                       | Regenerate the Windows application icon                     |

**Development notes:**

- If bundled tools have not been fetched, development can use `yt-dlp`, `ffmpeg`, `ffprobe`, and `deno` from `PATH`. Set `WAVEMINT_USE_SYSTEM_BINARIES=1` to force system binaries.
- Development data defaults to `%APPDATA%\WaveMint-Dev`; `--user-data-dir=<folder>` selects another profile for isolated tests.
- Set `WAVEMINT_RENDERER=dist` to load a previously built renderer instead of the dev server.
- If Electron unexpectedly runs in plain Node mode, remove an inherited `ELECTRON_RUN_AS_NODE` environment variable.

## Architecture

WaveMint uses Electron with a sandboxed React renderer, an explicit preload API, main-process services, and a worker-thread-backed SQLite library.

```text
React UI (src/)
   │  window.waveMintAPI  (electron/preload.cjs)
   ▼
Electron main process (electron/)
   ├── ipc/trustedIpc.cjs         IPC sender validation
   ├── ipc/extractionHandlers.cjs Analysis, extraction, previews, cancellation
   │     ├── youtubeMetadata.cjs  Parse yt-dlp metadata
   │     └── songExtraction.cjs   Extraction and tagging workflow
   ├── artwork.cjs                Artwork download and crop processing
   ├── ipc/engineHandlers.cjs     Engine updates and verification
   ├── ipc/authHandlers.cjs       Optional authentication settings
   └── library/host.cjs           Validated library requests, dialogs, media protocol
             │
             ▼
       library/worker.cjs         SQLite and the library services
             ├── review.cjs + duplicates.cjs   Review: essentials, duplicates, diagnostics
             ├── applesync.cjs + itunes.cjs    Apple Library Sync (iTunes over COM)
             └── fileops, upgrade, merge, organize, storage, …
```

**Design principles**

- **Restricted renderer access:** privileged operations are exposed through a defined preload API; IPC senders and payloads are validated.
- **Recoverable file operations:** changes use staging, operation-specific verification, backups, and journaling.
- **Shared extraction pipeline:** analysis, single tracks, playlists, and upgrades share extraction infrastructure and request-scoped cancellation.
- **Responsive library operations:** scanning and database work run off the renderer's main thread.
- **Pinned media tools:** packaged utilities are tied to verified upstream downloads and checked during release preparation.

See [`docs/ENGINEERING.md`](docs/ENGINEERING.md), [`docs/LIBRARY.md`](docs/LIBRARY.md), [`docs/APPLE_SYNC.md`](docs/APPLE_SYNC.md), and [`CLAUDE.md`](CLAUDE.md) for more detail.

## Testing and release builds

`npm test` uses Node's built-in test runner. It covers metadata processing, artwork, extraction parameters and retries, IPC validation, cancellation, tag writing, upgrades and their recovery, the review rules and duplicate matching, merges, playlists, storage, Apple Library Sync (against an in-memory iTunes stand-in), the player queue and the visualizer. `npm run test:e2e` drives the real app: navigation, Review, metadata pickers, toasts, Apple Library Sync screens and file diagnostics. Tests use temporary synthetic libraries and never touch a real music library, profile or iTunes.

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml): pushing a version tag (`v1.2.3`) builds the installer on Windows, runs lint and tests, and creates a **draft** GitHub Release with the installer, `SHA256SUMS.txt` and the FFmpeg source archive. The draft is published after the checks in [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md). Release executables are not code-signed yet.

---

## Responsible use and copyright

**WaveMint is intended for lawful management, organization, and processing of music and other media you own or are authorized to use.**

- **Know your rights.** Only access, download, copy, convert, edit, or distribute content when the applicable rights holder has authorized it or applicable law otherwise permits it. WaveMint does not grant rights to music, videos, thumbnails, artwork, or other third-party content.
- **Respect platform terms.** A source being available online does not mean it may be downloaded. YouTube's [Terms of Service](https://www.youtube.com/t/terms), for example, restrict downloading and other use except in specified circumstances. Users are responsible for complying with the laws, permissions, and contractual terms applicable to their activities.
- **No unauthorized circumvention or access.** WaveMint is not intended to be used for infringement, unauthorized redistribution, unlawful circumvention of technological protection measures, or access to services without authorization.
- **Your decisions are your responsibility.** The user selects the media sources and the operations to perform. Technical support for a format or website does not constitute permission to use the underlying content.

This section describes intended use; it is not a legal opinion or a guarantee that any particular use is lawful.

## Third-party software and non-affiliation

WaveMint uses independent third-party software and services, including [Electron](https://www.electronjs.org/), [React](https://react.dev/), [Vite](https://vite.dev/), [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Deno](https://deno.com/), [FFmpeg](https://ffmpeg.org/), [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp), and the [Poppins](https://github.com/itfoundry/Poppins) typeface. Optional metadata lookups use [MusicBrainz](https://musicbrainz.org/) and the [Cover Art Archive](https://coverartarchive.org/).

These projects have their **own** licenses and terms. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the packaged release also contains third-party license materials under `resources\licenses\` and `resources\bin\licenses\`.

WaveMint is an independent project and is not affiliated with, sponsored by, or endorsed by YouTube, Google, Apple, MusicBrainz, or the other third-party projects and services mentioned here. Their names and trademarks belong to their respective owners. External interfaces, terms, and availability can change.

## Disclaimer of warranty and limitation of liability

**WaveMint is provided on an “as is” and “as available” basis, without warranties of any kind, express or implied, to the extent permitted by applicable law**, including implied warranties of merchantability, fitness for a particular purpose, and non-infringement.

Music processing and file-management operations involve risk. Despite precautions such as staged file operations, verification, backups, and recovery mechanisms, the application may contain defects or encounter failures. Potential consequences include data loss, corrupted or replaced audio, incorrect metadata or artwork, unavailable sources, incompatibility with other applications, and interrupted processing. **Maintain independent backups before making significant changes to your library.**

**To the maximum extent permitted by applicable law**, the author and contributors disclaim liability for damages or losses arising from use of or inability to use WaveMint, including loss of data or other direct or indirect losses, except where liability cannot legally be excluded or limited. Applicable consumer-protection and other mandatory laws may provide rights that these statements cannot waive.

These notices do not replace compliance with copyright, contract, privacy, software-distribution, or other applicable legal obligations. Anyone planning to distribute WaveMint broadly should obtain qualified legal advice concerning those obligations.

## Public Source Code

WaveMint's source code is publicly available on GitHub for transparency, learning, and reference.

© 2026 Christian Ocampo. All rights reserved. No license for modification or redistribution is currently granted.

Third-party components remain subject to their respective licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
