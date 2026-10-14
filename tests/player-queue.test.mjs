import assert from "node:assert/strict";
import test from "node:test";

import {
  addToQueue,
  advance,
  clearQueue,
  dropTracks,
  emptyQueue,
  goBack,
  jumpTo,
  moveQueued,
  playNext,
  removeQueued,
  setRepeat,
  setShuffle,
  skipUpcoming,
  startContext,
  upcoming,
} from "../src/player/queue.js";

// A deterministic "random" for shuffles.
function seeded(seed = 7) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const ids = [10, 11, 12, 13, 14];
const playAll = (state, steps, random) => {
  const played = [state.current?.id];
  for (let i = 0; i < steps; i += 1) {
    state = advance(state, random);
    played.push(state.current?.id ?? null);
  }
  return { state, played };
};

test("a list plays in order from the chosen song and stops at the end", () => {
  const state = startContext(emptyQueue(), { label: "Songs", ids, startId: 12 });
  assert.equal(state.current.id, 12);
  assert.deepEqual(playAll(state, 3).played, [12, 13, 14, null]);
});

test("Repeat All loops; Repeat One is handled by the player but Next still moves on", () => {
  let state = startContext(setRepeat(emptyQueue(), "all"), { ids, startId: 13 });
  assert.deepEqual(playAll(state, 4).played, [13, 14, 10, 11, 12]);
  state = startContext(setRepeat(emptyQueue(), "one"), { ids, startId: 10 });
  assert.equal(advance(state).current.id, 11);
});

test("shuffle plays every song once before repeating", () => {
  const random = seeded();
  let state = startContext(setRepeat(emptyQueue({ shuffle: true }), "all"), { ids, startId: 12 }, random);
  assert.equal(state.current.id, 12, "the chosen song plays first");
  const { played } = playAll(state, 9, random);
  assert.deepEqual([...played.slice(0, 5)].sort(), [...ids].sort(), "first round covers every song");
  assert.deepEqual([...played.slice(5, 10)].sort(), [...ids].sort(), "second round too");
  assert.notEqual(played[4], played[5], "no repeat across the restart");

  // Turning shuffle off continues the list after the current song.
  state = startContext(emptyQueue({ shuffle: true }), { ids, startId: 11 }, random);
  state = setShuffle(state, false);
  assert.equal(advance(state).current.id, 12);
  // Turning it on keeps what played and shuffles the rest.
  state = startContext(emptyQueue(), { ids, startId: 10 });
  state = advance(state);
  state = setShuffle(state, true, random);
  const rest = playAll(state, 3, random).played.slice(1);
  assert.deepEqual([...rest].sort(), [12, 13, 14]);
});

test("Play Next and Add to Queue come before the list, in a predictable order", () => {
  let state = startContext(emptyQueue(), { ids, startId: 10 });
  state = addToQueue(state, [90]);
  state = playNext(state, [80]);
  state = playNext(state, [81]); // after 80, not before it
  state = addToQueue(state, [91]);
  assert.deepEqual(
    upcoming(state, 6).map((item) => item.id),
    [80, 81, 90, 91, 11, 12],
  );
  const { played, state: after } = playAll(state, 5);
  assert.deepEqual(played, [10, 80, 81, 90, 91, 11]);
  // The queue never changed the list itself.
  assert.deepEqual(after.context.ids, ids);

  // After the song changes, Play Next goes to the front again.
  state = startContext(emptyQueue(), { ids, startId: 10 });
  state = playNext(addToQueue(state, [90]), [80]);
  state = advance(state); // 80 plays
  state = playNext(state, [81]);
  assert.deepEqual(upcoming(state, 2).map((item) => item.id), [81, 90]);
});

test("the queue can be reordered, trimmed, cleared and jumped through", () => {
  let state = startContext(emptyQueue(), { ids, startId: 10 });
  state = addToQueue(state, [90, 91, 92]);
  state = moveQueued(state, 2, 0);
  assert.deepEqual(state.upNext.map((item) => item.id), [92, 90, 91]);
  state = removeQueued(state, state.upNext[1].key);
  assert.deepEqual(state.upNext.map((item) => item.id), [92, 91]);
  const contextItem = upcoming(state).find((item) => item.id === 13);
  state = skipUpcoming(state, contextItem.orderIndex);
  assert.ok(!upcoming(state).some((item) => item.id === 13));
  assert.deepEqual(state.context.ids, ids, "skipping is for this session only");
  state = jumpTo(state, upcoming(state).find((item) => item.id === 12));
  assert.equal(state.current.id, 12);
  assert.equal(clearQueue(state).upNext.length, 0);
});

test("Previous goes back through what played", () => {
  let state = startContext(emptyQueue(), { ids, startId: 10 });
  state = playNext(state, [80]);
  state = advance(state); // 80 (queued)
  state = advance(state); // 11
  state = goBack(state);
  assert.equal(state.current.id, 80);
  state = goBack(state);
  assert.equal(state.current.id, 10);
  assert.deepEqual(upcoming(state, 2).map((item) => item.id), [80, 11], "the queued song is queued again");
});

test("removed songs leave the list, the queue and history", () => {
  let state = startContext(emptyQueue(), { ids, startId: 11 });
  state = addToQueue(state, [12, 99]);
  state = dropTracks(state, [11, 12]);
  assert.deepEqual(state.context.ids, [10, 13, 14]);
  assert.deepEqual(state.upNext.map((item) => item.id), [99]);
  const { played } = playAll(state, 2);
  assert.deepEqual(played.slice(1), [99, 13], "playback continues after the removed current song");
});
