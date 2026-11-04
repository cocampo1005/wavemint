// The app's destinations (the sidebar) and the views inside them. A route is
// { view, scope }; views keep their own ids so links from anywhere in the app
// ("open this album", "show this song") keep working, and each view belongs to
// one section, whose tabs it shows.

export const SECTIONS = {
  music: {
    label: "Music",
    tabs: [
      ["overview", "Overview"],
      ["songs", "Songs"],
      ["albums", "Albums"],
      ["artists", "Artists"],
      ["genres", "Genres"],
      ["favorites", "Favorites"],
    ],
  },
  playlists: { label: "Playlists" },
  review: { label: "Review" },
  iphone: { label: "Apple Library Sync" },
  tools: {
    label: "Library Tools",
    tabs: [
      ["sources", "Sources"],
      ["managed", "Library Organization"],
      ["storage", "Storage"],
      ["history", "History"],
      ["merge", "Import & Merge"],
      ["identify", "Identify Songs"],
    ],
  },
};

const VIEW_SECTION = Object.fromEntries(
  Object.entries(SECTIONS).flatMap(([id, section]) => (section.tabs ? section.tabs.map(([view]) => [view, id]) : [[id, id]])),
);

export const DEFAULT_VIEW = { music: "overview", tools: "sources" };

/** The section (sidebar destination) a view belongs to. */
export function sectionOf(view) {
  return VIEW_SECTION[view] || "music";
}

/**
 * Routes from earlier versions of the app (and the sidebar's section ids)
 * resolved to a current view. `last` remembers the last view of each section.
 */
export function resolveRoute(view, scope = {}, last = {}) {
  if (view === "music" || view === "tools") return { view: last[view] || DEFAULT_VIEW[view], scope: {} };
  if (view === "health") return { view: "review", scope: { tab: "diagnostics" } };
  if (view === "duplicates") return { view: "review", scope: { tab: "duplicates" } };
  if (view === "quality") return { view: "songs", scope: {} };
  if (!VIEW_SECTION[view]) return { view: "overview", scope: {} };
  return { view, scope };
}
