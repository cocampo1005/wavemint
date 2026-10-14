// The app's one music player, shared by the player bar, the queue, Listen
// Mode and the library views. Playback time lives in its own context so
// only the components that show it re-render several times a second.

import { createContext, useContext } from "react";

export const PlayerContext = createContext(null);
export const PlayerTimeContext = createContext({ current: 0, duration: 0 });

export function usePlayer() {
  return useContext(PlayerContext);
}

export function usePlayerTime() {
  return useContext(PlayerTimeContext);
}
