import { useEffect, useRef, useState } from "react";
import { Artwork } from "./Artwork";
import { formatDate, pluralize } from "./format";
import { CheckIcon, RefreshIcon, SearchIcon } from "./icons";
import { WithSongPanel } from "./SongPanel";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

function describe(item) {
  const d = item.details || {};
  switch (item.kind) {
    case "missing_album_artist":
      return `${d.album}: ${pluralize(d.tracks, "song")} without an album artist`;
    case "track_numbering":
      return `${d.album}: ${(d.problems || []).join("; ")}`;
    case "inconsistent_album":
      return `${d.album}: ${(d.differences || []).join("; ")}`;
    case "similar_albums":
      return `"${d.album}" looks like "${d.similarTo}"`;
    case "unclassified_genre":
      return d.label ? `Genre "${d.label}" isn't in your genre list` : "No genre";
    case "missing_artwork":
      return "No artwork";
    case "missing_album":
      return "No album";
    case "missing_artist":
      return "No artist";
    case "incomplete_album":
      return `${d.album}: ${d.have} of ${d.total} songs; missing track${d.missing?.length === 1 ? "" : "s"} ${(d.missing || []).join(", ")}`;
    case "uncertain_match":
      return `MusicBrainz might know this song${d.album ? ` (from "${d.album}"${d.year ? `, ${d.year}` : ""})` : ""}; ${Math.round((d.confidence || 0) * 100)}% match.`;
    case "possible_duplicate":
      return `${pluralize((d.trackIds || []).length, "song")} share this artist and title`;
    default:
      return "";
  }
}

/**
 * Find Artwork for one song, right in the review list: the cover found from
 * the song's title, artist and album is shown first, and only saved (into
 * the file) when the user chooses Use.
 */
