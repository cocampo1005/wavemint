# WaveMint release checklist

Run these checks on the installer from the **draft** GitHub Release before
publishing it. Use a Windows PC (or VM) that does **not** have Node.js,
Python, yt-dlp, FFmpeg or Deno installed, and ideally one that has never had
WaveMint installed.

Record the WaveMint version, Windows version (10 or 11) and date.

## Install

- [ ] SmartScreen warning (unsigned builds): **More info → Run anyway** works.
- [ ] Choose a folder **with spaces**, e.g. `C:\Users\<you>\Apps\Wave Mint`.
- [ ] Finish page shows **Run WaveMint** and **Create a desktop shortcut**.
      Install once with the shortcut box ticked and once unticked; confirm the
      desktop shortcut appears only when ticked.
- [ ] Start menu entry **WaveMint** exists and launches the app.
- [ ] No console/terminal window appears at any point.
- [ ] Window, taskbar and Alt-Tab show the WaveMint logomark. Pin to the taskbar
      and confirm the pinned icon is correct.
- [ ] Task Manager shows **WaveMint**. *Installed apps* lists **WaveMint**,
      publisher Christian Ocampo, correct version.

## Core features (no sign-in)

- [ ] No "components could not be started" banner appears after launch.
- [ ] Single public video: Analyze → metadata filled → Square preview shown.
- [ ] Extract MP3 with **Square** artwork: file plays; cover is 1000 × 1000;
      title/artist/album/genre tags are correct.
- [ ] Repeat with **Original** and **Custom** artwork.
- [ ] A YouTube Music track ("Provided to YouTube by…" description) pre-fills
      title/artist/album correctly.
- [ ] Public playlist: Analyze, select 2–3 tracks, **Apply to All**, **Use Cover
      for All**, **Extract Selected**; all files are correct.
- [ ] Output folder whose name contains spaces and non-English characters.
- [ ] **Open in iTunes** / **Open All in iTunes** opens the files in the default
      MP3 player.
- [ ] Analyzing a new URL clears the previous result.
- [ ] Unplug the network: Analyze shows a readable error, not a crash.

## Authentication

For each browser installed on the test PC (Chrome, Edge, Firefox, Brave,
Opera, Vivaldi, Chromium), with a profile that is signed in to YouTube:

- [ ] Settings → Browser Cookies lists the browser as **Detected** and shows its
      profiles. Uninstalled browsers show **Not found**.
- [ ] With the browser **open**, Test Authentication. Chromium-based browsers are
      expected to report that cookies could not be accessed (database locked).
- [ ] With the browser **fully closed**, Test Authentication. Record the result:
      **Signed in**, or "app-bound encryption" (expected for recent
      Chrome/Edge/Brave). Either is acceptable as long as the message is clear.
- [ ] A profile that isn't signed in to YouTube reports **Not signed in**.

Cookies file:

- [ ] Valid `cookies.txt` exported while signed in → Test shows **Signed in**.
- [ ] The same file then works for analyzing and extracting an age-restricted video.
- [ ] Signed-out export → "doesn't contain a YouTube sign-in session" (no network
      request).
- [ ] JSON export is rejected with "The cookie file format is invalid".
- [ ] Rename/delete the selected file → Analyze shows "The selected cookie file was
      not found" with an **Open Settings** button.
- [ ] **Remove** switches back to No Authentication and leaves the file on disk.
- [ ] Restart WaveMint: authentication settings are kept.

## Uninstall

- [ ] Uninstall from *Installed apps*.
- [ ] These are gone: install folder, Start menu entry, desktop shortcut,
      `%APPDATA%\WaveMint`, `%LOCALAPPDATA%\wavemint-updater`.
- [ ] Extracted MP3s and the user's `cookies.txt` are untouched.

## Release files

- [ ] `SHA256SUMS.txt` matches `Get-FileHash` of the downloaded installer.
- [ ] The release contains the FFmpeg source archive.
- [ ] No cookies or personal files are attached to the release (the build also
      checks this automatically).
