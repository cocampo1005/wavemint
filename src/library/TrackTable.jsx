import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatDuration, formatShortDate } from "./format";
import { HeartIcon, MoreIcon, PauseIcon, PlayIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi } from "./useLibrary";
import { Artwork } from "./Artwork";

const ROW_HEIGHT = 46;
const PAGE_SIZE = 200;
const OVERSCAN = 12;
const WIDTHS_KEY = "wavemint.trackColumns.v1";
// Fixed columns: play, artwork (left); favorite, actions (right); row padding.
const LEAD = [34, 40];
const TRAIL = [34, 34];
const ROW_PADDING = 12;

// Resizable columns, each with its own fixed width: dragging a column's
// right edge changes only that column, and the ones after it move along.
// Spare room goes to an empty filler before the favorite and ⋯ buttons, so
// no column grows or shrinks on its own.
const TRACK_COLUMNS = [
  { key: "title", label: "Title", sort: "title", width: 200, min: 120 },
  { key: "artist", label: "Artist", sort: "artist", width: 124, min: 80 },
  { key: "album", label: "Album", sort: "album", width: 124, min: 80 },
  { key: "genre", label: "Genre", sort: "genre", width: 96, min: 64 },
  { key: "duration", label: "Time", sort: "duration", align: "end", width: 54, min: 50 },
  { key: "added", label: "Added", sort: "added", width: 96, min: 80 },
  { key: "size", label: "Size", sort: "size", align: "end", width: 66, min: 56 },
];

function loadWidths() {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveWidths(widths) {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Widths are a convenience.
  }
}

function StatusBadges({ row, lowBitrate }) {
  const badges = [];
  if (row.file_status === "missing") badges.push(["missing", "File missing"]);
  else if (row.file_status === "unreadable") badges.push(["error", "Unreadable"]);
  if (row.version_count > 1) badges.push(["info", `${row.version_count} versions`]);
  // Edits to read-only sources wait for consolidation: not a warning.
  if (row.tags_dirty) badges.push(row.source_read_only ? ["quiet", "Edited"] : ["warn", "Unsaved tags"]);
  if (lowBitrate && !row.lossless && row.bitrate && row.bitrate < lowBitrate) badges.push(["quiet", "Low bitrate"]);
  return badges.map(([tone, text]) => (
    <span key={text} className={`lib-badge is-${tone}`}>
      {text}
    </span>
  ));
}

