// Classic iTunes for Windows, driven through its COM automation interface
// ("iTunes.Application").
//
// COM needs a single-threaded apartment and can block for as long as iTunes
// shows a dialog, so it never runs inside WaveMint: each batch of operations
// is handed to a short-lived Windows PowerShell process (-STA) as a JSON
// file, and it answers with one JSON line per operation. WaveMint can
// therefore time the batch out, cancel it, or give up if iTunes stops
// answering, without ever blocking the library worker or the window.
//
// What this adapter relies on (and what is NOT assumed):
//   - LibraryPlaylist.AddFile / UpdateInfoFromFile / Delete / persistent IDs
//     are documented parts of the iTunes COM interface.
//   - A file track's `Location` may be read-only in the installed iTunes. The
//     bridge checks the property's actual definition (Get-Member) before it
//     tries to change it and reports `unsupported` instead of guessing, so the
//     sync engine can fall back to a transparent "re-create and carry over".
//   - Whether iTunes copies added files into its media folder cannot be read
//     through COM. It is detected afterwards: the added track's Location is
//     compared with the path that was added.
//
// This module is Windows-only at run time. The sync engine only uses the
// adapter interface returned by createItunesAdapter, so tests (and a future
// Apple Music adapter) can stand in for it.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runCommand } = require("../processes.cjs");

class AppleSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$ops = [IO.File]::ReadAllText($args[0], $utf8) | ConvertFrom-Json
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
$script:app = $null
$script:lib = $null

function Connect([bool]$launch) {
  $running = [bool](Get-Process -Name iTunes -ErrorAction SilentlyContinue)
  if (-not $running -and -not $launch) { return $false }
  $script:app = New-Object -ComObject iTunes.Application
  $script:lib = $script:app.LibraryPlaylist
  return $true
}
function PidOf($o) {
  $h = 0; $l = 0
  $script:app.GetITObjectPersistentIDs($o, [ref]$h, [ref]$l)
  return ('{0:X8}{1:X8}' -f [int]$h, [int]$l)
}
function Split-Pid([string]$p) {
  return @([Convert]::ToInt32($p.Substring(0, 8), 16), [Convert]::ToInt32($p.Substring(8, 8), 16))
}
function ByPid([string]$p) {
  $ids = Split-Pid $p
  try { return $script:lib.Tracks.ItemByPersistentID($ids[0], $ids[1]) } catch { return $null }
}
function PlaylistByPid([string]$p) {
  $ids = Split-Pid $p
  $pl = $null
  try { $pl = $script:app.LibrarySource.Playlists.ItemByPersistentID($ids[0], $ids[1]) } catch { }
  if ($null -eq $pl) {
    foreach ($candidate in $script:app.LibrarySource.Playlists) { if ((PidOf $candidate) -eq $p) { $pl = $candidate; break } }
  }
  if ($null -eq $pl) { return $null }
  # Only ordinary user playlists are ever edited: never the library, a folder or a smart list.
  if ($pl -and $pl.Kind -eq 2 -and $pl.SpecialKind -eq 0 -and -not $pl.Smart) { return $pl }
  return $null
}
function ArtCount($t) {
  try { return [int]$t.Artwork.Count } catch { return -1 }
}
function Info($t) {
  $loc = ''
  try { $loc = [string]$t.Location } catch { }
  return [ordered]@{
    pid = (PidOf $t); name = [string]$t.Name; artist = [string]$t.Artist; album = [string]$t.Album; genre = [string]$t.Genre
    year = [int]$t.Year; trackNumber = [int]$t.TrackNumber; discNumber = [int]$t.DiscNumber; duration = [int]$t.Duration
    rating = [int]$t.Rating; playedCount = [int]$t.PlayedCount; skippedCount = [int]$t.SkippedCount
    kind = [int]$t.Kind; size = [long]$t.Size; location = $loc; artworkCount = (ArtCount $t)
    exists = [bool]($loc -and (Test-Path -LiteralPath $loc))
  }
}
function Playlist-Pids($pl) {
  $out = @()
  $n = $pl.Tracks.Count
  for ($i = 1; $i -le $n; $i++) { $out += (PidOf $pl.Tracks.Item($i)) }
  return $out
}

