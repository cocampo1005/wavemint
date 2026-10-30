import { usePlayer } from "../player/usePlayer";
import { TrackDetail } from "./TrackDetail";

/**
 * A maintenance list (Review, Quality & Upgrades, File Health) with the song
 * panel beside it, so a song can be fixed where its issue is listed instead
 * of in Songs. `browserProps` are LibraryView's shared song actions.
 */
export function WithSongPanel({ trackId, onClose, browserProps, children }) {
  const player = usePlayer();
  return (
    <div className={`lib-browser lib-with-panel ${trackId ? "has-detail" : ""}`}>
      <div className="lib-browser__main lib-with-panel__main">{children}</div>
      {trackId && (
        <TrackDetail
          key={trackId}
          trackId={trackId}
          revision={browserProps.revision}
          playing={player.playing}
          onClose={onClose}
          onPlayFile={browserProps.onPlayFile}
          onOpenAlbum={browserProps.onOpenAlbum}
          onOpenArtist={browserProps.onOpenArtist}
          onError={browserProps.onError}
          onChanged={browserProps.onChanged}
          onUpgrade={browserProps.onUpgrade}
          onIdentify={browserProps.onIdentify}
          onEditAudio={browserProps.onEditAudio}
          onToggleFavorite={browserProps.onToggleFavorite}
        />
      )}
    </div>
  );
}
