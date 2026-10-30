<div align="center">

<img src="src/assets/Horizontal%20Logo.png" alt="WaveMint" width="420" />

### Your music library, your way.

**A Windows desktop app for organizing, editing, upgrading, and listening to your personal music collection.**

Browse existing music folders, curate metadata and artwork, manage playlists, prepare files for Apple Music, and process audio from supported sources—all in one place.

</div>

> [!IMPORTANT]
> **Use WaveMint responsibly.** Only download, copy, or process media when you are authorized to do so. A video being publicly accessible does **not** necessarily mean you have permission to download its audio. Read [Responsible use and copyright](#responsible-use-and-copyright) before using online media features.

## At a glance

|                      |                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Platform**         | Windows 10 and 11, 64-bit                                                             |
| **Availability**     | No public installer has been released yet; [build from source](#building-from-source) |
| **Storage**          | Local music library, metadata, playlists, and history                                 |
| **Media processing** | Bundled yt-dlp, Deno, FFmpeg, and FFprobe                                             |
| **Project**          | Independent, personally maintained; [source-use terms](#source-code-and-licensing)    |

## Features

### Organize your library

- **Browse your collection.** Explore songs, albums, artists, genres, favorites, and playlists. The Overview highlights recently added music, genres, and top artists.
- **Bring your existing folders.** Add curated, legacy/iTunes, or other music folders. Scanning is read-only; a source must be marked writable before WaveMint can modify its files.
- **Curate metadata and artwork.** Edit individual tracks, multiple selections, or entire albums; **Save Changes** writes supported tags straight into the audio file after a verified backup. **Find Artwork** looks up a missing cover from the title, artist, and album.
- **Build an organized collection.** Consolidate copies into a dedicated **WaveMint Library** folder using a configurable naming pattern (default: `Album Artist/Album/Track Title`).
- **Manage playlists.** Create manual and rule-based smart playlists; import and export M3U8 playlists.
- **Review and recover changes.** History records file operations and supports undo where available. Backups and a journal help protect against interrupted operations; [see data safety](#file-safety-and-backups).

### Listen and edit

- **Integrated player.** Queue tracks, use Play Next or Add to Queue, reorder playback, shuffle, repeat, and control playback with Windows media keys.
- **Listen Mode.** Enjoy large artwork with a smooth, layered, audio-reactive visualizer that flows from the artwork's borders.
- **Audio editor.** Trim recordings and add fades using a waveform preview, including while preparing new tracks.
- **Track upgrades.** Replace an existing recording using a local audio file or a supported URL. Compare versions with quality information, A/B listening, and spectrograms; edit the prefilled metadata and artwork before generating the replacement. Previous versions are retained for supported undo operations.

### Add and maintain music

- **Analyze media.** Review a YouTube video or playlist and edit suggested title, artist, album, genre, and artwork before processing. Available metadata may include official release information surfaced through YouTube Music.
- **Process tracks and playlists.** Save native AAC audio as M4A without audio re-encoding, with metadata and embedded artwork. Sources without a native AAC stream are reported as unavailable. Review selected playlist tracks or import a playlist as an album.
- **Choose your cover art.** Use the source thumbnail, **1000 × 1000** square artwork (bars around square covers are removed, and album-art videos supply their full-resolution picture), or a custom image. The preview is exactly what gets embedded. Songs without artwork display a consistent in-app placeholder.
- **Find library issues.** **Merge & Duplicates** groups matching files, **Quality & Upgrades** flags potentially poor-quality audio, **Review** surfaces metadata problems, and **File Health** lists missing files, earlier versions, and backups.
- **Identify music (optional).** Look up recording and album information through MusicBrainz and the Cover Art Archive when enabled.
- **Manage storage.** Review disk usage and remove eligible old backups or versions according to your chosen retention settings.
- **Prepare for Apple Music/iPhone.** Generate an export folder with compatible music files, playlists, and a change report. WaveMint does **not** directly sync an iPhone or modify the Apple Music/iTunes library database.

### Extraction engine

WaveMint bundles yt-dlp, Deno, FFmpeg, and FFprobe in packaged builds. The extraction engine supports separately verified updates, conservative retries, and rate-limit feedback. Availability of online media can change without notice; [learn more](#youtube-access-and-extraction).

## Download and installation

**There is no published WaveMint release yet.** For now, use the [build-from-source instructions](#building-from-source).

When an installer becomes available, find it on the [official GitHub Releases page](https://github.com/cocampo1005/wavemint/releases). The planned Windows asset is named `WaveMint-Setup-<version>.exe`, accompanied by a `SHA256SUMS.txt` file.

1. Download the installer from the project's official release page.
2. Verify the downloaded file's SHA-256 checksum against the release's published checksum:

   ```powershell
   Get-FileHash .\WaveMint-Setup-<version>.exe -Algorithm SHA256
   ```

3. Run the installer and open WaveMint from the Start menu. The described installer is per-user and should not require administrator rights.

> [!CAUTION]
> **Unsigned installer:** Windows SmartScreen may warn about a build that has not been code-signed. Confirm the publisher/source and independently assess the risk before choosing to run it. A checksum comparison helps detect an altered or incomplete download, but a checksum hosted alongside the download does **not** independently prove who published it. Do not bypass a security warning if you cannot establish trust in the file.

### System requirements

| Requirement                | Details                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operating system           | Windows 10 or 11, x64                                                                                                                               |
| App disk space             | Approximately 650 MB for the packaged app and tools, plus space for audio, cache, and backups                                                       |
| Internet                   | Needed for online analysis/extraction, engine updates, and optional MusicBrainz lookups; library browsing, playback, and local editing work offline |
| Additional media utilities | None for packaged builds; the required tools are bundled                                                                                            |

### Uninstalling and preserving your data

> [!WARNING]
> **Current uninstall behavior removes `%APPDATA%\WaveMint`, including the library database.** This can delete your saved metadata edits, playlists, history, and application settings even though your actual music files and export folders remain on disk. **Back up your application data before uninstalling or reinstalling.** The uninstaller has not yet been independently validated as part of a full installer test.

To back up your app data, exit WaveMint and copy the entire `%APPDATA%\WaveMint` folder to another location. This is safer than copying only the `library` subfolder because configuration and engine-related state are stored elsewhere within it.

Use **Windows Settings → Apps → Installed apps → WaveMint → Uninstall** when ready. The data-deletion behavior is a known issue to resolve before wider distribution.

## Getting started

### 1. Connect your music folders

1. On **Overview**, choose **Add iTunes / Legacy Folder**; or open **Manage → Sources** and choose **Add Curated Folder**, **Add Legacy Folder**, or **Add Other…**.
2. Choose the folders containing your music. A scan indexes them without modifying the files. Source roles help determine which version is preferred when duplicates exist.
3. Open **Manage → WaveMint Library** to choose where WaveMint saves organized copies and newly added or upgraded songs.
4. Browse **Songs**, **Albums**, **Artists**, and **Genres**. Double-click a track to play it.

### 2. Add music from a supported online source

> Only process media when you have the necessary rights or permissions, and comply with applicable platform terms. See [Responsible use](#responsible-use-and-copyright).

1. Open **Add Music**, then choose **Single Video** or **Playlist**.
2. Paste the link and click **Analyze**.
3. Review or correct the suggested metadata. For playlists, select the songs you want; **Apply to all songs** can simplify shared fields.
4. Choose **Original**, **Square**, or **Custom** artwork and review the preview.
5. Select **Add to Library** or **Add Selected to Library**. Use **Edit audio before adding** if you want to trim or fade a recording first.

Progress is shown in the interface, and individual operations can be canceled. Some sources may be unavailable because of permissions, access restrictions, removal, or third-party changes.

### 3. Edit metadata and artwork

Select a song to edit its details and click **Save Changes**. Title, artist, album, and genre are shown first; other tags are under **Advanced metadata**. You can also bulk-edit selected songs or update an album. Use **Change Artwork…** to select an image, or **Find Artwork** when a song has none; a new cover is previewed and saved with your other changes.

Saving writes the changes into the audio file after a verified backup. Supported tag-writing formats include MP3, M4A/AAC, ALAC, and FLAC; WAV and AIFF are playable but do not support tag writing in WaveMint, and songs in read-only folders keep their edits in WaveMint.

### 4. Trim or fade a recording

Select a track and choose **Edit Audio…**. Set trim boundaries and fade lengths, listen to the preview, then save. WaveMint retains the previous version for supported recovery through **History**.

### 5. Upgrade an existing track

1. Select a song and choose **Upgrade Audio…** (under **Technical details**, or **Upgrade…** in **Quality & Upgrades**).
2. Use **Choose File** for a local replacement, or **Analyze URL** to review an online source; its audio is extracted for the comparison automatically.
3. Compare technical quality information and listen to both versions. Check that the proposed audio is the intended recording, not a live version, remix, or alternate take.
4. Review the **prefilled but editable** metadata and choose **Current**, **Source**, **Custom**, or **None** for artwork. Detected metadata will not silently replace your curated fields; **Use Detected Metadata…** lets you select changes explicitly.
5. Click **Upgrade Track** to generate and apply the new file using your finalized metadata and artwork. The prior version is retained for supported undo operations.

### 6. Organize and prepare files

Use **Review** to find metadata issues, **Merge & Duplicates** to reconcile repeated tracks, **Quality & Upgrades** to review suspect audio, **File Health** to repair missing files or restore an earlier version, and **Storage** to manage disk usage. Use **Prepare for iPhone** to export files for subsequent import into Apple Music or iTunes.

## File safety and backups

WaveMint is designed to avoid modifying original music folders without your permission. Supported file-changing operations use staged writes, verification, backups, and a journal to support recovery and undo. The scope of verification depends on the operation: for example, a metadata-only write can verify that audio was not changed, whereas a deliberate trim or audio upgrade necessarily changes it.

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

**Test Authentication** performs a small request to assess whether cookies can be read and whether the platform recognizes the session; it does not download media. Browser security protections or locked profiles may prevent access. WaveMint does not attempt to defeat browser encryption protections.

> [!WARNING]
> **Protect your cookies.** A cookies file can provide access to an authenticated account and should be treated like a password. Never upload or share it in bug reports. Delete exported cookie files when they are no longer needed. WaveMint stores the selected cookie-file path rather than its values; yt-dlp may update the file during use.

### Engine updates and rate limits

Use **Settings → Extraction Engine → Check for Updates** to check for a newer yt-dlp release. The application verifies downloaded updates, tests them, and retains the bundled engine as a fallback. Update checks can run at most once a day by default and can be turned off; updates are not installed automatically.

Online services can restrict access, change behavior, or throttle requests. WaveMint reports detected rate limits and can pause processing temporarily. Neither an engine update nor signing in guarantees that extraction will work.

## Troubleshooting

<details>
<summary><strong>A bundled component could not be started</strong></summary>

A required tool may be missing or blocked. Check antivirus or system security notifications and confirm that the software came from a trusted source. For a source checkout, run `npm run binaries:fetch` to fetch the pinned media utilities.

</details>

<details>
<summary><strong>“Paste the web address of a video or playlist”</strong></summary>

The input is not a supported online address (for example, it may be a local file path). Copy a valid source URL instead. For local audio, use the appropriate file-selection workflow.

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
<summary><strong>A track cannot be tagged, edited, or upgraded</strong></summary>

- WAV and AIFF can be played but are not supported for tag writing.
- Read-only source folders are not modified; edits can instead be written into managed copies.
- For permission or file-in-use errors, close other programs using the file and check folder permissions.

</details>

<details>
<summary><strong>An edit or upgrade failed</strong></summary>

WaveMint is designed to prepare and validate replacements before applying them and to recover incomplete journaled operations on startup. If the operation fails or was interrupted, inspect **History** and verify the current file; restore from your backup if necessary.

</details>

<details>
<summary><strong>How do I report an issue?</strong></summary>

Use **Details → Copy Error Details** where available. Review the copied report before sharing it: although WaveMint is designed to redact credentials, account data, signed media URLs, and sensitive local paths, you should check that no private information remains. Describe the steps to reproduce the issue.

</details>

### Apple Music and iTunes limitations

WaveMint does **not** directly edit Apple's library database or sync files to an iPhone. Apple Music/iTunes tracks metadata and file locations separately, so a file changed in WaveMint may need to be refreshed or re-imported in Apple's app. **Prepare for iPhone** generates an export folder with compatible files, playlists, and a change report to help you make those updates.

## Privacy and your data

WaveMint does not currently provide user accounts, in-app analytics, telemetry, or crash-report uploading, according to the documented implementation. Music library management is local, but certain optional and requested features contact external services.

### Local storage

| Data                                                                  | Location                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Track details, library indexes, playlists, edits, and history         | `%APPDATA%\WaveMint\library\`                                             |
| Artwork, caches, backups, previous versions                           | App library folder and your WaveMint Library's `.wavemint-archive` folder |
| App settings and the selected cookie-file **path** (not its contents) | `%APPDATA%\WaveMint\settings.json`                                        |
| Updated yt-dlp and its cache                                          | `%APPDATA%\WaveMint\engine\` and `%APPDATA%\WaveMint\yt-dlp-cache\`       |
| Player preferences                                                    | App-local browser storage                                                 |

The application keeps a limited number of sanitized error details in memory and uses console logging rather than persistent log files, as described in the current implementation.

### Network activity

| Service                                     | When contacted                                                  | Data involved                                                  |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| YouTube/Google and media or thumbnail hosts | When you analyze/extract media or test authentication           | Source URL; authenticated cookies if you opted into that mode  |
| GitHub                                      | Optional or periodic engine-update checks and explicit installs | Requests for release information and binary downloads          |
| MusicBrainz / Cover Art Archive             | When **Identify** is enabled and used                           | Music metadata queries and the required application identifier |

Those services may process request information under their own terms and privacy policies. Review their policies if you use the corresponding features.

## Building from source

**Prerequisites:** Windows 10/11 x64, [Node.js](https://nodejs.org/) 24 or later, npm, and Git. The Node version requirement comes from the current project configuration; packaged builds also depend on the version of Node bundled with Electron.

```powershell
git clone https://github.com/cocampo1005/wavemint.git
cd wavemint
npm install
npm run binaries:fetch
npm start
```

`binaries:fetch` downloads and verifies pinned yt-dlp, Deno, FFmpeg, and FFprobe binaries for development. `npm start` runs Vite and Electron together with hot reload.

| Command                                              | Purpose                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `npm start`                                          | Launch Vite and Electron together                           |
| `npm run dev` / `npm run electron`                   | Start the renderer or Electron separately                   |
| `npm run build`                                      | Build the renderer into `dist/`                             |
| `npm run lint`                                       | Run ESLint                                                  |
| `npm test`                                           | Run automated tests                                         |
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
- If Electron unexpectedly runs in plain Node mode, check and remove an inherited `ELECTRON_RUN_AS_NODE` environment variable.

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
   ├── artwork.cjs               Artwork download and crop processing
   ├── ipc/engineHandlers.cjs     Engine updates and verification
   ├── ipc/authHandlers.cjs       Optional authentication settings
   └── library/host.cjs           Validated library requests
             │
             ▼
       library/worker.cjs         SQLite and domain operations
```

**Design principles**

- **Restricted renderer access:** privileged operations are exposed through a defined preload API; IPC senders and payloads are validated.
- **Recoverable file operations:** changes use staging, operation-specific verification, backups, and journaling where supported.
- **Shared extraction pipeline:** analysis, single tracks, playlists, and upgrades share extraction infrastructure and request-scoped cancellation.
- **Responsive library operations:** scanning and database work run off the renderer's main thread.
- **Pinned media tools:** packaged utilities are tied to verified upstream downloads and checked during release preparation.

See [`docs/ENGINEERING.md`](docs/ENGINEERING.md), [`docs/LIBRARY.md`](docs/LIBRARY.md), and [`CLAUDE.md`](CLAUDE.md) for more detail. These repository documents and links should be checked during release preparation.

## Testing and release builds

`npm test` uses Node's built-in test runner. The reported test suite covers metadata processing, artwork behavior, extraction parameters and retries, IPC validation, cancellation isolation, file tagging, upgrade recovery, playlists, storage, the player queue, and visualizer logic. Tests use temporary synthetic libraries and mock external services rather than downloading live media.

For release preparation, run the applicable lint, test, build, and packaged-application checks, and test the **actual installer and uninstaller** on an isolated Windows profile. At present, the previous audit reported that the installer itself and the repository-contained end-to-end test workflow had not been fully validated.

The repository describes a version-tag-based release workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml) that creates a **draft** GitHub Release with installer artifacts, checksums, and associated third-party source materials. Review [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) before publishing. Release executables are not currently code-signed.

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

These projects have their **own** licenses and terms. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the packaged release also contains third-party license materials under `resources\licenses\` and `resources\bin\licenses\` as documented by the project. Distribution requirements must be checked against the actual shipped binaries and dependencies.

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
