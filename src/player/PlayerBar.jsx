import { ListenIcon, QueueIcon } from "../library/icons";
import { Seekbar, Transport, VolumeControl } from "./controls";
import { usePlayer } from "./usePlayer";
import { Artwork } from "../library/Artwork";

/** The player at the bottom of the window (both workspaces). */
export function PlayerBar({ onOpenTrack }) {
  const player = usePlayer();
  const track = player.currentTrack;

  return (
    <footer className="wm-player" aria-label="Player">
      <div className="wm-player__now">
        {track ? (
          <>
            <button type="button" className="wm-player__art" onClick={() => player.setListenMode(true)} title="Open Listen Mode">
              <Artwork hash={track.artwork_hash} size={160} />
            </button>
            <div className="wm-player__text">
              <button type="button" className="wm-player__title" onClick={() => onOpenTrack?.(track.id)} title="Show in library">
                {track.title || "Untitled"}
              </button>
              <span className="wm-player__artist">
                {player.notice || [track.artist || "Unknown artist", track.album].filter(Boolean).join(" · ")}
              </span>
            </div>
          </>
        ) : (
          <span className="wm-player__idle">{player.notice || "Nothing playing"}</span>
        )}
      </div>

      <div className="wm-player__center">
        <Transport />
        <Seekbar />
      </div>

      <div className="wm-player__side">
        <VolumeControl />
        <button
          type="button"
          className={`wm-transport__toggle ${player.queueOpen ? "is-on" : ""}`}
          onClick={() => player.setQueueOpen(!player.queueOpen)}
          aria-pressed={player.queueOpen}
          aria-label="Queue"
          title="Queue"
        >
          <QueueIcon size={18} />
          {player.upNext.length > 0 && <span className="wm-player__badge">{player.upNext.length}</span>}
        </button>
        <button type="button" className="btn btn--secondary btn--sm wm-player__listen" onClick={() => player.setListenMode(true)} disabled={!track} title="Listen Mode: large artwork, for big screens">
          <ListenIcon size={16} /> Listen Mode
        </button>
      </div>
    </footer>
  );
}
