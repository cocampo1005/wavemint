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

export const PlusIcon = (props) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

// Add Music: a download arrow into a note.
export const AddMusicIcon = (props) => (
  <Icon {...props}>
    <path d="M9 18V6l10-2v11" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="15" r="2.5" />
  </Icon>
);

// Edit Audio: a waveform between trim brackets.
export const WaveformIcon = (props) => (
  <Icon {...props}>
    <path d="M4 5v14M20 5v14" />
    <path d="M8 10v4M11 7v10M14 9v6M17 11v2" />
  </Icon>
);

export const HeartIcon = ({ filled = false, ...props }) => (
  <Icon {...props}>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill={filled ? "currentColor" : "none"} />
  </Icon>
);

export const MoreIcon = (props) => (
  <Icon {...props}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
  </Icon>
);

export const ShuffleIcon = (props) => (
  <Icon {...props}>
    <path d="M4 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8C15.3 16 16.5 17 18.5 17H20" />
    <path d="M4 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.2 8.4c.8-.9 1.8-1.4 3.3-1.4H20" />
    <path d="M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5" />
  </Icon>
);

export const RepeatIcon = ({ one = false, ...props }) => (
  <Icon {...props}>
    <path d="M17 3.5L19.5 6 17 8.5" />
    <path d="M4.5 11.5V10a4 4 0 0 1 4-4h11" />
    <path d="M7 20.5L4.5 18 7 15.5" />
    <path d="M19.5 12.5V14a4 4 0 0 1-4 4h-11" />
    {one && <path d="M11.3 10.5l1.2-.8v4.6" strokeWidth="1.6" />}
  </Icon>
);

export const PreviousIcon = (props) => (
  <Icon {...props}>
    <path d="M6 5v14" />
    <path d="M18 5.5v13L9 12z" fill="currentColor" />
  </Icon>
);

export const NextIcon = (props) => (
  <Icon {...props}>
    <path d="M18 5v14" />
    <path d="M6 5.5v13l9-6.5z" fill="currentColor" />
  </Icon>
);

export const QueueIcon = (props) => (
  <Icon {...props}>
    <path d="M4 6h12M4 11h12M4 16h7" />
    <path d="M15 14.5v5l4.5-2.5z" fill="currentColor" />
  </Icon>
);

export const VolumeIcon = ({ level = 1, ...props }) => (
  <Icon {...props}>
    <path d="M4 9.5h3l4.5-4v13L7 14.5H4z" />
    {level > 0 && <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />}
    {level > 0.5 && <path d="M17.5 7a7 7 0 0 1 0 10" />}
    {level === 0 && <path d="M16 10l4 4M20 10l-4 4" />}
  </Icon>
);

// Listen Mode: a "now playing" frame.
export const ListenIcon = (props) => (
  <Icon {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <rect x="7.5" y="8" width="5.5" height="5.5" rx="1" />
    <path d="M15.5 9h2M15.5 12h2M7.5 16.5h10" />
  </Icon>
);

export const FullscreenIcon = ({ exit = false, ...props }) => (
  <Icon {...props}>
    {exit ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
  </Icon>
);

export const TrashIcon = (props) => (
  <Icon {...props}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
  </Icon>
);

export const GripIcon = (props) => (
  <Icon {...props}>
    <path d="M9 6v.1M15 6v.1M9 12v.1M15 12v.1M9 18v.1M15 18v.1" strokeWidth="2.6" />
  </Icon>
);

// Storage: a disk.
export const StorageIcon = (props) => (
  <Icon {...props}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M3.5 13.5h17" />
    <path d="M7 16.3h.1M10 16.3h.1" strokeWidth="2.4" />
  </Icon>
);