/**
 * Virtualized, paged track list. Only visible rows are rendered and only the
 * pages around them are fetched. Columns can be resized (widths are kept
 * between sessions); a wide table scrolls sideways with its header.
 * Right-click or the ⋯ button opens the song's actions (`onRowMenu`).
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
  onToggleFavorite,
  onRowMenu,
  lowBitrate = 160,
  emptyText = "No songs match.",
  hideColumns = [],
  onSort,
}) {
  const containerRef = useRef(null);
  const headRef = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [gutter, setGutter] = useState(0);
  const [total, setTotal] = useState(null);
  const [pages, setPages] = useState(() => new Map());
  const [error, setError] = useState("");
  const [widths, setWidths] = useState(loadWidths);
  const inFlight = useRef(new Set());
  const generation = useRef(0);
  const lastClicked = useRef(null);
  const activateTimer = useRef(null);
  const resizing = useRef(null);

  // Opening the details panel narrows the table. Delaying it slightly lets
  // both clicks of a double-click land on the same row first.
  const activateSoon = (row) => {
    clearTimeout(activateTimer.current);
    activateTimer.current = setTimeout(() => onActivate?.(row), 220);
  };

  useEffect(() => () => clearTimeout(activateTimer.current), []);
  const queryKey = JSON.stringify(query);

  const columns = useMemo(() => TRACK_COLUMNS.filter((column) => !hideColumns.includes(column.key)), [hideColumns]);
  const widthOf = (column) => Math.max(column.min, widths[column.key] || column.width);
  const template = [
    ...LEAD.map((px) => `${px}px`),
    ...columns.map((column) => `${widthOf(column)}px`),
    "minmax(0, 1fr)",
    ...TRAIL.map((px) => `${px}px`),
  ].join(" ");
  const minWidth = [...LEAD, ...TRAIL].reduce((sum, px) => sum + px, ROW_PADDING) + columns.reduce((sum, column) => sum + widthOf(column), 0);

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

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const loadedQuery = useRef(null);

  // A new query starts over from the top. A data revision (an edit, a
  // finished job) reloads the loaded pages in place, so the list keeps its
  // rows, its height and therefore its scroll position.
  useEffect(() => {
    generation.current += 1;
    if (loadedQuery.current !== queryKey) {
      loadedQuery.current = queryKey;
      setPages(new Map());
      setTotal(null);
      if (containerRef.current) containerRef.current.scrollTop = 0;
      loadPage(0, generation.current);
      return;
    }
    const loaded = [...pagesRef.current.keys()];
    for (const pageIndex of loaded.length ? loaded : [0]) loadPage(pageIndex, generation.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPage, revision]);

  useEffect(() => {
    if (total !== null) onTotalChange?.(total);
  }, [total, onTotalChange]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => {
      setViewport({ top: element.scrollTop, height: element.clientHeight });
      // The header leaves room for the body's vertical scrollbar so the
      // filler, and with it the buttons at the end, line up in both.
      setGutter(element.offsetWidth - element.clientWidth);
    };
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

  // Actions apply to the whole selection when the song is part of it.
  const openMenu = (x, y, row, index) => {
    if (!row || !onRowMenu) return;
    let ids = [row.id];
    if (selection.has(row.id) && selection.size > 1) ids = [...selection];
    else if (!selection.has(row.id)) {
      onSelectionChange?.(new Set([row.id]));
      lastClicked.current = index;
    }
    const rows = ids.map((id) => (id === row.id ? row : null)).filter(Boolean);
    onRowMenu({ x, y, row, rows, ids });
  };

  const handleKeyDown = (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const index = lastClicked.current ?? 0;
      const element = containerRef.current;
      const rect = element.getBoundingClientRect();
      event.preventDefault();
      openMenu(rect.left + 120, rect.top + (index + 1) * ROW_HEIGHT - element.scrollTop, rowAt(index), index);
      return;
    }
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
    if (resizing.current) return;
    if (column.sort && onSort) onSort(column.sort);
  };

  // Column resizing: drag a header's right edge; double-click resets it.
  const startResize = (event, column) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = { key: column.key, startX: event.clientX, startWidth: widthOf(column), min: column.min };
  };
  const moveResize = (event) => {
    const drag = resizing.current;
    if (!drag) return;
    const width = Math.round(Math.min(800, Math.max(drag.min, drag.startWidth + event.clientX - drag.startX)));
    setWidths((current) => (current[drag.key] === width ? current : { ...current, [drag.key]: width }));
  };
  const endResize = () => {
    if (!resizing.current) return;
    setWidths((current) => {
      saveWidths(current);
      return current;
    });
    // Let the click that ends a drag pass without sorting.
    setTimeout(() => {
      resizing.current = null;
    }, 0);
  };
  const resetWidth = (column) =>
    setWidths((current) => {
      const next = { ...current };
      delete next[column.key];
      saveWidths(next);
      return next;
    });

  const rows = [];
  for (let index = first; index < last; index += 1) {
    const row = rowAt(index);
    const isPlaying = row && playing?.trackId === row.id && playing.isPlaying;
    const isCurrent = row && playing?.trackId === row.id;
    rows.push(
      <div
        key={row ? `t${row.id}` : `p${index}`}
        role="row"
        aria-selected={row ? selection.has(row.id) : false}
        className={`lib-row ${row && selection.has(row.id) ? "is-selected" : ""} ${row && activeId === row.id ? "is-active" : ""} ${isCurrent ? "is-playing" : ""} ${row ? "" : "is-placeholder"}`}
        style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
        onClick={(event) => handleRowClick(event, row, index)}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY, row, index);
        }}
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
          <Artwork hash={row?.artwork_hash} size={64} loading="lazy" draggable={false} />
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
              {column.key === "duration" && formatDuration(row.duration_ms)}
              {column.key === "added" && formatShortDate(row.created_at)}
              {column.key === "size" && (row.size ? formatBytes(row.size) : "")}
            </span>
          ))
        ) : (
          <span className="lib-cell lib-cell--loading" style={{ gridColumn: `3 / span ${columns.length}` }} />
        )}
        <span className="lib-cell lib-cell--filler" aria-hidden="true" />
        <span className="lib-cell lib-cell--icon" role="cell">
          {row && onToggleFavorite && (
            <button
              type="button"
              className={`lib-heart ${row.favorite ? "is-on" : ""}`}
              aria-pressed={!!row.favorite}
              aria-label={row.favorite ? `Remove ${row.title} from Favorites` : `Add ${row.title} to Favorites`}
              title={row.favorite ? "Favorite (click to remove)" : "Add to Favorites"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite(row);
              }}
            >
              <HeartIcon size={15} filled={!!row.favorite} />
            </button>
          )}
        </span>
        <span className="lib-cell lib-cell--icon" role="cell">
          {row && onRowMenu && (
            <button
              type="button"
              className="lib-actions-button"
              aria-label={`Actions for ${row.title}`}
              aria-haspopup="menu"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(rect.left - 180, rect.bottom + 4, row, index);
              }}
            >
              <MoreIcon size={16} />
            </button>
          )}
        </span>
      </div>,
    );
  }

  return (
    <div className="lib-table" role="table" aria-rowcount={count} style={{ "--lib-cols": template, "--lib-min-width": `${minWidth}px` }}>
      <div className="lib-table__head" ref={headRef} style={{ paddingRight: gutter }}>
        <div className="lib-row lib-row--head" role="row">
          <span className="lib-cell lib-cell--play" />
          <span className="lib-cell lib-cell--art" />
          {columns.map((column) => (
            <div key={column.key} role="columnheader" className="lib-head__cell">
              <button
                type="button"
                className={`lib-cell lib-head lib-cell--${column.key} ${column.align === "end" ? "is-end" : ""} ${query.sort === column.sort ? "is-sorted" : ""}`}
                onClick={() => sortBy(column)}
                disabled={!onSort || !column.sort}
              >
                {column.label}
                {query.sort === column.sort && <span aria-hidden="true">{query.direction === "desc" ? " ↓" : " ↑"}</span>}
              </button>
              <span
                className="lib-col-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${column.label} column`}
                title="Drag to resize · double-click to reset"
                onPointerDown={(event) => startResize(event, column)}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onDoubleClick={() => resetWidth(column)}
              />
            </div>
          ))}
          <span className="lib-cell lib-cell--filler" />
          <span className="lib-cell lib-cell--icon" />
          <span className="lib-cell lib-cell--icon" />
        </div>
      </div>

      <div
        className="lib-table__body"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (headRef.current) headRef.current.scrollLeft = element.scrollLeft;
          setViewport({ top: element.scrollTop, height: element.clientHeight });
        }}
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
