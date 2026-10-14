import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { AddMusicView } from "./addMusic/AddMusicView";
import { AppNav } from "./AppNav";
import { ListenMode } from "./player/ListenMode";
import { PlayerBar } from "./player/PlayerBar";
import { PlayerProvider } from "./player/PlayerProvider";
import { QueuePanel } from "./player/QueuePanel";
import { usePlayer } from "./player/usePlayer";
import "./player/player.css";
import { SettingsDialog } from "./SettingsDialog";
import { LibraryView } from "./library/LibraryView";
import { libraryApi, useLibraryJobs, useLoader } from "./library/useLibrary";

function describeAuthState(authState) {
  if (!authState || authState.mode === "none") {
    return "YouTube authentication: off";
  }

  const verified = authState.lastTest?.status === "authenticated";
  const method = authState.mode === "browser" ? "browser cookies" : "cookies file";

  return `YouTube authentication: ${method} (${verified ? "verified" : "not verified"})`;
}

/** The queue drawer and Listen Mode, both views of the one player. */
function PlayerOverlays() {
  const player = usePlayer();
  return (
    <>
      {player.queueOpen && !player.listenMode && <QueuePanel className="wm-queue--drawer" onClose={() => player.setQueueOpen(false)} />}
      {player.listenMode && <ListenMode />}
    </>
  );
}

/**
 * The app shell: navigation, the Library (the main workspace; it opens on
 * the Overview) and Add Music, with the player underneath both. Both
 * workspaces stay mounted, so switching between them keeps the library's
 * place and any extraction in progress.
 */
function App() {
  return (
    <PlayerProvider>
      <AppShell />
    </PlayerProvider>
  );
}

function AppShell() {
  const [workspace, setWorkspace] = useState("library"); // "library" | "add"
  const [route, setRoute] = useState({ view: "overview", scope: {} });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("");
  const [authState, setAuthState] = useState(null);
  const [appStatus, setAppStatus] = useState(null);
  const [engineStatus, setEngineStatus] = useState(null);
  const [checkingComponents, setCheckingComponents] = useState(false);
  const [addActivity, setAddActivity] = useState({ busy: false, waiting: 0 });
  const libraryJobs = useLibraryJobs();
  const { data: status } = useLoader(() => libraryApi.getStatus(), [libraryJobs.revision]);

  const openSettings = (section = "") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  useEffect(() => {
    let cancelled = false;

    window.waveMintAPI
      .getAuthState()
      .then((state) => !cancelled && setAuthState(state))
      .catch(() => {});

    window.waveMintAPI
      .getAppStatus()
      .then((next) => !cancelled && setAppStatus(next))
      .catch(() => {});

    window.waveMintAPI
      .getEngineStatus()
      .then((next) => !cancelled && setEngineStatus(next))
      .catch(() => {});

    const removeEngineListener = window.waveMintAPI.onEngineStatusChanged((next) => !cancelled && setEngineStatus(next));

    return () => {
      cancelled = true;
      removeEngineListener?.();
    };
  }, []);

  const navigate = useCallback((view, scope = {}) => {
    setRoute({ view, scope });
    setWorkspace("library");
  }, []);

  const viewInLibrary = useCallback(
    (trackIds) =>
      navigate("songs", {
        ids: trackIds,
        activeId: trackIds.length === 1 ? trackIds[0] : undefined,
        chip: trackIds.length === 1 ? "Just added" : `Just added (${trackIds.length})`,
        sort: "added",
      }),
    [navigate],
  );

  const handleRecheckComponents = async () => {
    setCheckingComponents(true);
    try {
      setAppStatus(await window.waveMintAPI.getAppStatus({ refresh: true }));
    } catch {
      // The alert stays as it was.
    } finally {
      setCheckingComponents(false);
    }
  };

  const authIndicator = authState && authState.mode !== "none" ? (authState.lastTest?.status === "authenticated" ? "success" : "warning") : "";
  const engineUpdateAvailable = engineStatus?.lastCheck?.status === "available";
  const settingsIndicator = authIndicator === "warning" ? "warning" : engineUpdateAvailable ? "update" : authIndicator;
  const activeNav = workspace === "add" ? "add" : route.view === "album" ? "albums" : route.view;

  return (
    <div className="app-shell">
      <AppNav
        activeId={activeNav}
        status={status}
        addActivity={addActivity}
        onAddMusic={() => setWorkspace("add")}
        onNavigate={(view) => navigate(view)}
        onOpenSettings={() => openSettings(engineUpdateAvailable ? "engine" : "")}
        settingsIndicator={settingsIndicator}
        settingsTitle={[describeAuthState(authState), engineUpdateAvailable && "An extraction engine update is available"].filter(Boolean).join(" · ")}
      />

      <SettingsDialog
        open={settingsOpen}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        busy={addActivity.busy}
        onAuthStateChange={setAuthState}
        onEngineStatusChange={(next) => {
          setEngineStatus(next);
          // A different engine changes what the startup check reports.
          window.waveMintAPI
            .getAppStatus()
            .then(setAppStatus)
            .catch(() => {});
        }}
      />

      <main className="app-workspace">
        <div className="app-workspace__panes">
          <div className="app-workspace__pane" hidden={workspace !== "library"}>
            <LibraryView route={route} onNavigate={navigate} jobsState={libraryJobs} status={status} onAddMusic={() => setWorkspace("add")} />
          </div>
          <div className="app-workspace__pane" hidden={workspace !== "add"}>
            <AddMusicView
              active={workspace === "add"}
              appStatus={appStatus}
              checkingComponents={checkingComponents}
              onRecheckComponents={handleRecheckComponents}
              onOpenSettings={openSettings}
              onViewInLibrary={viewInLibrary}
              onActivityChange={setAddActivity}
            />
          </div>
          <PlayerOverlays />
        </div>
        <PlayerBar onOpenTrack={(trackId) => navigate("songs", { ids: [trackId], activeId: trackId, chip: "Playing" })} />
      </main>
    </div>
  );
}

export default App;
