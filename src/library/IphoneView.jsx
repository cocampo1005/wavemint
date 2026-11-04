import { AppleFilesFlow } from "./AppleFilesFlow";
import { AppleSyncPanel } from "./AppleSyncPanel";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

/**
 * Apple Library Sync: classic iTunes is kept in step with WaveMint
 * (AppleSyncPanel); the Apple Music app for Windows, which can't be driven,
 * keeps the original prepare-and-import flow (AppleFilesFlow).
 */
export function IphoneView({ revision, exporting, running = [], onChanged, onError }) {
  const { data: settings, reload } = useLoader(() => libraryApi.getSettings(), [revision]);
  if (!settings) return null;

  if (settings.appleDestination === "files") {
    return (
      <div className="lib-iphone">
        <section className="panel">
          <p className="settings-hint">
            You&apos;re using the Apple Music app: WaveMint prepares the files and you add them yourself.{" "}
            <button
              type="button"
              className="btn btn--link"
              onClick={async () => {
                try {
                  await libraryApi.updateSettings({ patch: { appleDestination: "itunes" } });
                  reload();
                } catch (error) {
                  onError(errorMessage(error));
                }
              }}
            >
              Use classic iTunes with automatic sync instead
            </button>
          </p>
        </section>
        <AppleFilesFlow revision={revision} exporting={exporting} onChanged={onChanged} onError={onError} />
      </div>
    );
  }
  return <AppleSyncPanel revision={revision} running={running} onChanged={() => (reload(), onChanged())} onError={onError} onNavigate={() => reload()} />;
}
