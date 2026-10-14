import { formatTime } from "../editor/editMath";
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon, RepeatIcon, ShuffleIcon, VolumeIcon } from "../library/icons";
import { usePlayer, usePlayerTime } from "./usePlayer";

const REPEAT_LABELS = { off: "Repeat is off", all: "Repeat all", one: "Repeat one" };

/** Shuffle · Previous · Play/Pause · Next · Repeat */
export function Transport({ size = "md" }) {
  const player = usePlayer();
  const icon = size === "lg" ? 22 : 16;
  const disabled = !player.current && !player.contextLabel;
  return (
    <div className={`wm-transport wm-transport--${size}`}>
      <button
        type="button"
        className={`wm-transport__toggle ${player.shuffle ? "is-on" : ""}`}
        onClick={player.toggleShuffle}
        aria-pressed={player.shuffle}
        aria-label={player.shuffle ? "Shuffle is on" : "Shuffle is off"}
        title={player.shuffle ? "Shuffle is on" : "Shuffle"}
      >
        <ShuffleIcon size={icon} />
      </button>
      <button type="button" className="wm-transport__button" onClick={player.previous} disabled={!player.current} aria-label="Previous" title="Previous">
        <PreviousIcon size={icon} />
      </button>
      <button
        type="button"
        className="wm-transport__play"
        onClick={player.togglePlay}
        disabled={disabled}
        aria-label={player.isPlaying ? "Pause" : "Play"}
        title={player.isPlaying ? "Pause (Space)" : "Play (Space)"}
      >
        {player.isPlaying ? <PauseIcon size={icon + 2} /> : <PlayIcon size={icon + 2} />}
      </button>
      <button type="button" className="wm-transport__button" onClick={player.next} disabled={!player.current} aria-label="Next" title="Next">
        <NextIcon size={icon} />
      </button>
      <button
        type="button"
        className={`wm-transport__toggle ${player.repeat !== "off" ? "is-on" : ""}`}
        onClick={player.cycleRepeat}
        aria-label={REPEAT_LABELS[player.repeat]}
        title={`${REPEAT_LABELS[player.repeat]} (click to change)`}
      >
        <RepeatIcon size={icon} one={player.repeat === "one"} />
      </button>
    </div>
  );
}

export function Seekbar({ className = "" }) {
  const player = usePlayer();
  const time = usePlayerTime();
  const duration = time.duration || 0;
  return (
    <div className={`wm-seek ${className}`.trim()}>
      <span className="wm-seek__time">{formatTime(time.current * 1000, { tenths: false })}</span>
      <input
        type="range"
        className="wm-range wm-seek__input"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(time.current, duration || 0)}
        disabled={!player.current || !duration}
        onChange={(event) => player.seek(Number(event.target.value))}
        aria-label="Seek"
        style={{ "--wm-fill": `${duration ? (Math.min(time.current, duration) / duration) * 100 : 0}%` }}
      />
      <span className="wm-seek__time">{formatTime(duration * 1000, { tenths: false })}</span>
    </div>
  );
}

export function VolumeControl({ className = "" }) {
  const player = usePlayer();
  return (
    <div className={`wm-volume ${className}`.trim()}>
      <button
        type="button"
        className="wm-transport__button"
        onClick={() => player.setVolume(player.volume > 0 ? 0 : 0.8)}
        aria-label={player.volume > 0 ? "Mute" : "Unmute"}
        title={player.volume > 0 ? "Mute" : "Unmute"}
      >
        <VolumeIcon size={16} level={player.volume === 0 ? 0 : player.volume} />
      </button>
      <input
        type="range"
        className="wm-range wm-volume__input"
        min={0}
        max={1}
        step={0.02}
        value={player.volume}
        onChange={(event) => player.setVolume(Number(event.target.value))}
        aria-label="Volume"
        style={{ "--wm-fill": `${player.volume * 100}%` }}
      />
    </div>
  );
}
