// Playback queue model (pure functions; the player owns one state object).
//
// - The *context* is what was started (a song list, Favorites, an album, a
//   playlist): its song ids, and `order`, the play order over them
//   (sequential, or a shuffled permutation so nothing repeats until every
//   song has played). `position` is where playback is in `order`.
// - *Up next* holds songs queued by hand (Play Next / Add to Queue). They
//   play before the context continues and never change the list or playlist
//   they came from. Several Play Next in a row keep the order they were
//   chosen in; after the song changes, Play Next goes to the front again.
// - `history` lets Previous go back through what actually played.

let nextKey = 1;
const key = () => `q${nextKey++}`;

export const REPEAT_MODES = ["off", "all", "one"];

export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

const range = (count) => Array.from({ length: count }, (_, index) => index);

export function emptyQueue({ shuffle = false, repeat = "off" } = {}) {
  return {
    context: { label: "", ids: [] },
    order: [],
    position: -1,
    upNext: [],
    nextInsert: 0,
    current: null, // { id, token, fromQueue, fileId? }
    history: [], // [{ id, position }]
    shuffle,
    repeat: REPEAT_MODES.includes(repeat) ? repeat : "off",
  };
}

function withCurrent(state, current) {
  const history = state.current ? [...state.history, { id: state.current.id, position: state.current.fromQueue ? null : state.position, fileId: state.current.fileId }].slice(-200) : state.history;
  return { ...state, history, current: current && { ...current, token: key() }, nextInsert: 0 };
}

/** Starts playing a list at `startId` (or its first song; with shuffle, a random one). */
export function startContext(state, { label = "", ids, startId = null, fileId = null }, random = Math.random) {
  const list = [...ids];
  if (!list.length) return state;
  let index = startId !== null ? list.indexOf(startId) : -1;
  if (index < 0) index = state.shuffle && startId === null ? Math.floor(random() * list.length) : 0;
  const order = state.shuffle ? [index, ...shuffled(range(list.length).filter((item) => item !== index), random)] : range(list.length);
  const position = state.shuffle ? 0 : index;
  return withCurrent({ ...state, context: { label, ids: list }, order, position }, { id: list[index], fromQueue: false, fileId });
}

/**
 * The next song: queued songs first, then the context; at the end, Repeat All
 * starts over (reshuffled) and Repeat Off stops (current becomes null).
 */
export function advance(state, random = Math.random) {
  if (state.upNext.length) {
    const [first, ...rest] = state.upNext;
    return withCurrent({ ...state, upNext: rest }, { id: first.id, fromQueue: true });
  }
  const { ids } = state.context;
  const nextPosition = state.position + 1;
  if (nextPosition < state.order.length) {
    return withCurrent({ ...state, position: nextPosition }, { id: ids[state.order[nextPosition]], fromQueue: false });
  }
  if (state.repeat === "all" && state.order.length) {
    let order = state.shuffle ? shuffled(range(ids.length), random) : range(ids.length);
    // Don't play the same song twice in a row across the restart.
    const last = state.current && !state.current.fromQueue ? ids.indexOf(state.current.id) : -1;
    if (state.shuffle && order.length > 1 && order[0] === last) order = [...order.slice(1), order[0]];
    return withCurrent({ ...state, order, position: 0 }, { id: ids[order[0]], fromQueue: false });
  }
  return withCurrent(state, null);
}

/** Previous: back through what played (a queued song goes back to the front of the queue). */
export function goBack(state) {
  if (!state.history.length) return state;
  const previous = state.history.at(-1);
  const upNext = state.current?.fromQueue ? [{ key: key(), id: state.current.id }, ...state.upNext] : state.upNext;
  const fromContext = previous.position !== null && previous.position !== undefined;
  return {
    ...state,
    upNext,
    history: state.history.slice(0, -1),
    position: fromContext ? previous.position : state.position,
    current: { id: previous.id, fromQueue: !fromContext, fileId: previous.fileId ?? null, token: key() },
    nextInsert: 0,
  };
}

/** Play Next: right after the current song (after earlier Play Next picks for this song). */
export function playNext(state, ids) {
  const items = ids.map((id) => ({ key: key(), id }));
  const at = Math.min(state.nextInsert, state.upNext.length);
  return { ...state, upNext: [...state.upNext.slice(0, at), ...items, ...state.upNext.slice(at)], nextInsert: at + items.length };
}

