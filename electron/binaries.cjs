// Resolves WaveMint's external tools (yt-dlp, FFmpeg, FFprobe, Deno) to
// concrete executables. This is the only place that decides where a tool
// lives, so every analyze/download/artwork operation uses the same binaries.
//
// Packaged builds: always the copies bundled under <resources>/bin. The
//   user's PATH is never consulted.
// Development: the copies fetched into resources/bin/<platform>-<arch> by
//   `npm run binaries:fetch` when present, otherwise the system PATH (the
//   original dev setup). Set WAVEMINT_USE_SYSTEM_BINARIES=1 to force PATH.
// yt-dlp only: a validated in-app update (see engine.cjs) takes priority
//   over the bundled copy, which always remains the fallback.

const fs = require("fs");
const path = require("path");
const { runCommand, ToolStartError } = require("./processes.cjs");
const { parseVerboseHeader } = require("./engine.cjs");

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
  let ytDlpOverride = null;

  function resolveDefault(tool) {
    const definition = TOOLS[tool];
    if (!definition) {
      throw new Error(`Unknown tool "${tool}"`);
    }

    const bundledPath = path.join(bundledDir, `${tool}${executableSuffix}`);

    if (isPackaged || (!forceSystem && fs.existsSync(bundledPath))) {
      return { tool, label: definition.label, command: bundledPath, bundled: true, source: "bundled" };
    }

    return { tool, label: definition.label, command: tool, bundled: false, source: "system" };
  }

  // "bundled" means WaveMint manages the file (a missing file is an error);
  // "source" tells where it came from.
  function resolve(tool) {
    if (tool === "yt-dlp" && ytDlpOverride && !forceSystem) {
      return {
        tool,
        label: TOOLS[tool].label,
        command: ytDlpOverride.command,
        bundled: true,
        source: "updated",
        version: ytDlpOverride.version,
      };
    }

    return resolveDefault(tool);
  }

  /** Points yt-dlp at a validated updated engine, or back to the default. */
  function setYtDlpOverride(override) {
    ytDlpOverride = override?.command ? { command: override.command, version: override.version } : null;
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
    // --no-plugin-dirs: yt-dlp plugins installed for other tools on this PC
    // must not change how WaveMint's extraction behaves.
    const args = ["--ignore-config", "--no-plugin-dirs"];
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
    resolveDefault,
    setYtDlpOverride,
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

/**
 * Runs `yt-dlp -v` without a URL (no network access) with WaveMint's
 * runtime options and reports what it found: version, JavaScript runtimes
 * (the bundled Deno) and the bundled EJS challenge solver.
 */
async function selfTestYtDlp(resolver, command, { timeoutMs = VERSION_CHECK_TIMEOUT_MS } = {}) {
  const result = await runCommand(command, ["-v", ...resolver.getYtDlpRuntimeArgs()], {
    label: "yt-dlp",
    env: resolver.getChildEnv(),
    timeoutMs,
  });

  return { ...parseVerboseHeader(result.stderr), timedOut: result.timedOut, code: result.code };
}

async function checkYtDlp(resolver, resolved, base) {
  const header = await selfTestYtDlp(resolver, resolved.command);

  if (header.timedOut) {
    return { ...base, ok: false, problem: "unresponsive", message: `${resolved.label} did not respond.` };
  }

  if (!header.version) {
    return { ...base, ok: false, problem: "failed", message: `${resolved.label} failed its startup check.` };
  }

  const details = {
    version: header.version,
    jsRuntimes: header.jsRuntimes,
    ejsVersion: header.ejsVersion,
  };

  // With the bundled Deno, a missing runtime means this yt-dlp can't solve
  // YouTube's JavaScript challenges (for example, it needs a newer Deno).
  if (resolver.resolve("deno").bundled && !header.jsRuntimes.some((item) => item.startsWith("deno"))) {
    return {
      ...base,
      ...details,
      ok: false,
      problem: "incompatible",
      message: `${resolved.label} ${header.version} can't use WaveMint's built-in JavaScript runtime.`,
    };
  }

  return { ...base, ...details, ok: true };
}

async function checkTool(resolver, tool) {
  const resolved = resolver.resolve(tool);
  const base = {
    tool,
    label: resolved.label,
    bundled: resolved.bundled,
    source: resolved.source,
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
    if (tool === "yt-dlp") {
      return await checkYtDlp(resolver, resolved, base);
    }

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
  checkTool,
  createBinaryResolver,
  selfTestYtDlp,
  verifyDependencies,
};
