import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { useToast } from "../toasts/useToast";
import { Artwork } from "./Artwork";
import { Dialog } from "./Dialog";
import { formatBytes, formatDate, formatDuration, formatNumber, formatQuality, pluralize } from "./format";
import { CheckIcon, HeartIcon, MergeIcon, PauseIcon, PlayIcon, RefreshIcon, SearchIcon } from "./icons";
import { DiagnosticsPanel } from "./LibraryFiles";
import { WithSongPanel } from "./SongPanel";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

// Review answers three questions, one tab each: which songs are missing
// important information, which songs might be duplicates, and is anything
// wrong with the files. Every issue says what's wrong, why it was flagged
// and how to fix it, and can be fixed right here (the song opens beside the
// list). Optional details (year, track numbers, genre…) and audio quality
// are never flagged.

const TABS = [
  ["attention", "Needs Attention"],
  ["duplicates", "Possible Duplicates"],
  ["diagnostics", "Diagnostics"],
];

const ATTENTION_KINDS = {
  missing_title: {
    title: "Missing title",
    why: "These songs have no title, so they show as “Untitled” here, in iTunes and on your iPhone.",
    fix: "Use the file name (suggested), or open the song and type the title.",
  },
  missing_artist: {
    title: "Missing artist",
    why: "Without an artist, these songs aren't listed under Artists and show as “Unknown Artist” in iTunes.",
    fix: "Open the song and set its artist.",
  },
  placeholder: {
    title: "Placeholder details",
    why: "These look like values a ripper or tagger filled in, such as “Unknown Artist” or “Track 01”.",
    fix: "Open the song and correct the field. If the value is intentional, choose Keep As Is.",
  },
  missing_album: {
    title: "Missing album",
    why: "Songs without an album are listed apart from your albums. Singles and standalone songs are often fine this way.",
    fix: "Set the album, use the song's title as the album (a single), or choose Keep As Is.",
  },
  missing_artwork: {
    title: "Missing artwork",
    why: "These songs show a placeholder cover here, in iTunes and on your iPhone.",
    fix: "Find Artwork looks the cover up from the title, artist and album; or open the song and choose an image.",
  },
};
const ATTENTION_ORDER = Object.keys(ATTENTION_KINDS);

const TIERS = {
  identical: { label: "Identical files", tone: "is-success", help: "The same file or the same audio more than once." },
  likely: { label: "Likely duplicate", tone: "is-warn", help: "Same artist, title, version and length." },
  possible: { label: "Possible match", tone: "is-quiet", help: "Similar, but not certain: compare before deciding." },
};

const FIELD_NAMES = { title: "Title", artist: "Artist", album: "Album" };

/** Undo from a toast, the same way History does. */
function useUndoToast(onChanged) {
  const { notify } = useToast();
  return (text, operationId) =>
    notify({
      text,
      action: operationId
        ? {
            label: "Undo",
            onClick: () =>
              libraryApi
                .undoOperation({ id: operationId })
                .then(() => {
                  onChanged();
                  notify({ text: "Restored." });
                })
                .catch((error) => notify({ tone: "error", text: errorMessage(error, "That couldn't be undone") })),
          }
        : null,
    });
}

/**
 * Find Artwork for a song or a whole album, right in the list: the cover
 * found from the title, artist and album is shown first and only saved
 * (into the files) when the user chooses Use.
 */
