import { useState } from "react";
import { artworkUrl, formatNumber, formatQuality, pluralize } from "./format";
import { PauseIcon, PlayIcon, QualityIcon, SearchIcon, UpgradeIcon } from "./icons";
import { errorMessage, libraryApi, useDebounced, useLoader } from "./useLibrary";

const VIEWS = [
  ["attention", "Needs attention"],
  ["review_suggested", "Review suggested"],
  ["user_marked_poor", "Marked poor"],
  ["upgrade_available", "Upgrade available"],
  ["unknown", "Not checked"],
  ["acceptable", "Acceptable"],
  ["keep_original", "Kept original"],
  ["upgraded", "Upgraded"],
  ["all", "All"],
];

const STATUS_TONE = {
  review_suggested: "warn",
  user_marked_poor: "error",
  upgrade_available: "info",
  upgraded: "success",
  acceptable: "quiet",
  keep_original: "quiet",
  unknown: "quiet",
};

const BITRATES = [
  ["", "Any bitrate"],
  ["128", "≤ 128 kbps"],
  ["160", "≤ 160 kbps"],
  ["192", "≤ 192 kbps"],
  ["256", "≤ 256 kbps"],
];

export function QualityView({ revision, checking, playing, onPlay, onOpenTrack, onUpgrade, onChanged, onError }) {
  const [view, setView] = useState("attention");
  const [search, setSearch] = useState("");
  const [maxBitrate, setMaxBitrate] = useState("");
  const [sort, setSort] = useState("severity");
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState(() => new Set());
  const query = useDebounced(search);

  const { data: summary } = useLoader(() => libraryApi.qualitySummary(), [revision]);
  const { data, error, reload } = useLoader(
    () => libraryApi.listQualityQueue({ view, search: query || undefined, maxBitrate: maxBitrate ? Number(maxBitrate) : undefined, sort, limit }),
    [view, query, maxBitrate, sort, limit, revision],
  );

  const act = async (action) => {
    try {
      await action();
      setSelected(new Set());
      reload();
      onChanged();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  const setStatus = (trackIds, status) => act(() => libraryApi.setQualityStatus({ trackIds, status }));
  const rows = data?.rows || [];
  const ids = [...selected];
  const counts = summary?.counts || {};
  const viewCount = (key) =>
    key === "attention" ? (counts.review_suggested || 0) + (counts.user_marked_poor || 0) + (counts.upgrade_available || 0) : key === "all" ? summary?.total : counts[key];

  return (
    <div className="lib-quality">
      <section className="panel lib-merge__intro">
        <QualityIcon size={22} />
        <div>
          <strong>Audio quality</strong>
          <p className="settings-hint">
            WaveMint points out files worth a listen: low bitrates, damaged or incomplete files, and lossy files hiding behind a high bitrate or a
            lossless format. These are hints, not verdicts; a lower-bitrate file from a good source can sound better. Your decisions are kept.
          </p>
          {summary && (
            <p className="settings-hint">
              {formatNumber(summary.checked)} of {formatNumber(summary.total)} songs checked.
            </p>
          )}
        </div>
        <div className="lib-merge__intro-actions">
          <button
            type="button"
            className={`btn btn--secondary ${checking ? "is-loading" : ""}`}
            disabled={checking || (summary && summary.checked >= summary.total)}
            onClick={() => act(() => libraryApi.checkQuality({}))}
            title="Decodes every unchecked song once (about half a second each)"
          >
            Check Unchecked Songs
          </button>
        </div>
      </section>

      <div className="lib-chips lib-quality__views" role="group" aria-label="Quality status">
        {VIEWS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`lib-chip ${view === key ? "is-on" : ""}`}
            aria-pressed={view === key}
            onClick={() => {
              setView(key);
              setSelected(new Set());
            }}
          >
            {label}
            {viewCount(key) > 0 && <span className="lib-tab-count">{formatNumber(viewCount(key))}</span>}
          </button>
        ))}
      </div>

      <div className="lib-toolbar">
        <label className="lib-search">
          <SearchIcon size={16} />
          <input type="search" className="lib-search__input" placeholder="Search title, artist, album…" aria-label="Search songs" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <select className="field" aria-label="Bitrate" value={maxBitrate} onChange={(event) => setMaxBitrate(event.target.value)}>
          {BITRATES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select className="field" aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="severity">Most urgent first</option>
          <option value="bitrate">Lowest bitrate first</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
          <option value="title">Title</option>
        </select>
        <span className="lib-toolbar__count">{data ? pluralize(data.total, "song") : "…"}</span>
        {ids.length > 0 && (
          <div className="lib-toolbar__actions">
            <span className="settings-hint">{ids.length} selected</span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setStatus(ids, "user_marked_poor")}>
              Mark Poor
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setStatus(ids, "keep_original")}>
              Keep Original
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setStatus(ids, "acceptable")}>
              Acceptable
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => libraryApi.checkQuality({ trackIds: ids, force: true }))} disabled={checking}>
              Check Again
            </button>
          </div>
        )}
      </div>

      {error && <div className="alert alert--compact">{error}</div>}

      <div className="lib-quality__list">
        {rows.map((row) => {
          const isPlaying = playing?.fileId === row.file_id && playing.isPlaying;
          const reasons = row.quality?.reasons || [];
          return (
            <div key={row.id} className={`lib-quality-row ${selected.has(row.id) ? "is-selected" : ""}`}>
              <input
                type="checkbox"
                aria-label={`Select ${row.title}`}
                checked={selected.has(row.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(row.id);
                    else next.delete(row.id);
                    return next;
                  })
                }
              />
              {row.artwork_hash ? <img className="lib-merge-member__art" src={artworkUrl(row.artwork_hash, 64)} alt="" loading="lazy" /> : <span className="lib-merge-member__art lib-art-placeholder" />}
              <button type="button" className="lib-play" aria-label={isPlaying ? "Pause" : `Play ${row.title}`} onClick={() => onPlay({ id: row.id, file_id: row.file_id, title: row.title, artist: row.artist, artwork_hash: row.artwork_hash })}>
                {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
              </button>
              <button type="button" className="lib-quality-row__text" onClick={() => onOpenTrack(row.id)}>
                <strong>{row.title || "Untitled"}</strong>
                <span>
                  {row.artist || "Unknown artist"}
                  {row.album ? ` · ${row.album}` : ""}
                </span>
                <span className="lib-quality-row__reasons">
                  {reasons.map((item) => (
                    <span key={item.code} className={`lib-badge is-name ${item.level >= 3 ? "is-error" : item.level === 2 ? "is-warn" : "is-quiet"}`}>
                      {item.text}
                    </span>
                  ))}
                  {!reasons.length && !row.quality?.checked && <span className="settings-hint">Not checked yet</span>}
                </span>
              </button>
              <div className="lib-merge-member__meta">
                <span className={`lib-badge is-name is-${STATUS_TONE[row.quality_status] || "quiet"}`}>{summary?.labels?.[row.quality_status] || row.quality_status}</span>
                <span>{formatQuality(row)}</span>
                {row.pending_candidates > 0 && <span>{pluralize(row.pending_candidates, "replacement")} waiting</span>}
              </div>
              <div className="lib-quality-row__actions">
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => onUpgrade(row.id)}>
                  <UpgradeIcon size={14} /> Upgrade…
                </button>
                <select
                  className="field lib-quality-row__status"
                  aria-label="Quality decision"
                  value=""
                  onChange={(event) => event.target.value && setStatus([row.id], event.target.value)}
                >
                  <option value="">Decide…</option>
                  <option value="user_marked_poor">Mark poor quality</option>
                  <option value="keep_original">Keep in original form</option>
                  <option value="acceptable">Acceptable</option>
                  <option value="upgraded">Mark upgraded</option>
                  {row.quality_set_by !== "auto" && <option value="auto">Let WaveMint decide</option>}
                </select>
              </div>
            </div>
          );
        })}
        {data && !rows.length && (
          <p className="lib-empty-note">
            {view === "attention" ? "Nothing needs attention here. Check unchecked songs to look for hidden problems." : "No songs."}
          </p>
        )}
      </div>
      {data && data.total > rows.length && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 100)}>
          Show more
        </button>
      )}
    </div>
  );
}
