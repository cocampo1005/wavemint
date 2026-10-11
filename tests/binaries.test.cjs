const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createBinaryResolver, verifyDependencies } = require("../electron/binaries.cjs");
const { makeTempDir, writeFile } = require("./helpers.cjs");

const ROOT = path.resolve(__dirname, "..");
const TOOLS = ["yt-dlp", "ffmpeg", "ffprobe", "deno"];

test("packaged builds always use bundled tools, never PATH", (t) => {
  const resourcesPath = makeTempDir(t, "wavemint resources ");
  const resolver = createBinaryResolver({
    isPackaged: true,
    resourcesPath,
    appRoot: ROOT,
    env: { PATH: "C:\\Tools", WAVEMINT_USE_SYSTEM_BINARIES: "1" },
    platform: "win32",
    arch: "x64",
  });

  for (const tool of TOOLS) {
    const resolved = resolver.resolve(tool);
    assert.equal(resolved.bundled, true);
    assert.equal(resolved.command, path.join(resourcesPath, "bin", `${tool}.exe`));
  }
});

test("development prefers fetched binaries and falls back to PATH", (t) => {
  const appRoot = makeTempDir(t);
  const options = { isPackaged: false, appRoot, env: {}, platform: "win32", arch: "x64" };

  assert.equal(createBinaryResolver(options).resolve("yt-dlp").command, "yt-dlp");

  const fetched = writeFile(path.join(appRoot, "resources", "bin", "win32-x64", "yt-dlp.exe"));
  assert.equal(createBinaryResolver(options).resolve("yt-dlp").command, fetched);

  const forcedSystem = createBinaryResolver({
    ...options,
    env: { WAVEMINT_USE_SYSTEM_BINARIES: "1" },
  });
  assert.equal(forcedSystem.resolve("yt-dlp").command, "yt-dlp");
});

test("yt-dlp is pointed at the bundled Deno and FFmpeg and ignores user config", (t) => {
  const resourcesPath = makeTempDir(t, "path with spaces ");
  const cacheDir = path.join(resourcesPath, "user data", "yt-dlp-cache");
  const resolver = createBinaryResolver({
    isPackaged: true,
    resourcesPath,
    appRoot: ROOT,
    cacheDir,
    platform: "win32",
    arch: "x64",
  });
  const binDir = path.join(resourcesPath, "bin");

  assert.deepEqual(resolver.getYtDlpRuntimeArgs(), [
    "--ignore-config",
    "--no-js-runtimes",
    "--js-runtimes",
    `deno:${path.join(binDir, "deno.exe")}`,
    "--ffmpeg-location",
    binDir,
    "--cache-dir",
    cacheDir,
  ]);

  const env = resolver.getChildEnv();
  assert.equal(env.DENO_NO_UPDATE_CHECK, "1");
});

test("system tools in development get no bundled-runtime arguments", (t) => {
  const resolver = createBinaryResolver({
    isPackaged: false,
    appRoot: makeTempDir(t),
    env: {},
    platform: "win32",
    arch: "x64",
  });

  assert.deepEqual(resolver.getYtDlpRuntimeArgs(), ["--ignore-config"]);
});

test("dependency check reports missing bundled tools clearly", async (t) => {
  const resolver = createBinaryResolver({
    isPackaged: true,
    resourcesPath: makeTempDir(t),
    appRoot: ROOT,
  });

  const status = await verifyDependencies(resolver);
  assert.equal(status.ok, false);
  for (const tool of status.tools) {
    assert.equal(tool.ok, false);
    assert.equal(tool.problem, "missing");
    assert.match(tool.message, /missing from this installation/);
  }
});

const fetchedDir = path.join(ROOT, "resources", "bin", `${process.platform}-${process.arch}`);
const haveFetchedBinaries = TOOLS.every((tool) =>
  fs.existsSync(path.join(fetchedDir, `${tool}${process.platform === "win32" ? ".exe" : ""}`)),
);

test(
  "fetched binaries run (integration)",
  { skip: !haveFetchedBinaries && 'run "npm run binaries:fetch" first' },
  async () => {
    const resolver = createBinaryResolver({ isPackaged: false, appRoot: ROOT, env: {} });
    const status = await verifyDependencies(resolver);

    for (const tool of status.tools) {
      assert.equal(tool.ok, true, `${tool.label}: ${tool.message}`);
      assert.equal(tool.bundled, true);
      assert.ok(tool.version);
    }
  },
);