function QuickArtwork({ trackIds, onSaved, onError }) {
  const [state, setState] = useState({ phase: "idle" }); // idle | finding | found | none | saving
  const find = async () => {
    setState({ phase: "finding" });
    try {
      const found = await libraryApi.findArtwork({ trackId: trackIds[0] });
      setState(found ? { phase: "found", found } : { phase: "none" });
    } catch (error) {
      setState({ phase: "idle" });
      onError(errorMessage(error, "Artwork couldn't be looked up."));
    }
  };
  const use = async () => {
    setState((current) => ({ ...current, phase: "saving" }));
    try {
      await libraryApi.saveTrack({ trackId: trackIds[0], artworkHash: state.found.hash });
      if (trackIds.length > 1) await libraryApi.copyArtwork({ trackIds: trackIds.slice(1), fromTrackId: trackIds[0] });
      onSaved();
    } catch (error) {
      setState((current) => ({ ...current, phase: "found" }));
      onError(errorMessage(error, "The artwork couldn't be saved."));
    }
  };

  if (state.phase === "found" || state.phase === "saving") {
    return (
      <span className="lib-quickart">
        <Artwork className="lib-quickart__img" hash={state.found.hash} size={64} alt="Found cover" />
        <span className="lib-quickart__text">{[state.found.release.title, state.found.release.year].filter(Boolean).join(" · ")}</span>
        <button type="button" className={`btn btn--secondary btn--sm ${state.phase === "saving" ? "is-loading" : ""}`} disabled={state.phase === "saving"} onClick={use}>
          {trackIds.length > 1 ? `Use for ${trackIds.length} Songs` : "Use"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={state.phase === "saving"} onClick={() => setState({ phase: "idle" })}>
          Skip
        </button>
      </span>
    );
  }
  return (
    <>
      {state.phase === "none" && <span className="settings-hint">No cover found</span>}
      <button type="button" className={`btn btn--secondary btn--sm ${state.phase === "finding" ? "is-loading" : ""}`} disabled={state.phase === "finding"} onClick={find}>
        <SearchIcon size={13} /> Find Artwork
      </button>
    </>
  );
}

/** What's wrong with this song, in one line. */
function describeIssue(item) {
  switch (item.kind) {
    case "missing_title":
      return item.details.fileName ? `No title. The file is named “${item.details.fileName}”.` : "No title.";
    case "missing_artist":
      return "No artist.";
    case "missing_album":
      return "No album.";
    case "placeholder":
      return (item.details.fields || []).map((entry) => `${FIELD_NAMES[entry.field] || entry.field} is “${entry.value}”`).join(" · ");
    default:
      return "";
  }
}

/** One song (or one album, for artwork) in Needs Attention. */
function AttentionRow({ entry, open, active, onOpen, onApply, onStatus, onSaved, onError }) {
  const item = entry.items[0];
  const album = entry.items.length > 1;
  const ids = entry.items.map((value) => value.entity_id);
  return (
    <div className={`lib-review-item is-${item.status} ${active ? "is-active" : ""}`}>
      <Artwork className="lib-review-item__art" hash={item.track_artwork} size={64} loading="lazy" />
      <div className="lib-review-item__body">
        <div className="lib-review-item__title">
          {album ? (
            <strong>
              {item.track_album || "Album"}
              {item.track_artist ? ` — ${item.track_artist}` : ""}
            </strong>
          ) : (
            <button type="button" className="lib-review-item__open" onClick={() => onOpen(item.entity_id)}>
              {`${item.track_title || "Untitled"} — ${item.track_artist || "Unknown artist"}`}
            </button>
          )}
        </div>
        <span className="lib-review-item__text">
          {album ? `${pluralize(entry.items.length, "song")} of this album have no artwork` : describeIssue(item) || (item.track_album ? item.track_album : "")}
        </span>
        {item.suggestion && open && <span className="lib-review-item__suggestion">Suggested: {item.suggestion.label}</span>}
        {!open && (
          <span className="lib-review-item__text">
            {item.status === "ignored" ? "Kept as is" : item.status[0].toUpperCase() + item.status.slice(1)} {formatDate(item.updated_at)}
          </span>
        )}
      </div>
      <div className="lib-review-item__actions">
        {item.kind === "missing_artwork" && open && <QuickArtwork trackIds={ids} onSaved={onSaved} onError={onError} />}
        {item.suggestion && open && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => onApply(entry.items)}>
            <CheckIcon size={14} /> {item.kind === "missing_album" ? "Use as Single" : "Apply"}
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpen(item.entity_id)}>
          Edit
        </button>
        {open ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onStatus(entry.items, "ignored")} title="Stop flagging this. It stays this way until you reopen it.">
            Keep As Is
          </button>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onStatus(entry.items, "needs_review")}>
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}

