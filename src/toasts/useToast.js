// Toast notifications: short messages about something that just happened
// (saved, deleted, added, failed), shown over the app in the top-right
// corner so nothing on the page moves. See Toasts.jsx.

import { createContext, useContext } from "react";

export const ToastContext = createContext(null);

/**
 * `{ notify, dismiss }`. `notify({ text, tone, action, duration })` shows a
 * toast and returns its id. `tone` is "success" (default), "info",
 * "warning" or "error"; `action` is an optional `{ label, onClick }` (an
 * Undo, say). Errors stay until dismissed; the others close by themselves.
 */
export function useToast() {
  return useContext(ToastContext);
}
