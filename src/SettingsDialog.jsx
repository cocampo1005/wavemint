import { useCallback, useEffect, useRef, useState } from "react";
import { parseIpcError } from "./ipcErrors";

const AUTH_METHODS = [
  { value: "none", label: "Off" },
  { value: "browser", label: "Browser Cookies" },
  { value: "cookies_file", label: "Cookies File" },
];

const BROWSER_STATUS_TEXT = {
  available: "Detected",
  no_cookies: "No cookies yet",
  not_found: "Not found",
};

const COMPONENT_LABELS = {
  "yt-dlp": "yt-dlp",
  ffmpeg: "FFmpeg",
  deno: "Deno",
};

const ENGINE_STAGE_TEXT = {
  checking: "Checking for the newest version…",
  verifying: "Verifying the release signature…",
  downloading: "Downloading…",
  testing: "Testing the new engine…",
  installing: "Installing…",
  done: "Installed",
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronIcon({ open }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      width="14"
      height="14"
      className={`disclosure__chevron ${open ? "is-open" : ""}`}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatRelativeTime(isoString) {
  const timestamp = Date.parse(isoString || "");
  if (!timestamp) return "";

  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }

  return "just now";
}

function formatDate(isoString) {
  const timestamp = Date.parse(isoString || "");
  return timestamp
    ? new Date(timestamp).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";
}

// Whether the last test showed the cookie source itself could be read.
// Transient failures (rate limits, timeouts) say nothing about the source.
function getSourceAccessible(test) {
  if (!test) return null;
  if (test.status === "authenticated" || test.status === "not_signed_in") return true;
  return ["rate_limited", "timeout", "unknown"].includes(test.code) ? null : false;
}

function StatusRow({ label, tone, value }) {
  return (
    <div className="auth-status__row">
      <span className="auth-status__label">{label}</span>
      <span className={`auth-status__value is-${tone}`}>
        <span className="auth-status__dot" aria-hidden="true" />
        {value}
      </span>
    </div>
  );
}

function getBrowserNote(browser) {
  if (!browser) return "";

  if (browser.engine === "firefox") {
    return "Firefox cookies can usually be read while Firefox is open.";
  }

  const name = browser.label.replace(/^(Google|Microsoft|Naver)\s+/, "");
  return `Close ${name} completely before testing. Recent versions of Chromium-based browsers on Windows can block other apps from reading their cookies (app-bound encryption). If that happens, use a cookies file instead.`;
}

function describeAccess(authState) {
  if (!authState || authState.mode === "none") {
    return { tone: "success", value: "Automatic · no sign-in" };
  }

  const method = authState.mode === "browser" ? "browser cookies" : "cookies file";
  return authState.lastTest?.status === "authenticated"
    ? { tone: "success", value: `Signed in with ${method}` }
    : { tone: "warning", value: `Using ${method} · not verified` };
}

function describeEngineCheck(status) {
  const check = status?.lastCheck;

  if (!check) return { tone: "idle", value: "Not checked yet" };
  if (check.status === "available") {
    return { tone: "warning", value: `Update available: ${check.latest}` };
  }
  if (check.status === "failed") return { tone: "error", value: "Unable to check" };
  return {
    tone: "success",
    value: `Up to date · checked ${formatRelativeTime(check.checkedAt)}`,
  };
}

function EngineSection({ busy, sectionRef, onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [working, setWorking] = useState("");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const applyStatus = useCallback((next) => {
    if (!next) return;
    setStatus(next);
    onStatusChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    window.waveMintAPI
      .getEngineStatus()
      .then((next) => !cancelled && setStatus(next))
      .catch(() => {});

    const removeProgress = window.waveMintAPI.onEngineProgress((data) => {
      if (!cancelled) setProgress(data);
    });

    return () => {
      cancelled = true;
      removeProgress?.();
    };
  }, []);

  const run = async (kind, action, fallback) => {
    setWorking(kind);
    setError("");
    setProgress(null);

    try {
      applyStatus(await action());
    } catch (err) {
      setError(parseIpcError(err, fallback).message);
      // The status still changed (for example a failed check).
      window.waveMintAPI.getEngineStatus().then(applyStatus).catch(() => {});
    } finally {
      setWorking("");
      setProgress(null);
    }
  };

  const check = describeEngineCheck(status);
  const current = status?.current;
  const updateAvailable = status?.lastCheck?.status === "available";
  const disabled = !!working || busy || !status;
  const isNightly = status?.channel === "nightly";

  return (
    <section
      className="settings-section"
      aria-labelledby="engine-heading"
      ref={sectionRef}
    >
      <span id="engine-heading" className="section-label">
        Extraction Engine
      </span>
      <p className="settings-help">
        YouTube changes often. WaveMint can install newer versions of its
        YouTube extraction engine (yt-dlp) without reinstalling the app. Every
        update is verified against yt-dlp&apos;s signed release checksums and
        tested before it&apos;s used, and the built-in version always remains
        available.
      </p>

      <div className="auth-status">
        <StatusRow
          label="Installed version"
          tone="idle"
          value={
            current
              ? `${current.version || "unknown"} · ${
                  current.source === "updated"
                    ? `updated${current.channel === "nightly" ? " (nightly)" : ""}`
                    : "built-in"
                }`
              : "…"
          }
        />
        <StatusRow label="Update status" {...check} />

        <div className="auth-status__actions">
          {updateAvailable ? (
            <button
              type="button"
              className={`btn btn--primary btn--sm ${working === "install" ? "is-loading" : ""}`}
              onClick={() =>
                run(
                  "install",
                  () => window.waveMintAPI.installEngineUpdate(),
                  "The update couldn't be installed",
                )
              }
              disabled={disabled}
            >
              {working === "install" ? "Installing…" : `Install ${status.lastCheck.latest}`}
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn--secondary btn--sm ${working === "check" ? "is-loading" : ""}`}
              onClick={() =>
                run(
                  "check",
                  () => window.waveMintAPI.checkEngineUpdate(),
                  "WaveMint couldn't check for updates",
                )
              }
              disabled={disabled}
            >
              {working === "check" ? "Checking…" : "Check for Updates"}
            </button>
          )}

          {current?.source === "updated" && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                run(
                  "bundled",
                  () => window.waveMintAPI.useBundledEngine(),
                  "WaveMint couldn't switch engines",
                )
              }
              disabled={disabled}
              title={`Go back to the version included with WaveMint (${status.bundledVersion})`}
            >
              Use Built-in Version
            </button>
          )}

          {status?.previousVersion && status.previousVersion !== current?.version && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                run(
                  "rollback",
                  () => window.waveMintAPI.rollbackEngine(),
                  "WaveMint couldn't switch engines",
                )
              }
              disabled={disabled}
            >
              {current?.source === "updated" ? "Back to" : "Use"} {status.previousVersion}
            </button>
          )}

          <span className="settings-hint">
            {busy
              ? "Available when no analysis or extraction is running."
              : working === "install" && progress
                ? `${ENGINE_STAGE_TEXT[progress.stage] || "Working…"}${
                    progress.stage === "downloading" && typeof progress.percent === "number"
                      ? ` ${Math.round(progress.percent)}%`
                      : ""
                  }`
                : updateAvailable
                  ? "Installs only after you choose to. Nothing changes until then."
                  : ""}
          </span>
        </div>

        {status?.lastCheck?.status === "failed" && status.lastCheck.message && !error && (
          <p className="auth-status__message is-warning" role="status">
            {status.lastCheck.message} WaveMint keeps working with the installed version.
          </p>
        )}

        {error && (
          <p className="auth-status__message is-warning" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="form-grid form-grid--2 settings-engine-options">
        <label className="form-field">
          <span className="form-field__label">Update channel</span>
          <select
            className="field"
            value={status?.channel || "stable"}
            onChange={(event) =>
              run(
                "channel",
                () => window.waveMintAPI.setEnginePreferences({ channel: event.target.value }),
                "The update channel couldn't be changed",
              )
            }
            disabled={disabled}
          >
            <option value="stable">Stable (recommended)</option>
            <option value="nightly">Nightly (advanced)</option>
          </select>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={status?.autoCheck ?? true}
            onChange={(event) =>
              run(
                "auto",
                () =>
                  window.waveMintAPI.setEnginePreferences({ autoCheck: event.target.checked }),
                "The setting couldn't be saved",
              )
            }
            disabled={disabled}
          />
          <span>Check for updates in the background (at most once a day)</span>
        </label>
      </div>

      {isNightly && (
        <p className="settings-note">
          Nightly builds get YouTube fixes first but are less tested and can
          break. If something stops working, choose{" "}
          <strong>Use Built-in Version</strong> or switch back to Stable.
        </p>
      )}
    </section>
  );
}

export function SettingsDialog({
  open,
  onClose,
  busy,
  initialSection = "",
  onAuthStateChange,
  onEngineStatusChange,
}) {
  const dialogRef = useRef(null);
  const accessRef = useRef(null);
  const engineRef = useRef(null);
  const [authState, setAuthState] = useState(null);
  const [viewMode, setViewMode] = useState("none");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [browsers, setBrowsers] = useState(null);
  const [appStatus, setAppStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState("");

  const onAuthStateChangeRef = useRef(onAuthStateChange);
  useEffect(() => {
    onAuthStateChangeRef.current = onAuthStateChange;
  }, [onAuthStateChange]);

  const applyAuthState = useCallback((nextState) => {
    if (!nextState) return;
    setAuthState(nextState);
    onAuthStateChangeRef.current?.(nextState);
  }, []);

  const loadBrowsers = useCallback(async () => {
    try {
      setBrowsers(await window.waveMintAPI.detectBrowsers());
    } catch (err) {
      setError(parseIpcError(err, "Could not look for installed browsers").message);
      setBrowsers([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setError("");
    setTestResult(null);

    window.waveMintAPI
      .getAuthState()
      .then((state) => {
        if (cancelled) return;
        applyAuthState(state);
        setViewMode(state.mode);
        // Advanced options stay folded away unless they're in use or the
        // user arrived here because a video needs a signed-in session.
        setAdvancedOpen(state.mode !== "none" || initialSection === "access");
        if (state.mode === "browser") loadBrowsers();
      })
      .catch((err) => {
        if (!cancelled) setError(parseIpcError(err).message);
      });

    // Loaded separately: it waits for the startup component check, which
    // must never hold up the authentication controls.
    window.waveMintAPI
      .getAppStatus()
      .then((status) => !cancelled && setAppStatus(status))
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open, initialSection, applyAuthState, loadBrowsers]);

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();

    const target =
      initialSection === "engine"
        ? engineRef.current
        : initialSection === "access"
          ? accessRef.current
          : null;
    target?.scrollIntoView?.({ block: "start" });

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, initialSection]);

  if (!open) return null;

  const runAction = async (action, fallbackMessage) => {
    setSaving(true);
    setError("");

    try {
      const nextState = await action();
      if (nextState) {
        applyAuthState(nextState);
        setViewMode(nextState.mode);
        setTestResult(null);
      }
    } catch (err) {
      setError(parseIpcError(err, fallbackMessage).message);
    } finally {
      setSaving(false);
    }
  };

  const handleMethodChange = (mode) => {
    setError("");
    setViewMode(mode);
    setTestResult(null);

    if (mode === "browser" && !browsers) loadBrowsers();

    // A method only becomes active once it is fully configured, so picking
    // a tab never leaves extraction in a half-set-up state.
    const ready =
      mode === "none" ||
      (mode === "browser" && authState?.browser) ||
      (mode === "cookies_file" && authState?.cookiesFile?.ok);

    if (ready && mode !== authState?.mode) {
      runAction(
        () => window.waveMintAPI.setAuthMode(mode),
        "Could not change the authentication method",
      );
    }
  };

  const handleBrowserChange = (browser) => {
    if (!browser) return;
    runAction(
      () => window.waveMintAPI.setAuthBrowser({ browser, profile: "" }),
      "Could not select that browser",
    );
  };

  const handleProfileChange = (profile) => {
    if (profile === "__choose__") {
      runAction(
        () => window.waveMintAPI.chooseBrowserProfileFolder(authState.browser),
        "This browser profile could not be accessed.",
      );
      return;
    }

    runAction(
      () =>
        window.waveMintAPI.setAuthBrowser({ browser: authState.browser, profile }),
      "This browser profile could not be accessed.",
    );
  };

  const handleTest = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);

    try {
      const result = await window.waveMintAPI.testAuthentication();
      setTestResult(result);
      applyAuthState(result.state);
    } catch (err) {
      setError(parseIpcError(err, "The authentication test could not run").message);
    } finally {
      setTesting(false);
    }
  };

  const persistedMode = authState?.mode || "none";
  const isActive = viewMode === persistedMode;
  const selectedBrowser = browsers?.find((item) => item.id === authState?.browser);
  const lastTest = testResult || authState?.lastTest || null;
  const sourceAccessible = getSourceAccessible(lastTest);
  const controlsDisabled = saving || testing || busy;
  const hasSavedAuth =
    persistedMode !== "none" || !!authState?.browser || !!authState?.cookiesFile;
  const access = describeAccess(authState);

  const profileOptions = selectedBrowser?.supportsProfiles
    ? selectedBrowser.profiles
    : [];
  const profileValue = authState?.browserProfile || "";
  const isCustomProfile =
    !!profileValue && !profileOptions.some((item) => item.value === profileValue);

  let sourceRow = { tone: "idle", value: "Not tested" };
  if (viewMode === "cookies_file" && authState?.cookiesFile && sourceAccessible === null) {
    sourceRow = authState.cookiesFile.ok
      ? { tone: "idle", value: "File readable (not yet tested with YouTube)" }
      : { tone: "error", value: "Problem with file" };
  }
  if (isActive && sourceAccessible === true) {
    sourceRow = { tone: "success", value: "Accessible" };
  } else if (isActive && sourceAccessible === false) {
    sourceRow = { tone: "error", value: "Could not be accessed" };
  }

  let sessionRow = { tone: "idle", value: "Not tested" };
  if (isActive && lastTest?.status === "authenticated") {
    sessionRow = {
      tone: "success",
      value: `Signed in · verified ${formatRelativeTime(lastTest.testedAt)}`,
    };
  } else if (isActive && lastTest?.status === "not_signed_in") {
    sessionRow = { tone: "warning", value: "Not signed in" };
  } else if (isActive && lastTest?.status === "failed") {
    sessionRow = { tone: "error", value: "Not confirmed" };
  }

  const canTest =
    isActive &&
    persistedMode !== "none" &&
    !controlsDisabled &&
    (persistedMode !== "cookies_file" || !!authState?.cookiesFile);

  const cookiesStats = authState?.cookiesFile?.stats;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal__header">
          <h2 id="settings-title" className="heading-md">
            Settings
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="modal__body">
          <section
            className="settings-section"
            aria-labelledby="access-heading"
            ref={accessRef}
          >
            <span id="access-heading" className="section-label">
              YouTube Access
            </span>
            <p className="settings-help">
              WaveMint automatically connects to YouTube for publicly
              accessible videos. No account setup is required.
            </p>

            <div className="auth-status">
              <StatusRow label="Current access" {...access} />
            </div>

            <button
              type="button"
              className="disclosure"
              aria-expanded={advancedOpen}
              aria-controls="advanced-auth"
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              <ChevronIcon open={advancedOpen} />
              Advanced Authentication
            </button>

            {advancedOpen && (
              <div id="advanced-auth" className="settings-advanced">
                <p className="settings-help">
                  Only needed for videos that require a signed-in YouTube
                  account, such as age-restricted or members-only videos. It
                  does not guarantee access and does not remove YouTube rate
                  limits.
                </p>

                <span className="form-field__label settings-field-label">
                  Authentication method
                </span>
                <div
                  className="segmented segmented--block"
                  role="group"
                  aria-label="Authentication method"
                >
                  {AUTH_METHODS.map((method) => (
                    <button
                      key={method.value}
                      type="button"
                      className={`segmented__option ${
                        viewMode === method.value ? "is-active" : ""
                      }`}
                      aria-pressed={viewMode === method.value}
                      onClick={() => handleMethodChange(method.value)}
                      disabled={controlsDisabled}
                    >
                      {method.label}
                    </button>
                  ))}
                </div>

                {!isActive && (
                  <p className="settings-note">
                    {viewMode === "browser"
                      ? "Choose a browser to start using browser cookies."
                      : "Choose a cookies file to start using it."}{" "}
                    WaveMint keeps using{" "}
                    {persistedMode === "none"
                      ? "automatic access"
                      : persistedMode === "browser"
                        ? "browser cookies"
                        : "the cookies file"}{" "}
                    until then.
                  </p>
                )}

                {viewMode === "none" && (
                  <p className="settings-note">
                    WaveMint will not send any YouTube cookies. Public videos and
                    playlists work normally.
                  </p>
                )}

                {viewMode === "browser" && (
                  <div className="settings-group">
                    <div className="form-grid form-grid--2">
                      <label className="form-field">
                        <span className="form-field__label">Browser</span>
                        <select
                          className={`field ${authState?.browser ? "" : "is-empty"}`}
                          value={authState?.browser || ""}
                          onChange={(event) => handleBrowserChange(event.target.value)}
                          disabled={controlsDisabled || !browsers}
                        >
                          <option value="" disabled>
                            {browsers ? "Choose a browser" : "Looking for browsers…"}
                          </option>
                          {(browsers || []).map((browser) => (
                            <option key={browser.id} value={browser.id}>
                              {browser.label} — {BROWSER_STATUS_TEXT[browser.status]}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="form-field">
                        <span className="form-field__label">Profile</span>
                        <select
                          className="field"
                          value={profileValue}
                          onChange={(event) => handleProfileChange(event.target.value)}
                          disabled={controlsDisabled || !authState?.browser || !browsers}
                        >
                          <option value="">Automatic (most recently active)</option>
                          {profileOptions.map((profile) => (
                            <option key={profile.value} value={profile.value}>
                              {profile.label}
                              {profile.isDefault ? " · last used" : ""}
                              {profile.hasCookies ? "" : " · no cookies"}
                            </option>
                          ))}
                          {isCustomProfile && (
                            <option value={profileValue}>Custom folder: {profileValue}</option>
                          )}
                          <option value="__choose__">Choose a profile folder…</option>
                        </select>
                      </label>
                    </div>

                    {selectedBrowser && (
                      <p className="settings-note">
                        {selectedBrowser.status === "not_found"
                          ? `WaveMint couldn't find ${selectedBrowser.label} data for this Windows user. If it's installed in a custom location, choose its profile folder.`
                          : selectedBrowser.status === "no_cookies"
                            ? `${selectedBrowser.label} was found, but it hasn't stored any cookies yet. Sign in to YouTube in ${selectedBrowser.label} first.`
                            : getBrowserNote(selectedBrowser)}
                      </p>
                    )}
                  </div>
                )}

                {viewMode === "cookies_file" && (
                  <div className="settings-group">
                    {authState?.cookiesFile ? (
                      <div
                        className={`file-card ${authState.cookiesFile.ok ? "" : "is-error"}`}
                      >
                        <div className="file-card__info">
                          <span className="file-card__name">{authState.cookiesFile.name}</span>
                          <span className="file-card__path" title={authState.cookiesFile.path}>
                            {authState.cookiesFile.path}
                          </span>
                          <span className="file-card__meta">
                            {authState.cookiesFile.ok
                              ? [
                                  `${cookiesStats.youtubeCookieCount} YouTube cookie${
                                    cookiesStats.youtubeCookieCount === 1 ? "" : "s"
                                  }`,
                                  cookiesStats.hasSignInCookies
                                    ? "sign-in cookies found"
                                    : "no sign-in cookies",
                                  cookiesStats.signInExpiresAt &&
                                    `${
                                      authState.cookiesFile.code === "expired"
                                        ? "expired"
                                        : "expires"
                                    } ${formatDate(cookiesStats.signInExpiresAt)}`,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : authState.cookiesFile.message}
                          </span>
                        </div>
                        <div className="file-card__actions">
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() =>
                              runAction(
                                () => window.waveMintAPI.chooseCookiesFile(),
                                "The cookie file could not be used",
                              )
                            }
                            disabled={controlsDisabled}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() =>
                              runAction(
                                () => window.waveMintAPI.removeCookiesFile(),
                                "The cookie file could not be removed",
                              )
                            }
                            disabled={controlsDisabled}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() =>
                          runAction(
                            () => window.waveMintAPI.chooseCookiesFile(),
                            "The cookie file could not be used",
                          )
                        }
                        disabled={controlsDisabled}
                      >
                        Import Cookies File…
                      </button>
                    )}

                    <p className="settings-note">
                      Use a Netscape-format cookies.txt exported from youtube.com
                      while signed in. WaveMint uses the file where it is and does
                      not copy it; yt-dlp may update it with refreshed cookies from
                      YouTube. Removing it here only makes WaveMint forget it.
                    </p>
                  </div>
                )}

                {viewMode !== "none" && (
                  <div className="auth-status">
                    <StatusRow label="Cookie source" {...sourceRow} />
                    <StatusRow label="YouTube session" {...sessionRow} />

                    <div className="auth-status__actions">
                      <button
                        type="button"
                        className={`btn btn--primary btn--sm ${testing ? "is-loading" : ""}`}
                        onClick={handleTest}
                        disabled={!canTest}
                      >
                        {testing ? "Testing…" : "Test Authentication"}
                      </button>
                      <span className="settings-hint">
                        {busy
                          ? "Available when no analysis or extraction is running."
                          : "Makes one lightweight YouTube request. Nothing is downloaded."}
                      </span>
                    </div>

                    {isActive && lastTest?.message && (
                      <p
                        className={`auth-status__message is-${
                          lastTest.status === "authenticated" ? "success" : "warning"
                        }`}
                        role="status"
                      >
                        {lastTest.message}
                      </p>
                    )}
                  </div>
                )}

                {hasSavedAuth && (
                  <div className="settings-remove">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        runAction(
                          () => window.waveMintAPI.removeAuthentication(),
                          "Authentication could not be removed",
                        )
                      }
                      disabled={controlsDisabled}
                    >
                      Remove Authentication
                    </button>
                    <span className="settings-hint">
                      Returns to automatic access and forgets the saved browser
                      and cookies file. Files on your computer aren&apos;t deleted.
                    </span>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="alert alert--compact" role="alert">
                <span>{error}</span>
              </div>
            )}
          </section>

          <EngineSection
            busy={busy}
            sectionRef={engineRef}
            onStatusChange={(status) => {
              onEngineStatusChange?.(status);
              // The About line lists the engine version in use.
              window.waveMintAPI
                .getAppStatus()
                .then(setAppStatus)
                .catch(() => {});
            }}
          />

          <section className="settings-section" aria-labelledby="about-heading">
            <span id="about-heading" className="section-label">
              About
            </span>
            <p className="settings-help">
              WaveMint {appStatus?.version || ""}
              {appStatus?.components?.length
                ? ` · ${appStatus.components
                    .map(
                      (item) =>
                        `${COMPONENT_LABELS[item.id] || item.id} ${item.version.split(" ")[0]}`,
                    )
                    .join(" · ")}`
                : ""}
            </p>
            <p className="settings-help">
              Cookies stay on this computer and are only passed to the bundled
              yt-dlp. Treat a cookies file like a password. YouTube access is
              never guaranteed and can change as YouTube updates its systems.
              Only extract content you have the right to use, in line with
              YouTube&apos;s terms and applicable law.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
