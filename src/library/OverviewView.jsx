import { codecLabel, formatBytes, formatDate, formatLongDuration, formatNumber } from "./format";
import { SourceIcon, WarningIcon } from "./icons";
import { libraryApi, useLoader } from "./useLibrary";

function Stat({ label, value, hint }) {
  return (
    <div className="lib-stat">
      <span className="lib-stat__value">{value}</span>
      <span className="lib-stat__label">{label}</span>
      {hint && <span className="lib-stat__hint">{hint}</span>}
    </div>
  );
}

function IssueRow({ label, count, onOpen, tone = "warn" }) {
  return (
    <button type="button" className="lib-issue" onClick={onOpen} disabled={!count}>
      <span className={`lib-issue__dot is-${count ? tone : "ok"}`} aria-hidden="true" />
      <span className="lib-issue__label">{label}</span>
      <span className="lib-issue__count">{formatNumber(count)}</span>
    </button>
  );
}

export function OverviewView({ revision, onNavigate, onAddSource }) {
  const { data, error, loading } = useLoader(() => libraryApi.getOverview(), [revision]);

  if (error) {
    return (
      <div className="alert" role="alert">
        <WarningIcon size={18} />
        <span className="alert__text">{error}</span>
      </div>
    );
  }

  if (!data) return <div className="lib-loading">{loading ? "Loading your library…" : ""}</div>;

  const { totals, issues, formats, duplicates, sources } = data;

  if (!sources.length) {
    return (
      <section className="panel lib-welcome">
        <span className="eyebrow">Your music library</span>
        <h2 className="heading-lg">Bring your music into WaveMint</h2>
        <p className="text-muted">
          Add the folders where your music lives, for example your old iTunes Media folder and your newer curated
          collection. WaveMint only reads them: nothing is moved, renamed or changed.
        </p>
        <div className="lib-welcome__actions">
          <button type="button" className="btn btn--primary" onClick={() => onAddSource("legacy")}>
            Add iTunes / Legacy Folder
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => onAddSource("curated")}>
            Add Curated Folder
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => onAddSource("other")}>
            Add Other Folder
          </button>
        </div>
      </section>
    );
  }

  const totalFormats = formats.reduce((sum, item) => sum + item.count, 0) || 1;

  return (
    <div className="lib-overview">
      <section className="panel lib-stats" aria-label="Library totals">
        <Stat label="Songs" value={formatNumber(totals.tracks)} />
        <Stat label="Albums" value={formatNumber(totals.albums)} />
        <Stat label="Artists" value={formatNumber(totals.artists)} />
        <Stat label="Genres" value={formatNumber(totals.genres)} />
        <Stat label="Storage" value={formatBytes(totals.storage_bytes)} hint={`${formatNumber(totals.file_count)} files`} />
        <Stat label="Listening time" value={formatLongDuration(totals.duration_ms)} />
      </section>

      <div className="lib-overview__grid">
        <section className="panel" aria-labelledby="lib-health">
          <span id="lib-health" className="section-label">
            Library health
          </span>
          <div className="lib-issues">
            <IssueRow label="Songs without an album" count={issues.missing_album} onOpen={() => onNavigate("songs", { quick: ["missingAlbum"] })} />
            <IssueRow label="Songs without a genre" count={issues.missing_genre} onOpen={() => onNavigate("songs", { quick: ["unclassified"] })} />
            <IssueRow label="Songs without artwork" count={issues.missing_artwork} onOpen={() => onNavigate("songs", { quick: ["missingArtwork"] })} />
            <IssueRow label="Albums missing an album artist" count={issues.missing_album_artist} onOpen={() => onNavigate("songs", { quick: ["missingAlbumArtist"] })} tone="quiet" />
            <IssueRow
              label="Possible duplicates"
              count={duplicates.tracks}
              onOpen={() => onNavigate("songs", { quick: ["possibleDuplicates"], sort: "title" })}
              tone="info"
            />
            <IssueRow
              label={`Low bitrate (under ${data.lowBitrateKbps} kbps, lossy)`}
              count={issues.low_bitrate}
              onOpen={() => onNavigate("songs", { quick: ["lowBitrate"] })}
              tone="quiet"
            />
            <IssueRow label="Missing or unreadable files" count={issues.missing_files} onOpen={() => onNavigate("songs", { quick: ["missingFile"] })} tone="error" />
          </div>
          <p className="settings-note">
            Low bitrate is only a hint: a well-encoded file can sound better than a high-bitrate copy of a poor source.
          </p>
        </section>

        <section className="panel" aria-labelledby="lib-formats">
          <span id="lib-formats" className="section-label">
            Formats
          </span>
          <div className="lib-formats">
            {formats.map((item) => (
              <div key={item.codec} className="lib-format">
                <span className="lib-format__label">{codecLabel(item.codec)}</span>
                <span className="lib-format__bar">
                  <span style={{ width: `${Math.max(2, (item.count / totalFormats) * 100)}%` }} />
                </span>
                <span className="lib-format__count">{formatNumber(item.count)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel lib-overview__sources" aria-labelledby="lib-sources">
          <div className="lib-section-head">
            <span id="lib-sources" className="section-label">
              Sources
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate("sources")}>
              Manage
            </button>
          </div>
          <div className="lib-source-mini">
            {sources.map((source) => (
              <button key={source.id} type="button" className="lib-source-mini__row" onClick={() => onNavigate("songs", { sourceId: source.id, chip: source.name })}>
                <SourceIcon size={16} />
                <span className="lib-source-mini__name">{source.name}</span>
                <span className={`lib-badge is-${source.status === "ok" ? "quiet" : "missing"}`}>
                  {source.status === "ok" ? source.role : "Unavailable"}
                </span>
                <span className="lib-source-mini__meta">
                  {formatNumber(source.file_count)} files · {formatBytes(source.total_size)}
                  {source.last_scan_completed_at ? ` · scanned ${formatDate(source.last_scan_completed_at)}` : " · not scanned yet"}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