/** Add to Queue: after everything already queued. */
export function addToQueue(state, ids) {
  return { ...state, upNext: [...state.upNext, ...ids.map((id) => ({ key: key(), id }))] };
}

export function removeQueued(state, itemKey) {
  const index = state.upNext.findIndex((item) => item.key === itemKey);
  if (index < 0) return state;
  return { ...state, upNext: state.upNext.filter((item) => item.key !== itemKey), nextInsert: index < state.nextInsert ? state.nextInsert - 1 : state.nextInsert };
}

export function moveQueued(state, from, to) {
  if (from === to || from < 0 || from >= state.upNext.length) return state;
  const upNext = [...state.upNext];
  const [item] = upNext.splice(from, 1);
  upNext.splice(Math.max(0, Math.min(upNext.length, to)), 0, item);
  return { ...state, upNext, nextInsert: 0 };
}

export function clearQueue(state) {
  return { ...state, upNext: [], nextInsert: 0 };
}

/** Skips an upcoming song of the context for this session (the list itself is unchanged). */
export function skipUpcoming(state, orderIndex) {
  if (orderIndex <= state.position || orderIndex >= state.order.length) return state;
  return { ...state, order: state.order.filter((_, index) => index !== orderIndex) };
}

/** Jumps to an upcoming item: a queued song (by key) or a context position. */
export function jumpTo(state, item) {
  if (item.kind === "queue") {
    const index = state.upNext.findIndex((entry) => entry.key === item.key);
    if (index < 0) return state;
    const rest = state.upNext.filter((_, i) => i !== index);
    return withCurrent({ ...state, upNext: rest }, { id: state.upNext[index].id, fromQueue: true });
  }
  if (item.orderIndex <= state.position || item.orderIndex >= state.order.length) return state;
  return withCurrent({ ...state, position: item.orderIndex }, { id: state.context.ids[state.order[item.orderIndex]], fromQueue: false });
}

/**
 * Shuffle on: what already played stays, the rest of the list is shuffled.
 * Shuffle off: the list continues in its own order after the current song.
 */
export function setShuffle(state, shuffle, random = Math.random) {
  if (shuffle === state.shuffle) return state;
  const count = state.context.ids.length;
  if (!count) return { ...state, shuffle };
  if (shuffle) {
    const played = state.order.slice(0, state.position + 1);
    const rest = state.order.slice(state.position + 1);
    return { ...state, shuffle, order: [...played, ...shuffled(rest, random)] };
  }
  const currentIndex = state.position >= 0 ? state.order[state.position] : -1;
  return { ...state, shuffle, order: range(count), position: currentIndex };
}

export function setRepeat(state, repeat) {
  return REPEAT_MODES.includes(repeat) ? { ...state, repeat } : state;
}

/**
 * Songs that left the library: out of the list, the queue and history.
 * Returns the new state; `state.current` stays (the player skips it).
 */
export function dropTracks(state, removedIds) {
  const removed = new Set(removedIds);
  const { ids } = state.context;
  const keep = ids.map((id) => !removed.has(id));
  const newIndex = [];
  let next = 0;
  for (const kept of keep) newIndex.push(kept ? next++ : -1);
  // `position` lands on the last song that played and is still there, so
  // the next one plays next even if the current song was removed.
  const order = [];
  let position = -1;
  state.order.forEach((index, at) => {
    if (newIndex[index] >= 0) order.push(newIndex[index]);
    if (at <= state.position && newIndex[index] >= 0) position = order.length - 1;
  });
  return {
    ...state,
    context: { ...state.context, ids: ids.filter((id) => !removed.has(id)) },
    order,
    position,
    upNext: state.upNext.filter((item) => !removed.has(item.id)),
    history: state.history.filter((item) => !removed.has(item.id)),
    nextInsert: Math.min(state.nextInsert, state.upNext.filter((item) => !removed.has(item.id)).length),
  };
}

/** What plays next, in order: queued songs, then the rest of the context. */
export function upcoming(state, limit = 100) {
  const items = state.upNext.map((item) => ({ kind: "queue", key: item.key, id: item.id }));
  for (let index = state.position + 1; index < state.order.length && items.length < limit; index += 1) {
    items.push({ kind: "context", key: `c${index}`, orderIndex: index, id: state.context.ids[state.order[index]] });
  }
  return items.slice(0, limit);
}
