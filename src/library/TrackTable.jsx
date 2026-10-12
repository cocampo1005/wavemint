import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { artworkUrl, codecLabel, formatDuration } from "./format";
import { PauseIcon, PlayIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi } from "./useLibrary";

const ROW_HEIGHT = 46;
const PAGE_SIZE = 200;
const OVERSCAN = 12;

const TRACK_COLUMNS = [
  { key: "title", label: "Title", sort: "title", width: "minmax(160px, 2.2fr)" },
  { key: "artist", label: "Artist", sort: "artist", width: "minmax(110px, 1.3fr)" },
  { key: "album", label: "Album", sort: "album", width: "minmax(110px, 1.3fr)" },
  { key: "genre", label: "Genre", sort: "genre", width: "minmax(80px, 0.9fr)" },
  { key: "year", label: "Year", sort: "year", align: "end", width: "52px" },
  { key: "duration", label: "Time", sort: "duration", align: "end", width: "56px" },
  { key: "format", label: "Format", sort: "bitrate", width: "92px" },
  { key: "source", label: "Source", width: "minmax(70px, 0.8fr)" },
];

function qualityText(row) {
  if (!row.codec) return "";
  if (row.lossless) return `${codecLabel(row.codec)}${row.bit_depth ? ` ${row.bit_depth}-bit` : ""}`;
  return `${codecLabel(row.codec)}${row.bitrate ? ` ${row.bitrate}` : ""}`;
}

function StatusBadges({ row, lowBitrate }) {
  const badges = [];
  if (row.file_status === "missing") badges.push(["missing", "File missing"]);
  else if (row.file_status === "unreadable") badges.push(["error", "Unreadable"]);
  if (row.version_count > 1) badges.push(["info", `${row.version_count} versions`]);
  if (row.tags_dirty) badges.push(["warn", "Unsaved tags"]);
  if (lowBitrate && !row.lossless && row.bitrate && row.bitrate < lowBitrate) badges.push(["quiet", "Low bitrate"]);
  return badges.map(([tone, text]) => (
    <span key={text} className={`lib-badge is-${tone}`}>
      {text}
    </span>
  ));
}

/**
 * Virtualized, paged track list. Only visible rows are rendered and only the
 * pages around them are fetched.
 */