function NeedsAttention({ revision, summary, openTrack, onOpen, onRefresh, onError }) {
  const [showKept, setShowKept] = useState(false);
  const [limit, setLimit] = useState(300);
  const [confirm, setConfirm] = useState(null); // kind whose suggestions to apply
  const { data, error } = useLoader(() => libraryApi.listReviewItems({ group: "attention", status: showKept ? "ignored" : "open", limit }), [revision, showKept, limit]);
  const { data: settings, reload: reloadSettings } = useLoader(() => libraryApi.getSettings(), [revision]);

  const act = async (action) => {
    try {
      await action();
      await onRefresh();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  // Group by kind; artwork by album, so an album without a cover is one row.
  const sections = useMemo(() => {
    const byKind = new Map(ATTENTION_ORDER.map((kind) => [kind, []]));
    for (const item of data?.rows || []) {
      const list = byKind.get(item.kind);
      if (!list) continue;
      const releaseId = item.kind === "missing_artwork" ? item.details.releaseId : null;
      const existing = releaseId ? list.find((entry) => entry.releaseId === releaseId) : null;
      if (existing) existing.items.push(item);
      else list.push({ key: `${item.kind}:${item.id}`, releaseId, items: [item] });
    }
    return [...byKind.entries()].filter(([, entries]) => entries.length);
  }, [data]);

  const open = !showKept;
  const albumCheckOff = settings && settings.reviewMissingAlbum === false;
  const total = summary?.groups?.attention ?? 0;

  return (
    <div className="lib-attention">
      <div className="lib-toolbar">
        <span className="lib-toolbar__count">{showKept ? `${data ? pluralize(data.total, "item") : "…"} kept as is` : `${formatNumber(total)} to review`}</span>
        <div className="lib-toolbar__actions">
          <label className="lib-edit__bool">
            <input type="checkbox" checked={showKept} onChange={(event) => setShowKept(event.target.checked)} />
            Show kept as is
          </label>
        </div>
      </div>
      {error && <div className="alert alert--compact">{error}</div>}

      {data && !sections.length && (
        <div className="lib-review-empty">
          <CheckIcon size={20} />
          <div>
            <strong>{open ? "Every song has a title, an artist, an album and artwork." : "Nothing is kept as is."}</strong>
            {open && <span>Nothing needs your attention.</span>}
          </div>
        </div>
      )}

      {sections.map(([kind, entries]) => {
        const info = ATTENTION_KINDS[kind];
        const count = entries.reduce((sum, entry) => sum + entry.items.length, 0);
        const suggested = entries.flatMap((entry) => entry.items).filter((item) => item.suggestion && item.status === "suggested");
        return (
          <section key={kind} className="lib-issue-group" aria-label={info.title}>
            <header className="lib-issue-group__head">
              <div>
                <h2 className="lib-issue-group__title">
                  {info.title} <span className="lib-tab-count">{formatNumber(count)}</span>
                </h2>
                <p className="lib-issue-group__why">{info.why}</p>
                <p className="lib-issue-group__fix">{info.fix}</p>
              </div>
              <div className="lib-issue-group__actions">
                {open && suggested.length > 1 && (
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirm(kind)}>
                    {kind === "missing_album" ? "Use Titles as Albums…" : "Apply All Suggestions…"}
                  </button>
                )}
                {kind === "missing_album" && open && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    title="Songs without an album won't be flagged anymore. You can turn this back on below."
                    onClick={() => act(() => libraryApi.updateSettings({ patch: { reviewMissingAlbum: false } }).then(reloadSettings))}
                  >
                    Don&apos;t Flag Missing Albums
                  </button>
                )}
              </div>
            </header>
            <div className="lib-review__list">
              {entries.map((entry) => (
                <AttentionRow
                  key={entry.key}
                  entry={entry}
                  open={open}
                  active={openTrack && entry.items.some((item) => item.entity_id === openTrack)}
                  onOpen={onOpen}
                  onSaved={onRefresh}
                  onError={onError}
                  onApply={(items) => act(() => libraryApi.approveSuggestions({ ids: items.map((item) => item.id) }))}
                  onStatus={(items, status) => act(() => libraryApi.setReviewStatus({ ids: items.map((item) => item.id), status }))}
                />
              ))}
            </div>
          </section>
        );
      })}

      {data && data.total > data.rows.length && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 300)}>
          Show more
        </button>
      )}

      {albumCheckOff && (
        <p className="settings-hint lib-attention__note">
          Songs without an album aren&apos;t flagged.{" "}
          <button type="button" className="btn btn--link" onClick={() => act(() => libraryApi.updateSettings({ patch: { reviewMissingAlbum: true } }).then(reloadSettings))}>
            Flag them again
          </button>
        </p>
      )}

      {confirm && (
        <Dialog
          title={ATTENTION_KINDS[confirm].title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="btn btn--ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  const ids = sections
                    .find(([kind]) => kind === confirm)[1]
                    .flatMap((entry) => entry.items)
                    .filter((item) => item.suggestion && item.status === "suggested")
                    .map((item) => item.id);
                  setConfirm(null);
                  act(() => libraryApi.approveSuggestions({ ids }));
                }}
              >
                Apply to All
              </button>
            </>
          }
        >
          <p>
            {confirm === "missing_album"
              ? "Each song without an album gets its own title as the album, the way singles are usually tagged."
              : "Each song gets the suggested value."}{" "}
            The changes are saved into the files and can be undone from History.
          </p>
        </Dialog>
      )}
    </div>
  );
}

