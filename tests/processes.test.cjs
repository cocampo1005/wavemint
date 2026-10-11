const assert = require("node:assert/strict");
const test = require("node:test");

const { ToolStartError, createLineSplitter, runCommand } = require("../electron/processes.cjs");

const node = process.execPath;

test("arguments reach the child verbatim, with no shell interpretation", async () => {
  const tricky = [
    "C:\\Users\\Some One\\Music Folder",
    'quote " inside',
    "ampersand & pipe | caret ^ percent %PATH%",
    "$(whoami) `id` ; rm -rf /",
    "--exec calc",
    "unicode 강남스타일 ♪",
  ];

  const result = await runCommand(node, [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    ...tricky,
  ]);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), tricky);
});

test("output is delivered line by line even when split across chunks", async () => {
  const lines = [];
  const result = await runCommand(
    node,
    [
      "-e",
      "process.stdout.write('[download]  1');setTimeout(()=>{process.stdout.write('2.5% of 3MiB\\nnext line\\r\\nlast')},50)",
    ],
    { onStdoutLine: (line) => lines.push(line) },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(lines, ["[download]  12.5% of 3MiB", "next line", "last"]);
});

test("line splitter handles carriage returns", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push("a\rb\r\n\nc");
  splitter.flush();
  assert.deepEqual(lines, ["a", "b", "c"]);
});

test("non-zero exits resolve with the exit code and output", async () => {
  const result = await runCommand(node, [
    "-e",
    "process.stderr.write('ERROR: nope');process.exit(3)",
  ]);

  assert.equal(result.code, 3);
  assert.equal(result.stderr, "ERROR: nope");
});

test("a missing executable produces a friendly error", async () => {
  await assert.rejects(
    runCommand("wavemint-definitely-missing-tool.exe", ["--version"], { label: "yt-dlp" }),
    (error) =>
      error instanceof ToolStartError &&
      error.code === "missing" &&
      /yt-dlp could not be found/.test(error.message),
  );
});

test("timeouts stop the process", async () => {
  const started = Date.now();
  const result = await runCommand(node, ["-e", "setTimeout(() => {}, 60000)"], {
    timeoutMs: 300,
  });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 20000);
});