export function TrackTable({
  query,
  revision = 0,
  selection,
  onSelectionChange,
  activeId,
  onActivate,
  onTotalChange,
  playing,
  onPlay,
  lowBitrate = 160,
  emptyText = "No songs match.",
  hideColumns = [],
  onSort,
}) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [total, setTotal] = useState(null);
  const [pages, setPages] = useState(() => new Map());
  const [error, setError] = useState("");
  const inFlight = useRef(new Set());
  const generation = useRef(0);
  const lastClicked = useRef(null);
  const activateTimer = useRef(null);

  // Opening the details panel narrows the table. Delaying it slightly lets
  // both clicks of a double-click land on the same row first.
  const activateSoon = (row) => {
    clearTimeout(activateTimer.current);
    activateTimer.current = setTimeout(() => onActivate?.(row), 220);
  };

  useEffect(() => () => clearTimeout(activateTimer.current), []);
  const queryKey = JSON.stringify(query);

  const columns = useMemo(() => TRACK_COLUMNS.filter((column) => !hideColumns.includes(column.key)), [hideColumns]);

  const loadPage = useCallback(
    async (pageIndex, gen) => {
      const key = `${gen}:${pageIndex}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const result = await libraryApi.listTracks({ ...query, offset: pageIndex * PAGE_SIZE, limit: PAGE_SIZE });
        if (gen !== generation.current) return;
        setTotal(result.total);
        setPages((current) => new Map(current).set(pageIndex, result.rows));
        setError("");
      } catch (err) {
        if (gen === generation.current) setError(errorMessage(err, "The songs couldn't be loaded"));
      } finally {
        inFlight.current.delete(key);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey],
  );

  // New query or data revision: start over from the top of the cache.
  useEffect(() => {
    generation.current += 1;
    setPages(new Map());
    setTotal(null);
    loadPage(0, generation.current);
  }, [loadPage, revision]);

  useEffect(() => {
    if (total !== null) onTotalChange?.(total);
  }, [total, onTotalChange]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = total ?? 0;
  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);

  // Fetch any page the visible window touches.
  useEffect(() => {
    if (total === null) return;
    for (let page = Math.floor(first / PAGE_SIZE); page <= Math.floor(Math.max(first, last - 1) / PAGE_SIZE); page += 1) {
      if (!pages.has(page)) loadPage(page, generation.current);
    }
  }, [first, last, pages, total, loadPage]);

  const rowAt = (index) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE] || null;

  const handleRowClick = (event, row, index) => {
    if (!row) return;
    const next = new Set(event.ctrlKey || event.metaKey ? selection : []);

    if (event.shiftKey && lastClicked.current !== null) {
      const [from, to] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)];
      for (let i = from; i <= to; i += 1) {
        const item = rowAt(i);
        if (item) next.add(item.id);
      }
    } else if ((event.ctrlKey || event.metaKey) && selection.has(row.id)) {
      next.delete(row.id);
    } else {
      next.add(row.id);
      lastClicked.current = index;
    }

    onSelectionChange?.(next);
    activateSoon(row);
  };

  const handleKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !count) return;
    event.preventDefault();
    const current = lastClicked.current ?? -1;
    const index = Math.max(0, Math.min(count - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    const row = rowAt(index);
    if (!row) return;
    lastClicked.current = index;
    onSelectionChange?.(new Set([row.id]));
    onActivate?.(row);
    const element = containerRef.current;
    if (index * ROW_HEIGHT < element.scrollTop) element.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = (index + 1) * ROW_HEIGHT - element.clientHeight;
    }
  };

  const sortBy = (column) => {
    if (column.sort && onSort) onSort(column.sort);
  };

  const rows = [];
  for (let index = first; index < last; index += 1) {
    const row = rowAt(index);
    const isPlaying = row && playing?.trackId === row.id && playing.isPlaying;
    rows.push(
      <div
        key={row ? `t${row.id}` : `p${index}`}
        role="row"
        aria-selected={row ? selection.has(row.id) : false}
        className={`lib-row ${row && selection.has(row.id) ? "is-selected" : ""} ${row && activeId === row.id ? "is-active" : ""} ${row ? "" : "is-placeholder"}`}
        style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
        onClick={(event) => handleRowClick(event, row, index)}
        onDoubleClick={() => {
          if (!row) return;
          clearTimeout(activateTimer.current);
          onActivate?.(row);
          onPlay?.(row);
        }}
      >
        <span className="lib-cell lib-cell--play" role="cell">
          {row && row.file_id && row.file_status !== "missing" && (
            <button
              type="button"
              className="lib-play"
              aria-label={isPlaying ? `Pause ${row.title}` : `Play ${row.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onPlay?.(row);
              }}
            >
              {isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
            </button>
          )}
        </span>
        <span className="lib-cell lib-cell--art" role="cell">
          {row?.artwork_hash ? (
            <img src={artworkUrl(row.artwork_hash, 64)} alt="" loading="lazy" draggable={false} />
          ) : (
            <span className="lib-art-placeholder" />
          )}
        </span>
        {row ? (
          columns.map((column) => (
            <span key={column.key} role="cell" className={`lib-cell lib-cell--${column.key} ${column.align === "end" ? "is-end" : ""}`}>
              {column.key === "title" && (
                <>
                  <span className="lib-cell__primary">{row.title || "Untitled"}</span>
                  <span className="lib-badges">
                    <StatusBadges row={row} lowBitrate={lowBitrate} />
                  </span>
                </>
              )}
              {column.key === "artist" && (row.artist || <em className="lib-empty">Unknown</em>)}
              {column.key === "album" && (row.album || <em className="lib-empty">No album</em>)}
              {column.key === "genre" && (row.genre || <em className="lib-empty">—</em>)}
              {column.key === "year" && (row.year || "")}
              {column.key === "duration" && formatDuration(row.duration_ms)}
              {column.key === "format" && qualityText(row)}
              {column.key === "source" && row.source_name}
            </span>
          ))
        ) : (
          <span className="lib-cell lib-cell--loading" />
        )}
      </div>,
    );
  }

  return (
    <div
      className="lib-table"
      role="table"
      aria-rowcount={count}
      style={{ "--lib-cols": `34px 40px ${columns.map((column) => column.width).join(" ")}` }}
    >
      <div className="lib-row lib-row--head" role="row">
        <span className="lib-cell lib-cell--play" />
        <span className="lib-cell lib-cell--art" />
        {columns.map((column) => (
          <button
            key={column.key}
            type="button"
            role="columnheader"
            className={`lib-cell lib-head lib-cell--${column.key} ${column.align === "end" ? "is-end" : ""} ${
              query.sort === column.sort ? "is-sorted" : ""
            }`}
            onClick={() => sortBy(column)}
            disabled={!onSort || !column.sort}
          >
            {column.label}
            {query.sort === column.sort && <span aria-hidden="true">{query.direction === "desc" ? " ↓" : " ↑"}</span>}
          </button>
        ))}
      </div>

      <div
        className="lib-table__body"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        <div className="lib-table__spacer" style={{ height: count * ROW_HEIGHT }}>
          {rows}
        </div>
        {total === 0 && !error && <div className="lib-table__empty">{emptyText}</div>}
        {error && (
          <div className="lib-table__empty is-error">
            <WarningIcon size={16} /> {error}
          </div>
        )}
      </div>
    </div>
  );
}