/** One song of a duplicate group, as a card to compare side by side. */
function DuplicateMember({ member, keep, onKeep, playing, onPlay, onOpen }) {
  const isPlaying = playing?.fileId === member.file_id && playing.isPlaying;
  const details = [
    ["Album", member.album || "—"],
    ["Year", member.year || "—"],
    ["Genre", member.genre || "—"],
    ["Format", formatQuality(member) || "—"],
    ["Length", formatDuration(member.duration_ms)],
    ["Size", formatBytes(member.size)],
    ["Added", formatDate(member.created_at)],
    ["Playlists", member.playlist_count ? formatNumber(member.playlist_count) : "—"],
  ];
  return (
    <div className={`lib-dup-member ${keep ? "is-kept" : ""}`}>
      <div className="lib-dup-member__head">
        <Artwork className="lib-dup-member__art" hash={member.artwork_hash} size={96} />
        <div className="lib-dup-member__name">
          <button type="button" className="lib-review-item__open" onClick={() => onOpen(member.id)}>
            {member.title || "Untitled"}
          </button>
          <span>
            {member.artist || "Unknown artist"}
            {member.favorite ? <HeartIcon size={12} filled className="lib-dup-member__fav" /> : null}
          </span>
        </div>
        <button type="button" className="lib-play" aria-label={isPlaying ? "Pause" : `Play ${member.title}`} onClick={() => onPlay(member)} disabled={member.file_status !== "ok"}>
          {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
        </button>
      </div>
      <dl className="lib-dup-member__facts">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <code className="lib-dup-member__path" title={member.path}>
        {member.rel_path || member.path}
      </code>
      <label className="lib-dup-member__keep">
        <input type="radio" checked={keep} onChange={onKeep} />
        Keep this one
      </label>
    </div>
  );
}

/** The member to keep by default: the most complete details, then the larger file. */
function defaultKeep(members) {
  const filled = (member) => ["album", "album_artist", "year", "genre", "artwork_hash"].filter((field) => member[field]).length;
  return [...members].sort((a, b) => filled(b) - filled(a) || (b.lossless || 0) - (a.lossless || 0) || (b.bitrate || 0) - (a.bitrate || 0) || a.id - b.id)[0]?.id;
}

function DuplicateGroup({ item, open, playing, onPlay, onOpen, onMerge, onKeepBoth, onStatus }) {
  const [keepId, setKeepId] = useState(() => defaultKeep(item.members || []));
  const tier = TIERS[item.details.tier] || TIERS.possible;
  if ((item.members || []).length < 2) return null;
  return (
    <section className={`lib-dup is-${item.details.tier}`} aria-label={`${tier.label}: ${item.members[0].title}`}>
      <header className="lib-dup__head">
        <span className={`lib-badge ${tier.tone}`} title={tier.help}>
          {tier.label}
        </span>
        <div className="lib-dup__reasons">
          {(item.details.reasons || []).map((reason) => (
            <span key={reason} className="lib-badge is-quiet">
              {reason}
            </span>
          ))}
        </div>
        {!open && <span className="settings-hint">Dismissed {formatDate(item.updated_at)}</span>}
      </header>
      <div className="lib-dup__members" style={{ "--lib-dup-columns": Math.min(item.members.length, 3) }}>
        {item.members.map((member) => (
          <DuplicateMember key={member.id} member={member} keep={keepId === member.id} onKeep={() => setKeepId(member.id)} playing={playing} onPlay={onPlay} onOpen={onOpen} />
        ))}
      </div>
      <footer className="lib-dup__actions">
        {open ? (
          <>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => onMerge(item, keepId)}>
              <MergeIcon size={14} /> Merge…
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => onKeepBoth(item)} title="They're different recordings. They won't be paired again.">
              Keep Both
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onStatus(item, "ignored")} title="Hide this warning. It comes back only if one of these files changes.">
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onStatus(item, "needs_review")}>
            Show Again
          </button>
        )}
      </footer>
    </section>
  );
}

