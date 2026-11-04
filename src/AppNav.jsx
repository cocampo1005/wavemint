import horizontalLogo from "./assets/Horizontal Logo.png";
import { AddMusicIcon, PhoneIcon, PlaylistIcon, ReviewIcon, SettingsIcon, SongsIcon, ToolsIcon } from "./library/icons";

// Everyday destinations only. Music holds the browsing tabs (Overview, Songs,
// Albums, Artists, Genres, Favorites); Review holds metadata issues,
// duplicates and file diagnostics; Library Tools (bottom) holds setup and
// maintenance utilities (sources, organization, storage, history, library
// merges, batch identification). `section` is the destination of a view.
const NAV_GROUPS = [
  {
    label: "Library",
    items: [
      { id: "music", label: "Music", Icon: SongsIcon },
      { id: "playlists", label: "Playlists", Icon: PlaylistIcon },
      { id: "review", label: "Review", Icon: ReviewIcon, badge: "reviewOpen", badgeTitle: "Open issues: missing details, likely duplicates, file problems" },
    ],
  },
  {
    label: "Sync",
    items: [{ id: "iphone", label: "Apple Library Sync", Icon: PhoneIcon }],
  },
];

function NavItem({ item, active, count, onClick }) {
  const NavIcon = item.Icon;
  return (
    <button type="button" className={`app-nav__item ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
      <NavIcon size={18} />
      {item.label}
      {count > 0 && (
        <span className="app-nav__count" title={item.badgeTitle}>
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * App navigation: Add Music, the everyday destinations, and (at the bottom)
 * Library Tools and Settings. `activeId` is "add" for Add Music or a section id.
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
            {group.items.map((item) => (
              <NavItem key={item.id} item={item} active={activeId === item.id} count={item.badge ? status?.[item.badge] : 0} onClick={() => onNavigate(item.id)} />
            ))}
          </div>
        ))}
      </div>

      <div className="app-nav__footer">
        <NavItem item={{ id: "tools", label: "Library Tools", Icon: ToolsIcon }} active={activeId === "tools"} onClick={() => onNavigate("tools")} />
        <button type="button" className="app-nav__item app-nav__settings" onClick={onOpenSettings} title={settingsTitle}>
          <SettingsIcon size={18} />
          Settings
          {settingsIndicator && <span className={`header-settings__dot is-${settingsIndicator}`} aria-hidden="true" />}
        </button>
      </div>
    </nav>
  );
}
