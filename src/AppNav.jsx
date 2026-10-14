import horizontalLogo from "./assets/Horizontal Logo.png";
import {
  AddMusicIcon,
  AlbumIcon,
  ArtistIcon,
  FolderOpenIcon,
  GenreIcon,
  HeartIcon,
  HistoryIcon,
  MergeIcon,
  OverviewIcon,
  PhoneIcon,
  PlaylistIcon,
  QualityIcon,
  ReviewIcon,
  SearchIcon,
  SettingsIcon,
  SongsIcon,
  SourceIcon,
  StorageIcon,
} from "./library/icons";

// The library is the main workspace; maintenance and management tools sit
// below it. Add Music (YouTube extraction) has its own entry at the top.
const NAV_GROUPS = [
  {
    label: "Library",
    items: [
      { id: "overview", label: "Overview", Icon: OverviewIcon },
      { id: "songs", label: "Songs", Icon: SongsIcon },
      { id: "favorites", label: "Favorites", Icon: HeartIcon },
      { id: "albums", label: "Albums", Icon: AlbumIcon },
      { id: "artists", label: "Artists", Icon: ArtistIcon },
      { id: "genres", label: "Genres", Icon: GenreIcon },
      { id: "playlists", label: "Playlists", Icon: PlaylistIcon },
    ],
  },
  {
    label: "Maintain",
    items: [
      { id: "review", label: "Review", Icon: ReviewIcon, badge: "reviewOpen" },
      { id: "merge", label: "Merge & Duplicates", Icon: MergeIcon },
      { id: "quality", label: "Quality & Upgrades", Icon: QualityIcon, badge: "qualityAttention" },
      { id: "identify", label: "Identify", Icon: SearchIcon },
    ],
  },
  {
    label: "Manage",
    items: [
      { id: "sources", label: "Sources", Icon: SourceIcon },
      { id: "managed", label: "WaveMint Library", Icon: FolderOpenIcon },
      { id: "iphone", label: "Prepare for iPhone", Icon: PhoneIcon },
      { id: "history", label: "History", Icon: HistoryIcon },
      { id: "storage", label: "Storage", Icon: StorageIcon },
    ],
  },
];

/**
 * App navigation: Add Music, the library sections, and Settings. `activeId`
 * is "add" for Add Music or a library section id.
 */
export function AppNav({ activeId, status, addActivity, onAddMusic, onNavigate, onOpenSettings, settingsIndicator, settingsTitle }) {
  return (
    <nav className="app-nav" aria-label="WaveMint">
      <img className="app-nav__logo" src={horizontalLogo} alt="WaveMint" draggable={false} />

      <button
        type="button"
        className={`app-nav__item app-nav__add ${activeId === "add" ? "is-active" : ""}`}
        aria-current={activeId === "add" ? "page" : undefined}
        onClick={onAddMusic}
      >
        <AddMusicIcon size={18} />
        Add Music
        {addActivity?.waiting > 0 ? (
          <span className="app-nav__count is-accent" title="Songs extracted and waiting for your edits">
            {addActivity.waiting}
          </span>
        ) : (
          addActivity?.busy && <span className="app-nav__busy" title="Working…" aria-label="Working" />
        )}
      </button>

      <div className="app-nav__groups">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="app-nav__group">
            <span className="app-nav__label">{group.label}</span>
            {group.items.map((item) => {
              const NavIcon = item.Icon;
              const count = item.badge ? status?.[item.badge] : 0;
              const isActive = activeId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`app-nav__item ${isActive ? "is-active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <NavIcon size={18} />
                  {item.label}
                  {count > 0 && <span className="app-nav__count">{count}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <button type="button" className="app-nav__item app-nav__settings" onClick={onOpenSettings} title={settingsTitle}>
        <SettingsIcon size={18} />
        Settings
        {settingsIndicator && <span className={`header-settings__dot is-${settingsIndicator}`} aria-hidden="true" />}
      </button>
    </nav>
  );
}
