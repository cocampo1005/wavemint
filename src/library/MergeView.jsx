import { useState } from "react";
import { Dialog } from "./Dialog";
import { artworkUrl, formatBytes, formatDate, formatDuration, formatNumber, formatQuality, pluralize } from "./format";
import { CheckIcon, MergeIcon, PauseIcon, PlayIcon, RefreshIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const CATEGORIES = [
  { id: "conflict", label: "Needs a decision", help: "Probably different versions (a remaster, a different length). Nothing happens until you choose." },
  { id: "already_curated", label: "Already in curated", help: "Songs your curated library already has. The curated copy is kept; other copies become alternate versions." },
  { id: "legacy_only", label: "Only in legacy", help: "Songs that exist only in your older library. They stay in your library as they are." },
  { id: "curated_only", label: "Only in curated", help: "Songs that exist only in your curated library." },
  { id: "other_only", label: "Only in other folders", help: "Songs from folders that are neither legacy nor curated." },
];

const ACTION_LABELS = {
  keep_preferred: "Merge",
  merge_metadata: "Merge, fill gaps",
  keep_both: "Keep separate",
  skip: "Decide later",
  review: "Undecided",
  keep: "Keep",
};

const ROLE_TONE = { curated: "success", managed: "success", legacy: "quiet", other: "info" };

function Summary({ summary }) {
  const items = [
    ["Songs in sources", summary.sourceTracks],
    ["Songs after merge", summary.expectedTracks, "estimate, with current choices"],
    ["Already in curated", summary.alreadyCurated],
    ["Only in legacy", summary.legacyOnly],
    ["Exact copies", summary.exactDuplicateGroups, "identical files"],
    ["Need a decision", summary.undecidedConflicts],
  ];
  return (
    <section className="panel lib-stats" aria-label="Merge summary">
      {items.map(([label, value, hint]) => (
        <div key={label} className="lib-stat">
          <span className="lib-stat__value">{formatNumber(value ?? 0)}</span>
          <span className="lib-stat__label">{label}</span>
          {hint && <span className="lib-stat__hint">{hint}</span>}
        </div>
      ))}
    </section>
  );
}

function MergeGroup({ group, editable, playing, onPlay, onAction }) {
  const multi = group.members.length > 1;
  const pairs = group.evidence?.pairs || [];
  const notes = [...new Map(pairs.flatMap((pair) => pair.notes || []).map((note) => [note.text, note])).values()];
  const choices = group.category === "conflict" ? ["keep_preferred", "merge_metadata", "keep_both", "review"] : ["keep_preferred", "merge_metadata", "keep_both", "skip"];

  return (
    <div className={`lib-merge-group is-${group.category}`}>
      <div className="lib-merge-group__members">
        {group.members.map((member) => {
          const preferred = member.id === group.preferred_track_id;
          const isPlaying = playing?.fileId === member.file_id && playing.isPlaying;
          return (
            <div key={member.id} className={`lib-merge-member ${multi && preferred ? "is-preferred" : ""}`}>
              {member.artwork_hash ? (
                <img className="lib-merge-member__art" src={artworkUrl(member.artwork_hash, 64)} alt="" loading="lazy" />
              ) : (
                <span className="lib-merge-member__art lib-art-placeholder" />
              )}
              <button type="button" className="lib-play" aria-label={isPlaying ? "Pause" : `Play ${member.title}`} onClick={() => onPlay(member)}>
                {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
              </button>
              <div className="lib-merge-member__text">
                <strong>{member.title || "Untitled"}</strong>
                <span>
                  {member.artist || "Unknown artist"}
                  {member.album ? ` · ${member.album}` : ""}
                  {member.year ? ` (${member.year})` : ""}
                </span>
                <span className="lib-merge-member__path" title={member.rel_path}>
                  {member.rel_path}
                </span>
              </div>
              <div className="lib-merge-member__meta">
                <span className={`lib-badge is-name is-${ROLE_TONE[member.source_role] || "quiet"}`}>{member.source_name}</span>
                <span>{formatQuality(member)}</span>
                <span>
                  {formatDuration(member.duration_ms)} · {formatBytes(member.size)}
                </span>
              </div>
              {multi && (
                <label className="lib-merge-member__keep">
                  <input
                    type="radio"
                    name={`preferred-${group.id}`}
                    checked={preferred}
                    disabled={!editable}
                    onChange={() => onAction(group, group.action === "review" || group.action === "skip" ? "keep_preferred" : group.action, member.id)}
                  />
                  Keep this
                </label>
              )}
            </div>
          );
        })}
      </div>

      {multi && (
        <div className="lib-merge-group__foot">
          <div className="lib-merge-group__evidence">
            {group.evidence?.exact && <span className="lib-badge is-success">Identical files</span>}
            {notes.slice(0, 5).map((note) => (
              <span key={note.text} className={`lib-badge ${note.weight < 0 ? "is-warn" : "is-quiet"}`}>
                {note.text}
              </span>
            ))}
            {group.confidence != null && <span className="lib-merge-group__confidence">{Math.round(group.confidence * 100)}% match</span>}
          </div>
          {editable ? (
            <div className="segmented lib-merge-group__actions" role="group" aria-label="What to do">
              {choices.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`segmented__option ${group.action === action ? "is-active" : ""}`}
                  onClick={() => onAction(group, action)}
                >
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </div>
          ) : (
            <span className="lib-badge is-quiet">{ACTION_LABELS[group.action]}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ApplyDialog({ session, onClose, onApplied, onError }) {
  const proposals = session.summary.albumProposals || [];
  const [albums, setAlbums] = useState(() => new Set(proposals.map((proposal) => proposal.fromReleaseId)));
  const [applying, setApplying] = useState(false);
  const { summary } = session;

  const apply = async () => {
    setApplying(true);
    try {
      const result = await libraryApi.applyMerge({ sessionId: session.id, acceptedAlbums: [...albums] });
      onApplied(result);
    } catch (error) {
      onError(errorMessage(error));
      setApplying(false);
    }
  };

  return (
    <Dialog
      title="Apply merge"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn btn--primary ${applying ? "is-loading" : ""}`} disabled={applying} onClick={apply}>
            Apply Merge
          </button>
        </>
      }
    >
      <p>
        Your library will show about <strong>{formatNumber(summary.expectedTracks)}</strong> songs instead of{" "}
        {formatNumber(summary.sourceTracks)}. Merged copies stay available as alternate versions of each song.
      </p>
      <p className="settings-note">
        This only changes WaveMint&apos;s library. No file is copied, moved, renamed or deleted, and you can undo it from History.
        {summary.undecidedConflicts > 0 &&
          ` ${pluralize(summary.undecidedConflicts, "group")} without a decision will be left as separate songs and offered again next time.`}
      </p>

      {proposals.length > 0 && (
        <div className="lib-merge-albums">
          <span className="section-label">Complete albums</span>
          <p className="settings-hint">
            Some songs that stay from your legacy library belong to an album your curated library has under a slightly different name.
            Selected albums get the curated album&apos;s name, album artist and year.
          </p>
          {proposals.map((proposal) => (
            <label key={proposal.fromReleaseId} className="lib-edit__bool">
              <input
                type="checkbox"
                checked={albums.has(proposal.fromReleaseId)}
                onChange={(event) =>
                  setAlbums((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(proposal.fromReleaseId);
                    else next.delete(proposal.fromReleaseId);
                    return next;
                  })
                }
              />
              <span>
                Move {pluralize(proposal.trackIds.length, "song")} from &ldquo;{proposal.fromTitle}&rdquo; into &ldquo;{proposal.toTitle}&rdquo;
              </span>
            </label>
          ))}
        </div>
      )}
      {(summary.albumNotes || []).map((note) => (
        <p key={`${note.fromReleaseId}-${note.toReleaseId}`} className="settings-hint">
          {note.text}
        </p>
      ))}
    </Dialog>
  );
}

export function MergeView({ revision, analyzing, playing, onPlay, onChanged, onError }) {
  const [category, setCategory] = useState("");
  const [onlyMulti, setOnlyMulti] = useState(true);
  const [limit, setLimit] = useState(50);
  const [applyOpen, setApplyOpen] = useState(false);
  const [done, setDone] = useState(null);

  const { data: session, reload: reloadSession } = useLoader(() => libraryApi.currentMergeSession(), [revision]);
  const sessionId = session?.id;
  const { data: groups, reload: reloadGroups } = useLoader(
    () => (sessionId ? libraryApi.listMergeGroups({ sessionId, category: category || undefined, onlyMulti, limit }) : null),
    [sessionId, category, onlyMulti, limit, revision],
  );

  const act = async (action) => {
    try {
      await action();
      reloadSession();
      reloadGroups();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const analyze = () => {
    setDone(null);
    act(() => libraryApi.analyzeMerge());
  };

  const editable = session?.status === "analyzed";
  const summary = session?.summary;
  const counts = summary
    ? {
        conflict: summary.undecidedConflicts,
        already_curated: summary.alreadyCurated,
        legacy_only: summary.legacyOnly,
        curated_only: summary.curatedOnly,
        other_only: summary.otherOnly,
      }
    : {};
  const sources = summary?.sources || [];
  const hasCurated = sources.some((source) => source.role === "curated" || source.role === "managed");
  const help = CATEGORIES.find((item) => item.id === category)?.help;

  return (
    <div className="lib-merge">
      <section className="panel lib-merge__intro">
        <MergeIcon size={22} />
        <div>
          <strong>Combine your libraries</strong>
          <p className="settings-hint">
            WaveMint compares every source, groups copies of the same recording and keeps your curated copy where one exists. Analysis and
            merging only change WaveMint&apos;s library, never your music files.
          </p>
          {sources.length > 0 && !hasCurated && (
            <p className="settings-hint">Tip: mark your carefully edited folder as Curated in Sources so its copies are preferred.</p>
          )}
        </div>
        <div className="lib-merge__intro-actions">
          {session && (
            <span className="settings-hint">
              {session.status === "applied" ? `Applied ${formatDate(session.applied_at)}` : `Analyzed ${formatDate(session.created_at)}`}
            </span>
          )}
          <button type="button" className={`btn ${session ? "btn--secondary" : "btn--primary"} ${analyzing ? "is-loading" : ""}`} disabled={analyzing} onClick={analyze}>
            <RefreshIcon size={14} /> {session ? "Analyze Again" : "Analyze Libraries"}
          </button>
        </div>
      </section>

      {done && (
        <div className="lib-notice" role="status">
          <CheckIcon size={16} />
          <span>
            Merged: {pluralize(done.linked, "copy", "copies")} linked as alternate versions
            {done.album?.tracks ? `, ${pluralize(done.album.tracks, "song")} moved into curated albums` : ""}. Undo it from History
            if needed.
          </span>
        </div>
      )}

      {summary && <Summary summary={summary} />}

      {session && (
        <div className="lib-merge__body">
          <div className="lib-toolbar">
            <div className="segmented" role="group" aria-label="Category">
              <button type="button" className={`segmented__option ${category === "" ? "is-active" : ""}`} onClick={() => setCategory("")}>
                All
              </button>
              {CATEGORIES.filter((item) => counts[item.id] > 0 || category === item.id).map((item) => (
                <button key={item.id} type="button" className={`segmented__option ${category === item.id ? "is-active" : ""}`} onClick={() => setCategory(item.id)}>
                  {item.label}
                  {counts[item.id] > 0 && <span className="lib-tab-count">{formatNumber(counts[item.id])}</span>}
                </button>
              ))}
            </div>
            <label className="lib-edit__bool">
              <input type="checkbox" checked={onlyMulti} onChange={(event) => setOnlyMulti(event.target.checked)} />
              Only songs with several copies
            </label>
            <span className="lib-toolbar__count">{groups ? pluralize(groups.total, "group") : "…"}</span>
            {editable && (
              <div className="lib-toolbar__actions">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => act(() => libraryApi.acceptMergeSuggestions({ sessionId, categories: ["already_curated", "legacy_only", "curated_only", "other_only"] }))}
                >
                  <CheckIcon size={14} /> Accept Suggestions
                </button>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setApplyOpen(true)}>
                  Apply Merge…
                </button>
              </div>
            )}
          </div>
          {help && <p className="settings-hint lib-merge__help">{help}</p>}
          {!editable && <p className="settings-hint lib-merge__help">This merge has been applied. Analyze again to look for anything new.</p>}

          <div className="lib-merge__groups">
            {(groups?.rows || []).map((group) => (
              <MergeGroup
                key={group.id}
                group={group}
                editable={editable}
                playing={playing}
                onPlay={(member) => onPlay({ id: member.id, file_id: member.file_id, title: member.title, artist: member.artist, artwork_hash: member.artwork_hash })}
                onAction={(item, action, preferredTrackId) =>
                  act(() => libraryApi.setMergeGroupAction({ groupId: item.id, action, preferredTrackId }))
                }
              />
            ))}
            {groups && !groups.rows.length && <p className="lib-empty-note">Nothing in this category.</p>}
          </div>
          {groups && groups.total > groups.rows.length && (
            <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 50)}>
              Show more
            </button>
          )}
        </div>
      )}

      {applyOpen && session && (
        <ApplyDialog
          session={session}
          onClose={() => setApplyOpen(false)}
          onError={onError}
          onApplied={(result) => {
            setApplyOpen(false);
            setDone(result);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