function QuickArtwork({ trackId, onSaved, onError }) {
  const [state, setState] = useState({ phase: "idle" }); // idle | finding | found | none | saving
  const find = async () => {
    setState({ phase: "finding" });
    try {
      const found = await libraryApi.findArtwork({ trackId });
      setState(found ? { phase: "found", found } : { phase: "none" });
    } catch (error) {
      setState({ phase: "idle" });
      onError(errorMessage(error, "Artwork couldn't be looked up."));
    }
  };
  const use = async () => {
    setState((current) => ({ ...current, phase: "saving" }));
    try {
      await libraryApi.saveTrack({ trackId, artworkHash: state.found.hash });
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
          Use
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

/**
 * Metadata and organization that need attention: missing details, artwork,
 * genres, album problems, possible duplicates. Songs open in a panel beside
 * the list (edit, Find Artwork, Identify) and the list updates as issues are
 * fixed. File problems are in File Health; audio quality in Quality & Upgrades.
 */
export function ReviewView({ revision, initialKind = "", browserProps, onChanged, onOpenAlbum, onNavigate, onError }) {
  const [kind, setKind] = useState(initialKind);
  const [status, setStatus] = useState("open");
  const [openTrack, setOpenTrack] = useState(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // The queue refreshes once when the view opens.
  const [refreshing, setRefreshing] = useState(true);
  const [limit, setLimit] = useState(100);
  const [confirmAll, setConfirmAll] = useState(false);

  const { data: summary, reload: reloadSummary } = useLoader(() => libraryApi.reviewSummary(), [revision]);
  const { data, error, reload } = useLoader(() => libraryApi.listReviewItems({ kind: kind || undefined, status, limit }), [kind, status, limit, revision]);

  // The queue is refreshed when the view opens, so it reflects edits made
  // since the last scan.
  useEffect(() => {
    let cancelled = false;
    libraryApi
      .refreshReview()
      .then(() => {
        if (!cancelled) {
          reloadSummary();
          reload();
          // Navigation badges follow the refreshed counts.
          onChangedRef.current?.();
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setRefreshing(false));
    return () => {
      cancelled = true;
    };
  }, [reload, reloadSummary]);

  // After a fix (here or in the song panel) the issue resolves itself.
  const refreshAfterFix = () =>
    libraryApi
      .refreshReview()
      .catch(() => {})
      .finally(() => onChanged());

  const act = async (action) => {
    try {
      await action();
      await refreshAfterFix();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  const suggested = (data?.rows || []).filter((item) => item.status === "suggested");
  const kinds = Object.entries(summary?.kinds || {});
  const panelProps = { ...browserProps, onChanged: refreshAfterFix };

  // The main action for each kind of issue.
  const fixAction = (item) => {
    const open = item.status === "needs_review" || item.status === "suggested";
    if (item.entity_type === "release") {
      return (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => onOpenAlbum(item.entity_id, item.release_title)}>
          Open Album
        </button>
      );
    }
    if (item.entity_type !== "track") return null;
    if (item.kind === "missing_artwork" && open) return <QuickArtwork trackId={item.entity_id} onSaved={refreshAfterFix} onError={onError} />;
    if (item.kind === "possible_duplicate") {
      return (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => onNavigate("merge")}>
          Review Matches
        </button>
      );
    }
    if (item.kind === "uncertain_match" && browserProps.onIdentify) {
      return (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => browserProps.onIdentify(item.entity_id)}>
          Identify…
        </button>
      );
    }
    return null;
  };

  return (
    <WithSongPanel trackId={openTrack} onClose={() => setOpenTrack(null)} browserProps={panelProps}>
      <div className="lib-review">
        <div className={`lib-review__layout ${openTrack ? "is-narrow" : ""}`}>
          {/* With a song open beside the list, the issue types fold into a dropdown. */}
          {openTrack && (
            <select className="field lib-review__kind-select" aria-label="Issue type" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">All issues ({summary?.open ?? "…"})</option>
              {kinds.map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label} ({value.open})
                </option>
              ))}
            </select>
          )}
          {!openTrack && (
            <aside className="lib-review__kinds" aria-label="Issue types">
              <button type="button" className={`lib-kind ${kind === "" ? "is-active" : ""}`} onClick={() => setKind("")}>
                <span>All issues</span>
                <span className="lib-kind__count">{summary?.open ?? "…"}</span>
              </button>
              {kinds.map(([key, value]) => (
                <button key={key} type="button" className={`lib-kind ${kind === key ? "is-active" : ""}`} onClick={() => setKind(key)}>
                  <span>{value.label}</span>
                  <span className="lib-kind__count">{value.open}</span>
                </button>
              ))}
            </aside>
          )}

          <div className="lib-review__main">
            <div className="lib-toolbar">
              <div className="segmented" role="group" aria-label="Status">
                {[
                  ["open", "Open"],
                  ["ignored", "Ignored"],
                  ["resolved", "Resolved"],
                  ["approved", "Approved"],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={`segmented__option ${status === value ? "is-active" : ""}`} onClick={() => setStatus(value)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="lib-toolbar__count">{data ? pluralize(data.total, "item") : "…"}</span>
              <div className="lib-toolbar__actions">
                {status === "open" &&
                  suggested.length > 0 &&
                  (confirmAll ? (
                    <span className="lib-confirm">
                      Apply {pluralize(suggested.length, "suggested fix", "suggested fixes")}?
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmAll(false)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => {
                          setConfirmAll(false);
                          act(() => libraryApi.approveSuggestions({ ids: suggested.map((item) => item.id) }));
                        }}
                      >
                        Apply All
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmAll(true)}>
                      Apply All Suggestions…
                    </button>
                  ))}
                <button type="button" className={`btn btn--ghost btn--sm ${refreshing ? "is-loading" : ""}`} onClick={() => act(() => Promise.resolve())}>
                  <RefreshIcon size={14} /> Refresh
                </button>
              </div>
            </div>

            {error && <div className="alert alert--compact">{error}</div>}

            <div className="lib-review__list">
              {(data?.rows || []).map((item) => (
                <div key={item.id} className={`lib-review-item is-${item.status} ${openTrack && openTrack === item.entity_id && item.entity_type === "track" ? "is-active" : ""}`}>
                  <Artwork className="lib-review-item__art" hash={item.entity_type === "track" ? item.track_artwork : null} size={64} loading="lazy" />
                  <div className="lib-review-item__body">
                    <div className="lib-review-item__title">
                      <span className="lib-badge is-quiet">{item.label}</span>
                      {item.entity_type === "track" ? (
                        <button type="button" className="lib-review-item__open" onClick={() => setOpenTrack(item.entity_id)}>
                          {`${item.track_title || "Untitled"} — ${item.track_artist || "Unknown artist"}`}
                        </button>
                      ) : (
                        <strong>{item.entity_type === "release" ? `${item.release_title}${item.release_artist ? ` — ${item.release_artist}` : ""}` : "File"}</strong>
                      )}
                    </div>
                    <span className="lib-review-item__text">{describe(item)}</span>
                    {item.suggestion && <span className="lib-review-item__suggestion">Suggested: {item.suggestion.label}</span>}
                    {item.status !== "needs_review" && item.status !== "suggested" && (
                      <span className="lib-review-item__text">
                        {item.status[0].toUpperCase() + item.status.slice(1)} {formatDate(item.updated_at)}
                      </span>
                    )}
                  </div>
                  <div className="lib-review-item__actions">
                    {fixAction(item)}
                    {item.entity_type === "track" && (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpenTrack(item.entity_id)}>
                        Edit
                      </button>
                    )}
                    {item.suggestion && (item.status === "suggested" || item.status === "needs_review") && (
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => act(() => libraryApi.approveSuggestions({ ids: [item.id] }))}>
                        <CheckIcon size={14} /> Apply
                      </button>
                    )}
                    {item.status === "ignored" ? (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => libraryApi.setReviewStatus({ ids: [item.id], status: "needs_review" }))}>
                        Reopen
                      </button>
                    ) : (
                      item.status !== "resolved" && (
                        <>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => libraryApi.setReviewStatus({ ids: [item.id], status: "ignored" }))}>
                            Ignore
                          </button>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => libraryApi.setReviewStatus({ ids: [item.id], status: "resolved" }))}>
                            Resolved
                          </button>
                        </>
                      )
                    )}
                  </div>
                </div>
              ))}
              {data && !data.rows.length && <p className="lib-empty-note">{status === "open" ? "Nothing to review here. Nice." : "No items."}</p>}
            </div>
            {data && data.total > data.rows.length && (
              <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 100)}>
                Show more
              </button>
            )}
          </div>
        </div>
      </div>
    </WithSongPanel>
  );
}
