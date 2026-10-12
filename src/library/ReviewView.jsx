import { useEffect, useRef, useState } from "react";
import { artworkUrl, formatDate, pluralize } from "./format";
import { CheckIcon, RefreshIcon } from "./icons";
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
    case "file_problem":
      return `${d.status === "missing" ? "Missing" : "Unreadable"}: ${item.file_path || ""}${d.error ? ` (${d.error})` : ""}`;
    case "incomplete_album":
      return `${d.album}: ${d.have} of ${d.total} songs; missing track${d.missing?.length === 1 ? "" : "s"} ${(d.missing || []).join(", ")}`;
    case "uncertain_match":
      return `MusicBrainz might know this song${d.album ? ` (from "${d.album}"${d.year ? `, ${d.year}` : ""})` : ""}; ${Math.round((d.confidence || 0) * 100)}% match. Open the song and choose Identify to review.`;
    case "possible_duplicate":
      return `${pluralize((d.trackIds || []).length, "song")} share this artist and title`;
    default:
      return "";
  }
}

export function ReviewView({ revision, onChanged, onOpenTrack, onOpenAlbum, onError }) {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("open");
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // The queue refreshes once when the view opens.
  const [refreshing, setRefreshing] = useState(true);
  const [limit, setLimit] = useState(100);
  const [confirmAll, setConfirmAll] = useState(false);

  const { data: summary, reload: reloadSummary } = useLoader(() => libraryApi.reviewSummary(), [revision]);
  const { data, error, reload } = useLoader(
    () => libraryApi.listReviewItems({ kind: kind || undefined, status, limit }),
    [kind, status, limit, revision],
  );

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

  const act = async (action) => {
    try {
      await action();
      await libraryApi.refreshReview();
      onChanged();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  const open = (item) => {
    if (item.entity_type === "track") onOpenTrack(item.entity_id);
    else if (item.entity_type === "release") onOpenAlbum(item.entity_id);
    else if (item.file_track_id) onOpenTrack(item.file_track_id);
  };

  const suggested = (data?.rows || []).filter((item) => item.status === "suggested");
  const kinds = Object.entries(summary?.kinds || {});

  return (
    <div className="lib-review">
      <div className="lib-review__layout">
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
              {status === "open" && suggested.length > 0 &&
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
              <div key={item.id} className={`lib-review-item is-${item.status}`}>
                {item.entity_type === "track" && item.track_artwork ? (
                  <img className="lib-review-item__art" src={artworkUrl(item.track_artwork, 64)} alt="" loading="lazy" />
                ) : (
                  <span className="lib-review-item__art lib-art-placeholder" />
                )}
                <div className="lib-review-item__body">
                  <div className="lib-review-item__title">
                    <span className="lib-badge is-quiet">{item.label}</span>
                    <strong>
                      {item.entity_type === "track"
                        ? `${item.track_title || "Untitled"} — ${item.track_artist || "Unknown artist"}`
                        : item.entity_type === "release"
                          ? `${item.release_title}${item.release_artist ? ` — ${item.release_artist}` : ""}`
                          : "File"}
                    </strong>
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
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => open(item)}>
                    Open
                  </button>
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
            {data && !data.rows.length && (
              <p className="lib-empty-note">{status === "open" ? "Nothing to review here. Nice." : "No items."}</p>
            )}
          </div>
          {data && data.total > data.rows.length && (
            <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 100)}>
              Show more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