function MergeDialog({ request, onClose, onDone, onError }) {
  const [fill, setFill] = useState(true);
  const [busy, setBusy] = useState(false);
  const keep = request.item.members.find((member) => member.id === request.keepId);
  const others = request.item.members.filter((member) => member.id !== request.keepId);
  const merge = async () => {
    setBusy(true);
    try {
      const result = await libraryApi.mergeDuplicates({ keepTrackId: keep.id, trackIds: request.item.members.map((member) => member.id), fillMetadata: fill });
      onDone(result, keep);
    } catch (error) {
      onError(errorMessage(error));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Merge duplicates"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn btn--primary ${busy ? "is-loading" : ""}`} disabled={busy} onClick={merge}>
            Merge
          </button>
        </>
      }
    >
      <p>
        Keep <strong>{keep.title || "Untitled"}</strong>
        {keep.album ? ` from “${keep.album}”` : ""} ({formatQuality(keep)}, {formatDuration(keep.duration_ms)}).
      </p>
      <ul className="lib-dup__plan">
        <li>
          {others.length === 1 ? "The other song" : `The other ${others.length} songs`} leave{others.length === 1 ? "s" : ""} your song list. {others.length === 1 ? "Its file stays" : "Their files stay"} on disk as{" "}
          {others.length === 1 ? "an earlier version" : "earlier versions"} of the kept song (Version history), so nothing is deleted.
        </li>
        <li>Playlists follow the kept song, and it stays a favorite if any of them was.</li>
        <li>If {others.length === 1 ? "the other song is" : "the others are"} in iTunes, the next sync asks before removing {others.length === 1 ? "its entry" : "their entries"}.</li>
        <li>You can undo the merge from History.</li>
      </ul>
      <label className="lib-edit__bool">
        <input type="checkbox" checked={fill} onChange={(event) => setFill(event.target.checked)} />
        Fill the kept song&apos;s empty details (album, year, genre…) from the other {others.length === 1 ? "song" : "songs"}
      </label>
    </Dialog>
  );
}

