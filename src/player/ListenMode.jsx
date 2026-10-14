import { useEffect, useRef, useState } from "react";
import { Artwork } from "../library/Artwork";
import { artworkUrl } from "../library/format";
import { CloseIcon, FullscreenIcon, QueueIcon } from "../library/icons";
import { ArtworkVisualizer } from "./ArtworkVisualizer";
import { Seekbar, Transport, VolumeControl } from "./controls";
import { QueuePanel } from "./QueuePanel";
import { usePlayer } from "./usePlayer";

/**
 * Listen Mode: the playing song, large, for a big screen. A view of the one
 * player (nothing is played separately); entering or leaving it never
 * interrupts playback. Esc leaves fullscreen first, then Listen Mode.
 */
export function ListenMode() {
  const player = usePlayer();
  const rootRef = useRef(null);
  const artRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const leftFullscreenAt = useRef(0);
  const track = player.currentTrack;

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === rootRef.current;
      if (!active) leftFullscreenAt.current = Date.now();
      setFullscreen(active);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        // The same Esc press that left fullscreen doesn't also close Listen Mode.
        else if (Date.now() - leftFullscreenAt.current > 400) player.setListenMode(false);
        return;
      }
      if (event.code === "Space" && !/^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(event.target.tagName)) {
        event.preventDefault();
        player.togglePlay();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [player]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen().catch(() => {});
  };

  const art = track?.artwork_hash ? artworkUrl(track.artwork_hash, 600) : "";

  return (
    <div className={`wm-listen ${showQueue ? "has-queue" : ""}`} ref={rootRef} role="dialog" aria-modal="true" aria-label="Listen Mode">
      {/* A still, blurred copy of the artwork: cheap, and only behind the content. */}
      {art && <img className="wm-listen__backdrop" src={art} alt="" aria-hidden="true" />}
      <div className="wm-listen__shade" aria-hidden="true" />

      <div className="wm-listen__top">
        <span className="wm-listen__context">{player.contextLabel ? `Playing from ${player.contextLabel}` : ""}</span>
        <div className="wm-listen__top-actions">
          <button type="button" className={`wm-listen__icon ${showQueue ? "is-on" : ""}`} onClick={() => setShowQueue((value) => !value)} aria-pressed={showQueue} aria-label="Queue" title="Queue">
            <QueueIcon size={20} />
          </button>
          <button type="button" className="wm-listen__icon" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}>
            <FullscreenIcon size={20} exit={fullscreen} />
          </button>
          <button type="button" className="wm-listen__icon" onClick={() => player.setListenMode(false)} aria-label="Close Listen Mode" title="Close Listen Mode (Esc)">
            <CloseIcon size={20} />
          </button>
        </div>
      </div>

      <div className="wm-listen__stage">
        <div className="wm-listen__art-wrap">
          <div className="wm-listen__art" ref={artRef}>
            <Artwork src={art} alt={track ? `${track.album || track.title || "Song"} artwork` : ""} />
          </div>
          {/* After the artwork: the contours flow out of its border, over its shadow. */}
          <ArtworkVisualizer playing={player.isPlaying} trackKey={player.current?.token ?? null} artRef={artRef} />
        </div>
        <div className="wm-listen__info">
          {/* Fixed-height text: long titles stop at two lines, so the controls never move. */}
          <h1 className="wm-listen__title" title={track?.title || ""}>
            {track?.title || "Nothing playing"}
          </h1>
          <p className="wm-listen__artist" title={track ? [track.artist, track.album].filter(Boolean).join(" · ") : ""}>
            {track ? [track.artist || "Unknown artist", track.album].filter(Boolean).join(" · ") : "Start a song from your library."}
          </p>
          <Seekbar className="wm-listen__seek" />
          <div className="wm-listen__controls">
            <Transport size="lg" />
          </div>
          <VolumeControl className="wm-listen__volume" />
        </div>
      </div>

      {showQueue && <QueuePanel className="wm-listen__queue" onClose={() => setShowQueue(false)} />}
    </div>
  );
}
