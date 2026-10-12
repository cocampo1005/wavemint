// Inline icons for the Library (24px grid, stroke = currentColor).

function Icon({ children, size = 18, className = "" }) {
  return (
    <svg
      className={`wm-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const OverviewIcon = (props) => (
  <Icon {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Icon>
);

export const SongsIcon = (props) => (
  <Icon {...props}>
    <path d="M9 18V6l11-2v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="16" r="2.5" />
  </Icon>
);

export const AlbumIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.5" />
  </Icon>
);

export const ArtistIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5" />
  </Icon>
);

export const GenreIcon = (props) => (
  <Icon {...props}>
    <path d="M4 7h10M4 12h16M4 17h7" />
    <circle cx="18" cy="7" r="2" />
    <circle cx="15" cy="17" r="2" />
  </Icon>
);

export const PlaylistIcon = (props) => (
  <Icon {...props}>
    <path d="M4 6h12M4 11h12M4 16h7" />
    <path d="M17 13v6l4-3z" />
  </Icon>
);

export const ReviewIcon = (props) => (
  <Icon {...props}>
    <path d="M9 11l2 2 4-4" />
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </Icon>
);

export const MergeIcon = (props) => (
  <Icon {...props}>
    <path d="M6 4v5a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6" />
    <path d="M18 4v5a6 6 0 0 1-3 5.2" />
    <circle cx="6" cy="4" r="1.5" />
    <circle cx="18" cy="4" r="1.5" />
  </Icon>
);

export const QualityIcon = (props) => (
  <Icon {...props}>
    <path d="M4 14v-4M8 17V7M12 20V4M16 16V8M20 13v-2" />
  </Icon>
);

export const SourceIcon = (props) => (
  <Icon {...props}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
);

export const PhoneIcon = (props) => (
  <Icon {...props}>
    <rect x="7" y="3" width="10" height="18" rx="2.5" />
    <path d="M11 18h2" />
  </Icon>
);

export const HistoryIcon = (props) => (
  <Icon {...props}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M12 8v4l3 2" />
  </Icon>
);

export const SettingsIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
  </Icon>
);

export const SearchIcon = (props) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </Icon>
);

export const PlayIcon = (props) => (
  <Icon {...props}>
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />
  </Icon>
);

export const PauseIcon = (props) => (
  <Icon {...props}>
    <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const CloseIcon = (props) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const FolderOpenIcon = (props) => (
  <Icon {...props}>
    <path d="M3.5 18V7.5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2V11" />
    <path d="M3.5 18l2.6-6.2a1.5 1.5 0 0 1 1.4-.8H21l-2.8 7z" />
  </Icon>
);

export const RefreshIcon = (props) => (
  <Icon {...props}>
    <path d="M20 12a8 8 0 0 1-14.3 4.9" />
    <path d="M4 12a8 8 0 0 1 14.3-4.9" />
    <path d="M18.5 3v4.5H14M5.5 21v-4.5H10" />
  </Icon>
);

export const WarningIcon = (props) => (
  <Icon {...props}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17.2v.1" />
  </Icon>
);

export const CheckIcon = (props) => (
  <Icon {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const ChevronIcon = ({ direction = "right", ...props }) => (
  <Icon {...props}>
    <path
      d={
        { right: "M9 6l6 6-6 6", left: "M15 6l-6 6 6 6", down: "M6 9l6 6 6-6", up: "M6 15l6-6 6 6" }[direction]
      }
    />
  </Icon>
);

export const EditIcon = (props) => (
  <Icon {...props}>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
  </Icon>
);

export const UpgradeIcon = (props) => (
  <Icon {...props}>
    <path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" />
    <path d="M5 21h14" />
  </Icon>
);
