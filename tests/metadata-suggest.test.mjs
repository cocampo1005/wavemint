import assert from "node:assert/strict";
import test from "node:test";

import { findName, nameKey, rankSuggestions, uniqueNames } from "../src/library/suggest.js";

const ARTISTS = ["Arctic Monkeys", "Mumford & Sons", "Muse", "Panic! at the Disco", "The Smashing Pumpkins", "Tame Impala", "Sons of Muse"];

test("names compare ignoring case and surrounding or repeated whitespace", () => {
  assert.equal(nameKey("  Dark   Synthwave "), "dark synthwave");
  assert.equal(nameKey(null), "");
});

test("duplicates differing only in case or spacing are dropped, keeping the first spelling", () => {
  assert.deepEqual(uniqueNames(["Muse", " muse", "MUSE  ", "", "  ", null, "Hip Hop", "hip  hop", "Hip-Hop"]), ["Muse", "Hip Hop", "Hip-Hop"]);
});

test("matches that start with the text come first, then word starts, then anywhere", () => {
  assert.deepEqual(rankSuggestions(ARTISTS, "mu"), ["Mumford & Sons", "Muse", "Sons of Muse"]);
  assert.deepEqual(rankSuggestions(ARTISTS, "Mus"), ["Muse", "Sons of Muse"]);
  assert.deepEqual(rankSuggestions(ARTISTS, "pa"), ["Panic! at the Disco", "Tame Impala"]);
  assert.deepEqual(rankSuggestions(ARTISTS, "SONS"), ["Sons of Muse", "Mumford & Sons"]);
  assert.deepEqual(rankSuggestions(ARTISTS, "Mu", 1), ["Mumford & Sons"]);
});

test("an empty or unmatched query suggests nothing", () => {
  assert.deepEqual(rankSuggestions(ARTISTS, "   "), []);
  assert.deepEqual(rankSuggestions(ARTISTS, "Radiohead"), []);
});

test("a typed name is found with the library's spelling", () => {
  assert.equal(findName(ARTISTS, "  muse "), "Muse");
  assert.equal(findName(ARTISTS, "Mus"), null);
  assert.equal(findName(ARTISTS, ""), null);
});
