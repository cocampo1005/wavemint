import { useState } from "react";
import { MusicBrainzConsent } from "./IdentifyDialog";
import { formatNumber, pluralize } from "./format";
import { CheckIcon, SearchIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const TABS = [
  ["suggested", "Suggestions", "matched"],
  ["uncertain", "Uncertain", "uncertain"],
  ["no_match", "No match", "no_match"],
  ["applied", "Applied", "applied"],
  ["dismissed", "Dismissed", "dismissed"],
];

function summaryOf(item) {
  const get = (name) => item.fields.find((field) => field.field === name)?.suggested;
  const album = get("album");
  const year = get("year");
  const track = get("trackNo");
  return [album && `${album}${year ? ` (${year})` : ""}`, track && `track ${track}`].filter(Boolean).join(" · ");
}

export function IdentifyView({ revision, identifying, onReview, onChanged, onError }) {
  const [tab, setTab] = useState("suggested");
  const [limit, setLimit] = useState(100);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const { data: summary, reload: reloadSummary } = useLoader(() => libraryApi.identificationSummary(), [revision]);
  const { data, error, reload } = useLoader(() => libraryApi.listIdentifications({ status: tab, limit }), [tab, limit, revision]);

  const act = async (action) => {
    try {
      await action();
      reload();
      reloadSummary();
      onChanged();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  const counts = summary?.counts || {};
  const tabCount = (key) => (key === "no_match" ? (counts.no_match || 0) + (counts.error || 0) : counts[key] || 0);

  return (
    <div className="lib-quality">
      <section className="panel lib-merge__intro">
        <SearchIcon size={22} />
        <div>
          <strong>Identify with MusicBrainz</strong>
          <p className="settings-hint">
            WaveMint looks songs up in MusicBrainz and suggests album, year, track numbers and identifiers. Nothing changes until you approve it,
            and anything applied can be undone from History. To match a whole album at once, open the album and choose Identify Album.
          </p>
          {summary?.enabled && (
            <p className="settings-hint">
              {formatNumber(summary.unidentified)} song{summary.unidentified === 1 ? "" : "s"} not looked up yet. Lookups run about one song per
              second, as MusicBrainz asks.
            </p>
          )}
        </div>
        {summary?.enabled && (
          <div className="lib-merge__intro-actions">
            <button
              type="button"
              className={`btn btn--secondary ${identifying ? "is-loading" : ""}`}
              disabled={identifying || !summary.unidentified}
              onClick={() => act(() => libraryApi.identifySongs({ onlyNew: true }))}
            >
              Identify {formatNumber(summary.unidentified)} Song{summary.unidentified === 1 ? "" : "s"}
            </button>
            <button type="button" className="btn btn--link" onClick={() => act(() => libraryApi.updateSettings({ patch: { musicBrainzEnabled: false } }))}>
              Turn off lookups
            </button>
          </div>
        )}
      </section>

      {summary && !summary.enabled && (
        <section className="panel">
          <MusicBrainzConsent onEnabled={() => act(() => Promise.resolve())} onError={onError} />
        </section>
      )}

      <div className="lib-chips" role="group" aria-label="Identification results">
        {TABS.map(([key, label, countKey]) => (
          <button key={key} type="button" className={`lib-chip ${tab === key ? "is-on" : ""}`} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
            {tabCount(countKey) > 0 && <span className="lib-tab-count">{formatNumber(tabCount(countKey))}</span>}
          </button>
        ))}
      </div>

      <div className="lib-toolbar">
        <span className="lib-toolbar__count">{data ? pluralize(data.total, "song") : "…"}</span>
        {tab === "suggested" && summary?.confident > 0 && (
          <div className="lib-toolbar__actions">
            {confirmBulk ? (
              <span className="lib-confirm">
                Apply the suggested changes for {pluralize(summary.confident, "song")} matched at 90% or more? Fields you edited yourself are left
                alone.
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmBulk(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => {
                    setConfirmBulk(false);
                    act(() => libraryApi.applyConfidentIdentifications({ minConfidence: 0.9 }));
                  }}
                >
                  Apply
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmBulk(true)}>
                <CheckIcon size={14} /> Apply Confident Matches…
              </button>
            )}
          </div>
        )}
      </div>
      {error && <div className="alert alert--compact">{error}</div>}

      <div className="lib-quality__list">
        {(data?.rows || []).map((item) => (
          <div key={item.trackId} className="lib-quality-row">
            <button type="button" className="lib-quality-row__text" onClick={() => onReview(item.trackId)}>
              <strong>{item.title || "Untitled"}</strong>
              <span>
                {item.artist || "Unknown artist"}
                {item.album ? ` · ${item.album}` : ""}
              </span>
              <span>{item.error ? item.error : summaryOf(item) ? `MusicBrainz: ${summaryOf(item)}` : item.status === "no_match" ? "Not found" : ""}</span>
            </button>
            <div className="lib-merge-member__meta">
              {item.confidence !== null && item.confidence !== undefined && <span>{Math.round(item.confidence * 100)}% match</span>}
              <span>{pluralize(item.fields.filter((field) => !field.same && !field.identifier).length, "change")}</span>
            </div>
            <div className="lib-quality-row__actions">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => onReview(item.trackId)}>
                Review…
              </button>
              {(tab === "suggested" || tab === "uncertain") && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => libraryApi.dismissIdentifications({ trackIds: [item.trackId] }))}>
                  Dismiss
                </button>
              )}
            </div>
          </div>
        ))}
        {data && !data.rows.length && <p className="lib-empty-note">Nothing here.</p>}
      </div>
      {data && data.total > data.rows.length && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 100)}>
          Show more
        </button>
      )}
    </div>
  );
}
