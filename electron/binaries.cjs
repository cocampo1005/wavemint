// Resolves WaveMint's external tools (yt-dlp, FFmpeg, FFprobe, Deno) to
// concrete executables. This is the only place that decides where a tool
// lives, so every analyze/download/artwork operation uses the same binaries.
//
// Packaged builds: always the copies bundled under <resources>/bin. The
//   user's PATH is never consulted.
// Development: the copies fetched into resources/bin/<platform>-<arch> by
//   `npm run binaries:fetch` when present, otherwise the system PATH (the
//   original dev setup). Set WAVEMINT_USE_SYSTEM_BINARIES=1 to force PATH.

const fs = require("fs");
const path = require("path");
const { runCommand, ToolStartError } = require("./processes.cjs");

const TOOLS = {
  "yt-dlp": { label: "yt-dlp", versionArgs: ["--version"] },
  ffmpeg: { label: "FFmpeg", versionArgs: ["-version"] },
  ffprobe: { label: "FFprobe", versionArgs: ["-version"] },
  deno: { label: "Deno", versionArgs: ["--version"] },
};

const VERSION_CHECK_TIMEOUT_MS = 30000;

function createBinaryResolver({
  isPackaged,
  resourcesPath,
  appRoot,
  cacheDir = "",
  env = process.env,
  platform = process.platform,
  arch = process.arch,
}) {
  const bundledDir = isPackaged
    ? path.join(resourcesPath, "bin")
    : path.join(appRoot, "resources", "bin", `${platform}-${arch}`);
  const forceSystem = !isPackaged && env.WAVEMINT_USE_SYSTEM_BINARIES === "1";
  const executableSuffix = platform === "win32" ? ".exe" : "";

  function resolve(tool) {
    const definition = TOOLS[tool];
    if (!definition) {
      throw new Error(`Unknown tool "${tool}"`);
    }

    const bundledPath = path.join(bundledDir, `${tool}${executableSuffix}`);

    if (isPackaged || (!forceSystem && fs.existsSync(bundledPath))) {
      return { tool, label: definition.label, command: bundledPath, bundled: true };
    }

    return { tool, label: definition.label, command: tool, bundled: false };
  }

  // Environment for every child process. Deno would otherwise check for its
  // own updates over the network; WaveMint pins and ships its version.
  function getChildEnv() {
    return {
      ...env,
      DENO_NO_UPDATE_CHECK: "1",
      DENO_NO_PROMPT: "1",
    };
  }

  // Options that make yt-dlp use WaveMint's own runtime pieces instead of
  // anything it might find on the system, and ignore any yt-dlp config files
  // the user may have (which could otherwise inject cookies or change output).
  function getYtDlpRuntimeArgs() {
    const args = ["--ignore-config"];
    const deno = resolve("deno");
    const ffmpeg = resolve("ffmpeg");

    if (deno.bundled) {
      args.push("--no-js-runtimes", "--js-runtimes", `deno:${deno.command}`);
    }

    if (ffmpeg.bundled) {
      args.push("--ffmpeg-location", path.dirname(ffmpeg.command));
    }

    // Keep yt-dlp's cache inside WaveMint's own data folder, so it never mixes
    // with another yt-dlp install and is removed when WaveMint is uninstalled.
    if (cacheDir) {
      args.push("--cache-dir", cacheDir);
    }

    return args;
  }

  function readBundledVersions() {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(bundledDir, "versions.json"), "utf8"),
      );
    } catch {
      return null;
    }
  }

  return {
    bundledDir,
    isPackaged,
    resolve,
    getChildEnv,
    getYtDlpRuntimeArgs,
    readBundledVersions,
  };
}

function firstLine(text) {
  return (
    String(text || "")
      .split(/\r?\n/)
      .find((line) => line.trim()) || ""
  ).trim();
}

async function checkTool(resolver, tool) {
  const resolved = resolver.resolve(tool);
  const base = {
    tool,
    label: resolved.label,
    bundled: resolved.bundled,
  };

  if (resolved.bundled && !fs.existsSync(resolved.command)) {
    return {
      ...base,
      ok: false,
      problem: "missing",
      message: `${resolved.label} is missing from this installation.`,
    };
  }

  try {
    const result = await runCommand(resolved.command, TOOLS[tool].versionArgs, {
      label: resolved.label,
      env: resolver.getChildEnv(),
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
    });

    if (result.timedOut) {
      return {
        ...base,
        ok: false,
        problem: "unresponsive",
        message: `${resolved.label} did not respond.`,
      };
    }

    if (result.code !== 0) {
      return {
        ...base,
        ok: false,
        problem: "failed",
        message: `${resolved.label} failed its startup check.`,
      };
    }

    return { ...base, ok: true, version: firstLine(result.stdout) };
  } catch (error) {
    const problem = error instanceof ToolStartError ? error.code : "failed";
    const message =
      problem === "missing" && !resolved.bundled
        ? `${resolved.label} was not found on PATH. Run "npm run binaries:fetch" or install it.`
        : error.message;

    return { ...base, ok: false, problem, message };
  }
}

/**
 * Confirms that each tool exists and actually runs. Intended to run once in
 * the background at startup; callers should cache the result.
 */
async function verifyDependencies(resolver) {
  const tools = await Promise.all(
    Object.keys(TOOLS).map((tool) => checkTool(resolver, tool)),
  );

  return {
    ok: tools.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    tools,
  };
}

module.exports = {
  TOOLS,
  createBinaryResolver,
  verifyDependencies,
};