function DuplicatesPanel({ revision, summary, onOpen, onRefresh, onError }) {
  const player = usePlayer();
  const undoToast = useUndoToast(onRefresh);
  const [filter, setFilter] = useState(""); // "" | duplicate | possible_duplicate
  const [showDismissed, setShowDismissed] = useState(false);
  const [limit, setLimit] = useState(30);
  const [merging, setMerging] = useState(null);
  const { data, error } = useLoader(
    () => libraryApi.listReviewItems({ group: "duplicates", kind: filter || undefined, status: showDismissed ? "ignored" : "open", limit }),
    [revision, filter, showDismissed, limit],
  );
  const act = async (action) => {
    try {
      await action();
      await onRefresh();
    } catch (err) {
      onError(errorMessage(err));
    }
  };
  const likely = summary?.kinds?.duplicate?.open ?? 0;
  const possible = summary?.kinds?.possible_duplicate?.open ?? 0;
  const open = !showDismissed;

  return (
    <div className="lib-dups">
      <div className="lib-toolbar">
        <div className="segmented" role="group" aria-label="Which duplicates">
          {[
            ["", "All", likely + possible],
            ["duplicate", "Likely", likely],
            ["possible_duplicate", "Possible", possible],
          ].map(([value, label, count]) => (
            <button key={value || "all"} type="button" className={`segmented__option ${filter === value ? "is-active" : ""}`} onClick={() => setFilter(value)}>
              {label}
              {open && <span className="lib-tab-count">{formatNumber(count)}</span>}
            </button>
          ))}
        </div>
        <div className="lib-toolbar__actions">
          <label className="lib-edit__bool">
            <input type="checkbox" checked={showDismissed} onChange={(event) => setShowDismissed(event.target.checked)} />
            Show dismissed
          </label>
        </div>
      </div>
      <p className="settings-hint lib-dups__intro">
        Songs that may be the same recording: identical files, or the same artist, title and length. Live, remixed, acoustic, instrumental and other versions are never
        paired, and nothing is merged or removed unless you choose to.
      </p>
      {error && <div className="alert alert--compact">{error}</div>}

      {data && !data.rows.length && (
        <div className="lib-review-empty">
          <CheckIcon size={20} />
          <div>
            <strong>{open ? "No duplicates found." : "Nothing dismissed."}</strong>
            {open && <span>Every song in your library appears to be a separate recording.</span>}
          </div>
        </div>
      )}

      <div className="lib-dups__list">
        {(data?.rows || []).map((item) => (
          <DuplicateGroup
            key={`${item.id}:${item.details.filesSig}`}
            item={item}
            open={open}
            playing={player.playing}
            onPlay={(member) => player.playTrack({ id: member.id, file_id: member.file_id, title: member.title, artist: member.artist, artwork_hash: member.artwork_hash })}
            onOpen={onOpen}
            onMerge={(group, keepId) => setMerging({ item: group, keepId })}
            onKeepBoth={(group) =>
              act(async () => {
                const result = await libraryApi.keepDuplicatesSeparate({ trackIds: group.members.map((member) => member.id) });
                undoToast(`Kept as separate songs: “${group.members[0].title || "Untitled"}”.`, result.operationId);
              })
            }
            onStatus={(group, status) => act(() => libraryApi.setReviewStatus({ ids: [group.id], status }))}
          />
        ))}
      </div>
      {data && data.total > data.rows.length && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 30)}>
          Show more ({formatNumber(data.total - data.rows.length)})
        </button>
      )}

      {merging && (
        <MergeDialog
          request={merging}
          onClose={() => setMerging(null)}
          onError={onError}
          onDone={(result, keep) => {
            setMerging(null);
            undoToast(`Merged ${pluralize(result.merged + 1, "song")} into “${keep.title || "Untitled"}”. No file was deleted.`, result.operationId);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Review: Needs Attention (essential metadata), Possible Duplicates and
 * Diagnostics (file problems), with the song panel beside the list.
 */
export function ReviewView({ revision, initialTab = "attention", browserProps, scanning, onChanged, onRemove, onError }) {
  const [tab, setTab] = useState(TABS.some(([id]) => id === initialTab) ? initialTab : "attention");
  const [openTrack, setOpenTrack] = useState(null);
  const [refreshing, setRefreshing] = useState(true);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  const { data: summary, reload: reloadSummary } = useLoader(() => libraryApi.reviewSummary(), [revision]);

  // The queue is refreshed when Review opens, so it reflects every change since the last scan.
  useEffect(() => {
    let cancelled = false;
    libraryApi
      .refreshReview()
      .then(() => {
        if (cancelled) return;
        reloadSummary();
        onChangedRef.current?.();
      })
      .catch(() => {})
      .finally(() => !cancelled && setRefreshing(false));
    return () => {
      cancelled = true;
    };
  }, [reloadSummary]);

  // After a fix (here or in the song panel) the issue resolves itself.
  const refresh = () =>
    libraryApi
      .refreshReview()
      .catch(() => {})
      .finally(() => onChanged());
  const panelProps = { ...browserProps, onChanged: refresh };
  const counts = {
    attention: summary?.groups?.attention,
    duplicates: summary ? (summary.kinds.duplicate?.open || 0) + (summary.kinds.possible_duplicate?.open || 0) : undefined,
    diagnostics: summary?.groups?.diagnostics,
  };

  return (
    <WithSongPanel trackId={openTrack} onClose={() => setOpenTrack(null)} browserProps={panelProps}>
      <div className="lib-review">
        <div className="lib-tabs lib-review__tabs" role="tablist" aria-label="Review">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`lib-tabs__tab ${tab === id ? "is-active" : ""}`} onClick={() => setTab(id)}>
              {label}
              {counts[id] > 0 && <span className={`lib-tabs__count ${id === "diagnostics" ? "is-error" : ""}`}>{formatNumber(counts[id])}</span>}
            </button>
          ))}
          <button type="button" className={`btn btn--ghost btn--sm lib-tabs__end ${refreshing ? "is-loading" : ""}`} onClick={() => refresh()} title="Check the library again">
            <RefreshIcon size={14} /> Refresh
          </button>
        </div>

        {tab === "attention" && <NeedsAttention revision={revision} summary={summary} openTrack={openTrack} onOpen={setOpenTrack} onRefresh={refresh} onError={onError} />}
        {tab === "duplicates" && <DuplicatesPanel revision={revision} summary={summary} onOpen={setOpenTrack} onRefresh={refresh} onError={onError} />}
        {tab === "diagnostics" && (
          <DiagnosticsPanel
            revision={revision}
            scanning={scanning}
            onOpen={setOpenTrack}
            onReplace={(trackId) => browserProps.onUpgrade(trackId)}
            onRemove={onRemove}
            onChanged={refresh}
            onError={onError}
          />
        )}
      </div>
    </WithSongPanel>
  );
}