foreach ($op in $ops) {
  $id = $op.id
  try {
    # Every batch is its own process, so it attaches to a running iTunes itself.
    if ($op.op -ne 'detect' -and $op.op -ne 'connect' -and $null -eq $script:app -and -not (Connect $false)) { throw 'iTunes is not running' }
    if ($op.op -eq 'detect') {
      $running = [bool](Get-Process -Name iTunes -ErrorAction SilentlyContinue)
      # The registered automation class, the Microsoft Store package or the classic installer.
      $installed = $running -or (Test-Path 'Registry::HKEY_CLASSES_ROOT\iTunes.Application') -or (Test-Path (Join-Path $env:ProgramFiles 'iTunes\iTunes.exe'))
      if (-not $installed) { try { $installed = [bool](Get-AppxPackage -Name 'AppleInc.iTunes' -ErrorAction SilentlyContinue) } catch { } }
      $music = $false
      try { $music = [bool](Get-AppxPackage -Name 'AppleInc.AppleMusicWin' -ErrorAction SilentlyContinue) } catch { }
      Emit @{ id = $id; ok = $true; itunesInstalled = $installed; itunesRunning = $running; appleMusicInstalled = $music }
    }
    elseif ($op.op -eq 'connect') {
      if (-not (Connect ([bool]$op.launch))) { Emit @{ id = $id; ok = $true; running = $false } }
      else {
        $xml = ''
        try { $xml = [string]$script:app.LibraryXMLPath } catch { }
        Emit @{ id = $id; ok = $true; running = $true; version = [string]$script:app.Version; libraryId = (PidOf $script:lib); libraryPath = $xml; trackCount = [int]$script:lib.Tracks.Count }
      }
    }
    elseif ($op.op -eq 'probe') {
      $sample = $null
      $n = [Math]::Min([int]$script:lib.Tracks.Count, 300)
      for ($i = 1; $i -le $n; $i++) { $t = $script:lib.Tracks.Item($i); if ($t.Kind -eq 1) { $sample = $t; break } }
      if ($null -eq $sample) { Emit @{ id = $id; ok = $true; locationSettable = $null } }
      else {
        $m = $sample | Get-Member -Name Location -ErrorAction SilentlyContinue
        $def = [string]$m.Definition
        Emit @{ id = $id; ok = $true; locationSettable = [bool]($def -match '\{set\}'); definition = $def }
      }
    }
    elseif ($op.op -eq 'list') {
      $n = [int]$script:lib.Tracks.Count
      for ($i = 1; $i -le $n; $i++) {
        $t = $script:lib.Tracks.Item($i)
        # Every file song, including those whose file iTunes can't find right now:
        # iTunes reports an empty Location for them, and hiding them would make
        # WaveMint think the entry is gone (and add the song twice).
        if ($t.Kind -eq 1) { Emit @{ id = $id; item = (Info $t) } }
        if ($i % 500 -eq 0) { Emit @{ id = $id; progress = $i; total = $n } }
      }
      Emit @{ id = $id; ok = $true; count = $n }
    }
    elseif ($op.op -eq 'get') {
      $t = ByPid $op.pid
      if ($null -eq $t) { Emit @{ id = $id; ok = $true; found = $false } } else { Emit @{ id = $id; ok = $true; found = $true; info = (Info $t) } }
    }
    elseif ($op.op -eq 'add') {
      $st = $script:lib.AddFile([string]$op.path)
      $deadline = (Get-Date).AddSeconds(90)
      while ($st.InProgress -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
      if ($st.InProgress) { throw 'iTunes took too long to add the file' }
      if ([int]$st.Tracks.Count -lt 1) { throw 'iTunes did not add the file' }
      Emit @{ id = $id; ok = $true; info = (Info $st.Tracks.Item(1)) }
    }
    elseif ($op.op -eq 'update') {
      $t = ByPid $op.pid
      if ($null -eq $t) { throw 'The song is not in iTunes' }
      $t.UpdateInfoFromFile()
      Emit @{ id = $id; ok = $true; info = (Info $t) }
    }
    elseif ($op.op -eq 'setLocation') {
      $t = ByPid $op.pid
      if ($null -eq $t) { throw 'The song is not in iTunes' }
      $def = [string]($t | Get-Member -Name Location).Definition
      if ($def -notmatch '\{set\}') { Emit @{ id = $id; ok = $true; unsupported = $true; definition = $def } }
      else {
        $t.Location = [string]$op.path
        $t.UpdateInfoFromFile()
        Emit @{ id = $id; ok = $true; info = (Info $t) }
      }
    }
    elseif ($op.op -eq 'delete') {
      $t = ByPid $op.pid
      if ($null -eq $t) { Emit @{ id = $id; ok = $true; gone = $true } }
      else {
        if ($t.Kind -ne 1) { throw 'Only file songs are removed' }
        $t.Delete()
        Emit @{ id = $id; ok = $true; gone = ($null -eq (ByPid $op.pid)) }
      }
    }
    elseif ($op.op -eq 'carry') {
      $from = ByPid $op.from
      $to = ByPid $op.to
      if ($null -eq $from -or $null -eq $to) { throw 'One of the songs is not in iTunes' }
      $notes = @()
      foreach ($name in @('Rating', 'PlayedCount', 'SkippedCount', 'PlayedDate', 'SkippedDate')) {
        try { if ($from.$name) { $to.$name = $from.$name } } catch { $notes += "$name not carried over" }
      }
      foreach ($p in @($op.playlists)) {
        if (-not $p) { continue }
        $pl = PlaylistByPid $p
        if ($null -eq $pl) { $notes += 'a playlist was not found'; continue }
        try { $pl.AddTrack($to) } catch { $notes += "could not add to $($pl.Name)" }
      }
      Emit @{ id = $id; ok = $true; notes = $notes; info = (Info $to) }
    }
    elseif ($op.op -eq 'playlists') {
      foreach ($p in $script:app.LibrarySource.Playlists) {
        if ($p.Kind -ne 2) { continue }
        $row = [ordered]@{ pid = (PidOf $p); name = [string]$p.Name; smart = [bool]$p.Smart; special = [int]$p.SpecialKind; count = [int]$p.Tracks.Count }
        if ($op.withTracks -and $p.SpecialKind -eq 0 -and -not $p.Smart) { $row.tracks = @(Playlist-Pids $p) }
        Emit @{ id = $id; item = $row }
      }
      Emit @{ id = $id; ok = $true }
    }
    elseif ($op.op -eq 'playlistCreate') {
      $pl = $script:app.CreatePlaylist([string]$op.name)
      Emit @{ id = $id; ok = $true; pid = (PidOf $pl); name = [string]$pl.Name }
    }
    elseif ($op.op -eq 'playlistRename') {
      $pl = PlaylistByPid $op.pid
      if ($null -eq $pl) { throw 'The playlist is not in iTunes' }
      $pl.Name = [string]$op.name
      Emit @{ id = $id; ok = $true; name = [string]$pl.Name }
    }
    elseif ($op.op -eq 'playlistDelete') {
      $pl = PlaylistByPid $op.pid
      if ($null -eq $pl) { Emit @{ id = $id; ok = $true; gone = $true } } else { $pl.Delete(); Emit @{ id = $id; ok = $true; gone = $true } }
    }
    elseif ($op.op -eq 'playlistSet') {
      $pl = PlaylistByPid $op.pid
      if ($null -eq $pl) { throw 'The playlist is not in iTunes' }
      $want = @($op.tracks)
      $have = @(Playlist-Pids $pl)
      if (($want -join ',') -ne ($have -join ',')) {
        $wantSet = @{}; foreach ($p in $want) { $wantSet[$p] = $true }
        # Songs that don't belong are taken out of this playlist only (never out of the library).
        for ($i = $pl.Tracks.Count; $i -ge 1; $i--) {
          $t = $pl.Tracks.Item($i)
          if (-not $wantSet.ContainsKey((PidOf $t))) { $t.Delete() }
        }
        $have = @(Playlist-Pids $pl)
        $inOrder = (@($want | Where-Object { $have -contains $_ }) -join ',') -eq ($have -join ',')
        if (-not $inOrder) {
          for ($i = $pl.Tracks.Count; $i -ge 1; $i--) { $pl.Tracks.Item($i).Delete() }
          $have = @()
        }
        foreach ($p in $want) {
          if ($have -contains $p) { continue }
          $t = ByPid $p
          if ($null -ne $t) { $pl.AddTrack($t) }
        }
      }
      Emit @{ id = $id; ok = $true; tracks = @(Playlist-Pids $pl) }
    }
    else { throw "Unknown operation $($op.op)" }
  }
  catch { Emit @{ id = $id; ok = $false; error = $_.Exception.Message } }
}
`;

const NOT_INSTALLED = /80040154|REGDB_E_CLASSNOTREG|class not registered|Retrieving the COM class factory/i;

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

/**
 * @param {object} options
 * @param {string} options.workDir  where the bridge script and operation files live
 * @param {Function} [options.run]  replaces the PowerShell call (tests): (ops, { launch, signal }) => results
 */
function createItunesAdapter({ workDir, run = null, logger = console, stallMs = 120000, totalMs = 45 * 60 * 1000 }) {
  let nextId = 1;

  function scriptFile() {
    const name = `itunes-bridge-${crypto.createHash("sha1").update(BRIDGE).digest("hex").slice(0, 10)}.ps1`;
    const target = path.join(workDir, name);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(workDir, { recursive: true });
      // PowerShell 5.1 reads a UTF-8 script correctly only with a BOM.
      fs.writeFileSync(target, `\ufeff${BRIDGE}`, "utf8");
    }
    return target;
  }

  /**
   * Runs operations in one PowerShell process. Resolves to a Map from each
   * operation's id to { ok, ..., items: [] }. Rejects with an AppleSyncError
   * when iTunes can't be reached or stops answering.
   */
  async function exec(ops, { signal, onProgress } = {}) {
    const numbered = ops.map((op) => ({ ...op, id: nextId++ }));
    if (run) return run(numbered, { signal, onProgress });
    if (process.platform !== "win32") throw new AppleSyncError("unavailable", "Classic iTunes is only available on Windows.");

    fs.mkdirSync(workDir, { recursive: true });
    const opsFile = path.join(workDir, `ops-${process.pid}-${Date.now()}-${numbered[0]?.id}.json`);
    fs.writeFileSync(opsFile, JSON.stringify(numbered), "utf8");

    const results = new Map(numbered.map((op) => [op.id, { items: [] }]));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let stalled = false;
    let timer = null;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, stallMs);
    };
    bump();

    let outcome;
    try {
      outcome = await runCommand(powershellPath(), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptFile(), opsFile], {
        label: "Windows PowerShell",
        timeoutMs: totalMs,
        signal: controller.signal,
        onStdoutLine: (line) => {
          bump();
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          const entry = results.get(message.id);
          if (!entry) return;
          if (message.item) entry.items.push(message.item);
          else if (message.progress) onProgress?.({ done: message.progress, total: message.total });
          else Object.assign(entry, message);
        },
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fs.rmSync(opsFile, { force: true });
    }

    if (signal?.aborted) throw new AppleSyncError("cancelled", "Cancelled.");
    if (stalled || outcome.timedOut) {
      throw new AppleSyncError("unresponsive", "iTunes stopped responding. Check iTunes for a message or dialog that needs an answer, then try again.");
    }
    const closed = [...results.values()].find((entry) => entry.ok === false && /iTunes is not running/.test(entry.error || ""));
    if (closed) throw new AppleSyncError("not-running", "iTunes isn't running. Open iTunes and try again.");
    const failedConnect = [...results.values()].find((entry) => entry.ok === false && NOT_INSTALLED.test(entry.error || ""));
    if (failedConnect) throw new AppleSyncError("not-installed", "Classic iTunes isn't installed on this PC (its automation interface wasn't found).");
    if (outcome.code !== 0 && ![...results.values()].some((entry) => entry.ok !== undefined)) {
      logger.warn?.(`[apple] PowerShell exited with ${outcome.code}: ${String(outcome.stderr).trim().slice(0, 300)}`);
      throw new AppleSyncError("unavailable", "Windows PowerShell couldn't talk to iTunes.");
    }
    for (const entry of results.values()) {
      if (entry.ok === undefined) Object.assign(entry, { ok: false, error: "No answer from iTunes (the operation didn't finish)" });
    }
    return results;
  }

  const single = async (op, options) => [...(await exec([op], options)).values()][0];
  const failure = (entry) => new AppleSyncError("operation-failed", String(entry.error || "iTunes reported an error").slice(0, 300));

  return {
    // The real iTunes, through COM. (Test stand-ins call themselves something else.)
    kind: "itunes-com",
    AppleSyncError,

    async detect() {
      if (process.platform !== "win32" && !run) return { kind: "itunes", itunesInstalled: false, itunesRunning: false, appleMusicInstalled: false };
      const entry = await single({ op: "detect" });
      return { kind: "itunes", itunesInstalled: !!entry.itunesInstalled, itunesRunning: !!entry.itunesRunning, appleMusicInstalled: !!entry.appleMusicInstalled };
    },

    /** Whether iTunes is running (a cheap process check; nothing is started). */
    async isRunning() {
      if (run) return true;
      if (process.platform !== "win32") return false;
      try {
        const result = await runCommand("tasklist", ["/FI", "IMAGENAME eq iTunes.exe", "/FO", "CSV", "/NH"], { label: "tasklist", timeoutMs: 15000 });
        return /"iTunes\.exe"/i.test(result.stdout || "");
      } catch {
        return false;
      }
    },

    /** Connects to iTunes. Without `launch`, a closed iTunes is reported, not started. */
    async connect({ launch = false, signal } = {}) {
      const entry = await single({ op: "connect", launch }, { signal });
      if (!entry.ok) {
        if (NOT_INSTALLED.test(entry.error || "")) throw new AppleSyncError("not-installed", "Classic iTunes isn't installed on this PC (its automation interface wasn't found).");
        throw failure(entry);
      }
      if (!entry.running) return { connected: false, running: false };
      return { connected: true, running: true, version: entry.version, libraryId: entry.libraryId, libraryPath: entry.libraryPath, trackCount: entry.trackCount };
    },

    async probe({ signal } = {}) {
      const entry = await single({ op: "probe" }, { signal });
      if (!entry.ok) throw failure(entry);
      return { locationSettable: entry.locationSettable ?? null, definition: entry.definition || null };
    },

    /** Every file song in the library (kind 1), as plain objects. */
    async listTracks({ signal, onProgress } = {}) {
      const entry = await single({ op: "list" }, { signal, onProgress });
      if (!entry.ok) throw failure(entry);
      return entry.items;
    },

    /** Map from persistent ID to the song's current details (null when it isn't in iTunes). */
    async getTracks(pids, { signal } = {}) {
      const unique = [...new Set(pids)];
      const results = unique.length ? await exec(unique.map((pid) => ({ op: "get", pid })), { signal }) : new Map();
      const out = new Map();
      unique.forEach((pid, index) => {
        const entry = [...results.values()][index];
        if (!entry.ok) throw failure(entry);
        out.set(pid, entry.found ? entry.info : null);
      });
      return out;
    },

    /** Adds files; one result per path: { ok, info } or { ok: false, error }. */
    async addFiles(paths, { signal } = {}) {
      if (!paths.length) return [];
      return [...(await exec(paths.map((file) => ({ op: "add", path: file })), { signal })).values()].map(({ ok, info, error }) => ({ ok, info, error }));
    },

    async updateFromFile(pids, { signal } = {}) {
      if (!pids.length) return [];
      return [...(await exec(pids.map((pid) => ({ op: "update", pid })), { signal })).values()].map(({ ok, info, error }) => ({ ok, info, error }));
    },

    /** { ok, unsupported } or { ok, info }. */
    async setLocation(pid, file, { signal } = {}) {
      const { ok, unsupported, info, error } = await single({ op: "setLocation", pid, path: file }, { signal });
      return { ok, unsupported: !!unsupported, info, error };
    },

    async deleteTracks(pids, { signal } = {}) {
      if (!pids.length) return [];
      return [...(await exec(pids.map((pid) => ({ op: "delete", pid })), { signal })).values()].map(({ ok, gone, error }) => ({ ok: ok && gone !== false, error: error || (gone === false ? "iTunes still lists the song" : undefined) }));
    },

    /** Copies rating and play history to a new entry and adds it to the same playlists. */
    async carryOver({ from, to, playlists = [] }, { signal } = {}) {
      const { ok, notes, error } = await single({ op: "carry", from, to, playlists }, { signal });
      return { ok, notes: notes || [], error };
    },

    async listPlaylists({ withTracks = false, signal } = {}) {
      const entry = await single({ op: "playlists", withTracks }, { signal });
      if (!entry.ok) throw failure(entry);
      return entry.items;
    },
    async createPlaylist(name, { signal } = {}) {
      const entry = await single({ op: "playlistCreate", name }, { signal });
      if (!entry.ok) throw failure(entry);
      return { pid: entry.pid, name: entry.name };
    },
    async renamePlaylist(pid, name, { signal } = {}) {
      const entry = await single({ op: "playlistRename", pid, name }, { signal });
      if (!entry.ok) throw failure(entry);
      return { name: entry.name };
    },
    async deletePlaylist(pid, { signal } = {}) {
      const entry = await single({ op: "playlistDelete", pid }, { signal });
      if (!entry.ok) throw failure(entry);
      return { gone: true };
    },
    async setPlaylistTracks(pid, trackPids, { signal } = {}) {
      const entry = await single({ op: "playlistSet", pid, tracks: trackPids }, { signal });
      if (!entry.ok) throw failure(entry);
      return { tracks: [].concat(entry.tracks ?? []) };
    },
  };
}

module.exports = { AppleSyncError, createItunesAdapter };
