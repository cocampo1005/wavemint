const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDiagnosticsStore,
  formatDiagnostics,
  sanitizeDiagnosticText,
} = require("../electron/diagnostics.cjs");

const HOME = "C:\\Users\\Jane Doe";

test("signed media URLs keep their host and path but lose the query", () => {
  const text =
    '[debug] Invoking http downloader on "https://rr4---sn-abc.googlevideo.com/videoplayback?expire=1&ip=2600%3A1700&sig=AE0s2J&pot=MlmuZJjUPza6g64&n=YppOnQ"';
  const sanitized = sanitizeDiagnosticText(text, { homeDir: HOME });

  assert.match(sanitized, /https:\/\/rr4---sn-abc\.googlevideo\.com\/videoplayback\?\[redacted\]/);
  assert.doesNotMatch(sanitized, /sig=|pot=|ip=2600|YppOnQ/);
});

test("tokens, cookies and credential headers are removed", () => {
  const samples = [
    ["--extractor-args youtube:po_token=mweb.gvs+MlmuZJjUPza6g64mCzQXq9u", /MlmuZJ/],
    ['{"visitorData": "CgtBQ2h1YnZ3eV9zSSi"}', /CgtBQ2/],
    ["Cookie: SID=abc123; HSID=def456", /abc123|def456/],
    ["Authorization: SAPISIDHASH 1234_abcdef", /1234_abcdef/],
    ["X-Goog-Visitor-Id: CgtBQ2h1YnZ3eV9zSSi", /CgtBQ2/],
    ["LOGIN_INFO=AFmmF2swRQIhAKx123", /AFmmF2/],
    ["poToken: Mlm-PyMnBVAl4759sMctzUThnUgQdXmH4EJVpQ5l5W5r", /Mlm-PyMn/],
    [`token ${"A".repeat(160)}`, /AAAAAAAAAA/],
    [".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsecretvalue", /secretvalue/],
  ];

  for (const [input, leak] of samples) {
    const sanitized = sanitizeDiagnosticText(input, { homeDir: HOME });
    assert.doesNotMatch(sanitized, leak, input);
  }
});

test("the user's home folder is replaced in plain and escaped paths", () => {
  const sanitized = sanitizeDiagnosticText(
    "[download] Destination: C:\\Users\\Jane Doe\\Music\\song.webm\n" +
      "file:C:\\\\Users\\\\Jane Doe\\\\Music\\\\song.mp3\n" +
      "C:/Users/Jane Doe/AppData/Roaming/WaveMint",
    { homeDir: HOME },
  );

  assert.doesNotMatch(sanitized, /Jane Doe/);
  assert.match(sanitized, /%USERPROFILE%\\Music\\song\.webm/);
});

test("ordinary diagnostic text is left readable", () => {
  const text = "ERROR: [youtube] abc: This video is unavailable\n[youtube] abc: Downloading webpage";
  assert.equal(sanitizeDiagnosticText(text, { homeDir: HOME }), text);
});

test("the store keeps a bounded, sanitized history", () => {
  const store = createDiagnosticsStore({ homeDir: HOME, maxEntries: 3 });
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(
      store.record({
        operation: "download",
        category: "network-timeout",
        message: "The connection to YouTube timed out.",
        attempts: [{ strategy: "default", category: "network-timeout", exitCode: 1, durationMs: 2100 }],
        technical: `[download]  10.0% of 1MiB\nERROR: timed out\nC:\\Users\\Jane Doe\\x`,
        context: { URL: "https://www.youtube.com/watch?v=abc" },
      }),
    );
  }

  assert.equal(store.get(ids[0]), null);
  const entry = store.get(ids[4]);
  assert.ok(entry);
  assert.doesNotMatch(entry.technical, /10\.0%/);
  assert.doesNotMatch(entry.technical, /Jane Doe/);

  const report = formatDiagnostics(entry, { appVersion: "1.0.0" });
  assert.match(report, /WaveMint: 1\.0\.0/);
  assert.match(report, /Category: network-timeout/);
  assert.match(report, /1\. default → network-timeout \(exit 1, 2\.1s\)/);
  assert.match(report, /ERROR: timed out/);
  assert.equal(store.get("does-not-exist"), null);
  assert.equal(formatDiagnostics(null), "");
});
