import { useState } from "react";
import { CloseIcon, GripIcon } from "../library/icons";
import { usePlayer } from "./usePlayer";
import { Artwork } from "../library/Artwork";

function QueueRow({ row, active = false, children, onPlay, draggable = false, dragProps = {} }) {
  return (
    <li className={`wm-queue__row ${active ? "is-active" : ""}`} draggable={draggable} {...dragProps}>
      {draggable && (
        <span className="wm-queue__grip" aria-hidden="true">
          <GripIcon size={14} />
        </span>
      )}
      <button type="button" className="wm-queue__item" onClick={onPlay} disabled={!onPlay} title={onPlay ? "Play now" : undefined}>
        <Artwork hash={row?.artwork_hash} size={64} loading="lazy" />
        <span className="wm-queue__text">
          <strong>{row?.title || "…"}</strong>
          <span>{row ? row.artist || "Unknown artist" : ""}</span>
        </span>
      </button>
      {children}
    </li>
  );
}

/**
 * The playback queue: what's playing, songs queued by hand (reorder by
 * dragging), then the rest of the list being played. Changes here affect
 * this listening session only, never a playlist.
 */
export function QueuePanel({ className = "", onClose }) {
  const player = usePlayer();
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const queued = player.upcoming.filter((item) => item.kind === "queue");
  const fromList = player.upcoming.filter((item) => item.kind === "context").slice(0, 100);
  const row = (id) => player.details.get(id);

  return (
    <aside className={`wm-queue ${className}`.trim()} aria-label="Queue">
      <div className="wm-queue__head">
        <h2 className="heading-md">Queue</h2>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close queue">
          <CloseIcon size={16} />
        </button>
      </div>

      <div className="wm-queue__body">
        <span className="section-label">Now playing</span>
        {player.currentTrack ? <ul className="wm-queue__list"><QueueRow row={player.currentTrack} active /></ul> : <p className="wm-queue__empty">Nothing is playing.</p>}

        <div className="wm-queue__section">
          <span className="section-label">Next in queue</span>
          {queued.length > 0 && (
            <button type="button" className="btn btn--link" onClick={player.clearQueue}>
              Clear
            </button>
          )}
        </div>
        {queued.length ? (
          <ul className="wm-queue__list">
            {queued.map((item, index) => (
              <QueueRow
                key={item.key}
                row={row(item.id)}
                onPlay={() => player.jumpTo(item)}
                draggable
                dragProps={{
                  className: `wm-queue__row ${dragOver === index && dragFrom !== null && dragFrom !== index ? "is-drop-target" : ""}`,
                  onDragStart: (event) => {
                    setDragFrom(index);
                    event.dataTransfer.effectAllowed = "move";
                  },
                  onDragOver: (event) => {
                    event.preventDefault();
                    setDragOver(index);
                  },
                  onDragEnd: () => {
                    setDragFrom(null);
                    setDragOver(null);
                  },
                  onDrop: (event) => {
                    event.preventDefault();
                    if (dragFrom !== null) player.moveQueued(dragFrom, index);
                    setDragFrom(null);
                    setDragOver(null);
                  },
                }}
              >
                <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => player.removeQueued(item.key)} aria-label={`Remove ${row(item.id)?.title || "song"} from the queue`}>
                  <CloseIcon size={12} />
                </button>
              </QueueRow>
            ))}
          </ul>
        ) : (
          <p className="wm-queue__empty">Use Play Next or Add to Queue on any song. Queued songs play before the rest of the list.</p>
        )}

        {fromList.length > 0 && (
          <>
            <div className="wm-queue__section">
              <span className="section-label">
                Next from {player.contextLabel || "the list"}
                {player.shuffle ? " · shuffled" : ""}
              </span>
            </div>
            <ul className="wm-queue__list">
              {fromList.map((item) => (
                <QueueRow key={item.key} row={row(item.id)} onPlay={() => player.jumpTo(item)}>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => player.skipUpcoming(item.orderIndex)} aria-label={`Skip ${row(item.id)?.title || "song"} this time`} title="Skip this time">
                    <CloseIcon size={12} />
                  </button>
                </QueueRow>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
