import { useCallback, useEffect, useRef, useState } from "react";
import { artworkUrl, formatDuration, mediaUrl } from "./format";
import { CloseIcon, PauseIcon, PlayIcon } from "./icons";

/**
 * Preview playback for library management (not a full music player).
 * Returns [playing, play, playerElement].
 */
export function usePreviewPlayer() {
  const audioRef = useRef(null);
  const [now, setNow] = useState(null); // { trackId, fileId, title, artist, artworkHash }
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [error, setError] = useState("");

  const play = useCallback(
    (track, file = null) => {
      const fileId = file?.id || track.file_id || track.active_file_id;
      if (!fileId) return;
      const audio = audioRef.current;

      if (now?.fileId === fileId && audio) {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
        return;
      }

      setError("");
      setNow({
        trackId: track.id,
        fileId,
        title: track.title,
        artist: track.artist,
        artworkHash: file?.artwork_hash || track.artwork_hash || null,
        label: file ? `${file.source_name}` : "",
      });
    },
    [now],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !now) return;
    audio.src = mediaUrl(now.fileId);
    audio.play().catch(() => {});
  }, [now]);

  const stop = () => {
    audioRef.current?.pause();
    setNow(null);
    setIsPlaying(false);
  };

  const element = (
    <div className={`lib-player ${now ? "is-active" : ""}`} aria-label="Preview player">
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setTime({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration || 0 })}
        onLoadedMetadata={(event) => setTime({ current: 0, duration: event.currentTarget.duration || 0 })}
        onError={() => now && setError("This file can't be previewed.")}
      />
      {now ? (
        <>
          <button
            type="button"
            className="lib-player__toggle"
            onClick={() => (audioRef.current?.paused ? audioRef.current.play().catch(() => {}) : audioRef.current?.pause())}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
          </button>
          {now.artworkHash ? (
            <img className="lib-player__art" src={artworkUrl(now.artworkHash, 64)} alt="" />
          ) : (
            <span className="lib-player__art lib-art-placeholder" />
          )}
          <div className="lib-player__info">
            <span className="lib-player__title">{now.title || "Untitled"}</span>
            <span className="lib-player__artist">
              {error || [now.artist, now.label].filter(Boolean).join(" · ")}
            </span>
          </div>
          <span className="lib-player__time">{formatDuration(time.current * 1000)}</span>
          <input
            className="lib-player__seek"
            type="range"
            min={0}
            max={time.duration || 0}
            step={0.1}
            value={Math.min(time.current, time.duration || 0)}
            onChange={(event) => {
              if (audioRef.current) audioRef.current.currentTime = Number(event.target.value);
            }}
            aria-label="Seek"
          />
          <span className="lib-player__time">{formatDuration(time.duration * 1000)}</span>
          <input
            className="lib-player__volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={0.8}
            onChange={(event) => {
              if (audioRef.current) audioRef.current.volume = Number(event.target.value);
            }}
            aria-label="Volume"
          />
          <button type="button" className="btn btn--ghost btn--icon" onClick={stop} aria-label="Stop preview">
            <CloseIcon size={16} />
          </button>
        </>
      ) : (
        <span className="lib-player__idle">Select a song and press play to preview it.</span>
      )}
    </div>
  );

  return [{ ...now, isPlaying }, play, element];
}
