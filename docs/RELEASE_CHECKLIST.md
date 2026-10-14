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
- [ ] WaveMint opens on the library (Songs); an empty library shows the
      welcome with **Add Music** and the folder buttons.
- [ ] **+ Add Music** opens Add Music; the first time it asks for the WaveMint
      Library folder.
- [ ] Single public video: Analyze → metadata filled → Square preview shown.
- [ ] **Add to Library** with **Square** artwork: a compact "Added to your
      library" appears; the song is in Songs at once (**View in Library**);
      the file is in the WaveMint Library folder, plays, its cover is
      1000 × 1000 and title/artist/album/genre tags are correct.
- [ ] Repeat with **Original** and **Custom** artwork.
- [ ] A YouTube Music track ("Provided to YouTube by…" description) pre-fills
      title/artist/album correctly.
- [ ] Public playlist: Analyze, select 2–3 tracks, **Apply to All**, **Use Cover
      for All**, **Add Selected to Library**; all songs are correct.
- [ ] Album/artist names with non-English characters land in correctly named
      library folders.
- [ ] **Edit audio before adding** (single video): the editor opens after the
      extraction; nothing is in the library until **Save & Add to Library** or
      **Skip Editing & Add to Library**.
- [ ] Playlist with **Edit audio before adding** ticked on one song: the batch
      adds the others; that song waits ("Edit & Add…") and the Add Music
      navigation item shows a count.
- [ ] Library song → **Edit Audio…**: trim 15 s from the start, 2 s fade in,
      20 s from the end, 4 s fade out; the preview stops at the end handle
      and the fades are audible; after **Save Changes** the length is
      updated, tags/artwork kept, no duplicate song, and History undoes it.
- [ ] Analyzing a new URL clears the previous result and its completion state.
- [ ] Overview: Recently Added shows the newest songs with artwork; a genre
      bar opens that genre's songs; View All opens Songs newest first.
- [ ] Songs: Sort menu, resizing a column (kept after a restart), the heart
      (kept after a restart; the song is in Favorites).
- [ ] Right-click a song: Play Next twice then Add to Queue; the queue shows
      them in that order before the list; drag to reorder; Next plays them.
- [ ] Shuffle and Repeat (Off / All / One) from the player bar.
- [ ] Listen Mode → Fullscreen; Esc leaves fullscreen, Esc again closes it;
      the music never stops.
- [ ] Remove from Library → Undo brings the song back (files untouched).
- [ ] Edit Audio on a song with a "/" in its genre (e.g. "Hip Hop/R&B"):
      saves, and the genre is unchanged.
- [ ] Editor: zoom in (buttons and Ctrl + wheel), scroll, Fit to View; click
      the waveform while playing and the playhead keeps moving.
- [ ] Listen Mode: the frame around the artwork moves with the music and
      stops when paused; a very long title doesn't move the controls.
- [ ] Manage → Storage shows sizes; Clean Up frees what's listed; your
      songs and music folders are untouched.
- [ ] Delete File on a song in the WaveMint Library folder: confirmation lists
      the file; it lands in the Recycle Bin; a song from a read-only folder
      is refused.
- [ ] Settings → YouTube Access shows "Automatic · no sign-in" and Advanced
      Authentication is collapsed on a fresh install.
- [ ] Progress shows plain phases (Analyzing video… / Preparing audio… /
      Downloading audio… with a real % / Extracting audio… / Processing
      artwork… / Writing metadata…) and no invented percentages.
- [ ] **Cancel** during an extraction: it stops, no error appears, and no
      song or partial file is added to the library.
- [ ] Unplug the network: Analyze shows "WaveMint couldn't connect to
      YouTube…" with **Retry** and **Details**, within about 30 seconds.
- [ ] An unavailable video (e.g. `https://www.youtube.com/watch?v=aaaaaaaaaaa`)
      shows "This video isn't available for extraction." without a Retry
      button. **Details → Copy Error Details** copies a report that contains no
      cookies, tokens or `C:\Users\<name>` paths.

## Extraction engine

- [ ] Settings → Extraction Engine shows the bundled yt-dlp version as
      "built-in". **Check for Updates** reports Up to date (or an update).
- [ ] Switch the channel to **Nightly**, **Check for Updates**, **Install**.
      The stages run (signature, download, test) and the version shows
      "updated (nightly)". A video still analyzes and extracts.
- [ ] Restart WaveMint: the updated engine is still active (About line and
      Settings agree).
- [ ] **Use Built-in Version** switches back; **Use <version>** switches to the
      update again. Set the channel back to **Stable**.
- [ ] Offline: **Check for Updates** shows "Unable to check" and extraction of
      already-analyzed content is unaffected.

## Authentication

For each browser installed on the test PC (Chrome, Edge, Firefox, Brave,
Opera, Vivaldi, Chromium), with a profile that is signed in to YouTube:

- [ ] Settings → YouTube Access → Advanced Authentication → Browser Cookies lists the browser as **Detected** and shows its
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
      not found" with a **YouTube Access** button.
- [ ] **Remove** switches back to Off and leaves the file on disk. **Remove
      Authentication** turns sign-in off and forgets browser, profile and file.
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
