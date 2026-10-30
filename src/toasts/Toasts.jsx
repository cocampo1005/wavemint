import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CloseIcon, WarningIcon } from "../library/icons";
import { ToastContext } from "./useToast";
import "./toasts.css";

// How long each tone stays (ms; 0: until dismissed). A toast with an action
// (Undo) stays longer so there's time to use it.
const DURATIONS = { success: 6000, info: 6000, warning: 10000, error: 0 };
const ACTION_DURATION = 10000;
const MAX_TOASTS = 4;
const LEAVE_MS = 180;

function InfoIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

const ICONS = { success: CheckIcon, info: InfoIcon, warning: WarningIcon, error: WarningIcon };

// Toasts sit in the bottom-right corner above the player bar: the top right
// holds every view's actions (Add Music, the list toolbar, the song panel's
// close button). Side panels that would be covered push them aside: left of
// the panel when there's room, else above it (a narrow window stacks the
// song panel under the list).
const SIDE_PANELS = ".app-workspace__pane:not([hidden]) .lib-detail, .wm-queue--drawer";
const GAP = 16;
const MIN_WIDTH = 300;
const MIN_ABOVE = 200;
const PLACE_EVERY_MS = 300;

function toastCorner() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const bar = document.querySelector(".wm-player")?.getBoundingClientRect();
  let bottom = (bar?.height ? height - bar.top : 0) + GAP;
  let right = GAP;
  for (const panel of document.querySelectorAll(SIDE_PANELS)) {
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= height - bottom) continue;
    if (rect.left - 2 * GAP >= MIN_WIDTH) right = Math.max(right, width - rect.left + GAP);
    // Above it, as long as some room is left (a panel filling the window is scrolled to).
    else if (rect.top >= MIN_ABOVE) bottom = Math.max(bottom, height - rect.top + GAP);
  }
  return { right, bottom, width: Math.max(0, Math.min(380, width - right - GAP)) };
}

const sameCorner = (a, b) => a.right === b.right && a.bottom === b.bottom && a.width === b.width;

/**
 * Where the toasts go (see toastCorner), checked while any are showing: a
 * panel can open or close under a toast.
 */
function useToastCorner(active) {
  const [corner, setCorner] = useState(null);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const place = () => setCorner((current) => {
      const next = toastCorner();
      return current && sameCorner(current, next) ? current : next;
    });
    place();
    const timer = setInterval(place, PLACE_EVERY_MS);
    window.addEventListener("resize", place);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", place);
    };
  }, [active]);
  return corner;
}

/** Provides useToast() and shows the toasts above everything else. */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]); // { id, tone, text, action, duration, leaving }
  const timers = useRef(new Map());
  const nextId = useRef(1);

  const clearTimer = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  // Fades the toast out, then removes it.
  const dismiss = useCallback(
    (id) => {
      clearTimer(id);
      setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }, LEAVE_MS),
      );
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (toast) => {
      clearTimer(toast.id);
      if (toast.duration) timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), toast.duration));
    },
    [clearTimer, dismiss],
  );

  const notify = useCallback(
    ({ text, tone = "success", action = null, duration }) => {
      if (!text) return null;
      const id = nextId.current++;
      const toast = { id, tone, text, action, duration: duration ?? (action ? ACTION_DURATION : DURATIONS[tone] ?? DURATIONS.info), leaving: false };
      setToasts((current) => {
        // The same message again replaces the one showing instead of stacking.
        const kept = current.filter((item) => {
          const same = item.text === text && item.tone === tone;
          if (same) clearTimer(item.id);
          return !same;
        });
        const next = [...kept, toast];
        for (const old of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) clearTimer(old.id);
        return next.slice(-MAX_TOASTS);
      });
      schedule(toast);
      return id;
    },
    [clearTimer, schedule],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);
  const corner = useToastCorner(toasts.length > 0);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Always present, so screen readers announce what's added to it; errors interrupt (role="alert"). */}
      <section className="wm-toasts" aria-label="Notifications" aria-live="polite" aria-relevant="additions" style={corner || undefined}>
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone] || InfoIcon;
          return (
            <div
              key={toast.id}
              className={`wm-toast is-${toast.tone} ${toast.leaving ? "is-leaving" : ""}`}
              role={toast.tone === "error" ? "alert" : undefined}
              // Pointing at a toast (or tabbing into it) keeps it open.
              onMouseEnter={() => !toast.leaving && clearTimer(toast.id)}
              onMouseLeave={() => !toast.leaving && schedule(toast)}
              onFocus={() => !toast.leaving && clearTimer(toast.id)}
              onBlur={(event) => !toast.leaving && !event.currentTarget.contains(event.relatedTarget) && schedule(toast)}
            >
              <span className="wm-toast__icon">
                <Icon size={16} />
              </span>
              <span className="wm-toast__text">{toast.text}</span>
              {toast.action && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm wm-toast__action"
                  onClick={() => {
                    dismiss(toast.id);
                    toast.action.onClick();
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button type="button" className="btn btn--ghost btn--icon wm-toast__close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
                <CloseIcon size={14} />
              </button>
            </div>
          );
        })}
      </section>
    </ToastContext.Provider>
  );
}
