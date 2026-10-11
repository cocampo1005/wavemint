// Centralized child-process execution for WaveMint's bundled tools.
//
// Every external command goes through runCommand(): argument arrays only (no
// shell, so paths with spaces or special characters are passed verbatim and
// nothing is interpreted by cmd.exe), hidden console windows, line-buffered
// output callbacks, optional timeouts, and tracking so all children can be
// stopped when WaveMint quits.

const { spawn } = require("child_process");

const activeChildren = new Set();

class ToolStartError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolStartError";
    this.code = code;
  }
}

function describeSpawnError(toolLabel, error) {
  switch (error?.code) {
    case "ENOENT":
      return new ToolStartError(
        "missing",
        `${toolLabel} could not be found. Reinstall WaveMint to restore its bundled components.`,
      );
    case "EACCES":
    case "EPERM":
      return new ToolStartError(
        "blocked",
        `${toolLabel} was blocked from starting. Your antivirus or Windows security settings may have quarantined it. Restore or allow it, then reinstall WaveMint if the problem continues.`,
      );
    default:
      return new ToolStartError(
        "failed-to-start",
        `${toolLabel} could not be started. The bundled copy may be damaged; reinstalling WaveMint should fix this.`,
      );
  }
}

function createLineSplitter(onLine) {
  let pending = "";

  return {
    push(text) {
      pending += text;
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop();
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    },
    flush() {
      if (pending.trim()) onLine(pending);
      pending = "";
    },
  };
}

// Windows does not propagate termination to grandchildren (yt-dlp spawns
// ffmpeg and deno), so stop the whole tree with taskkill.
function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;

  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => child.kill());
      return;
    } catch {
      // Fall through to a direct kill.
    }
  }

  try {
    child.kill();
  } catch {
    // The process already exited.
  }
}

function killAllChildren() {
  for (const child of activeChildren) {
    killProcessTree(child);
  }
  activeChildren.clear();
}

/**
 * Runs a command and resolves with { code, stdout, stderr, timedOut } once it
 * exits, whatever the exit code. Rejects only if the process cannot start.
 */
function runCommand(command, args, options = {}) {
  const {
    label = command,
    env,
    timeoutMs = 0,
    onStdoutData,
    onStderrData,
    onStdoutLine,
    onStderrLine,
  } = options;

  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(command, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(describeSpawnError(label, error));
      return;
    }

    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;

    const stdoutLines = onStdoutLine ? createLineSplitter(onStdoutLine) : null;
    const stderrLines = onStderrLine ? createLineSplitter(onStderrLine) : null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (text) => {
      stdout += text;
      onStdoutData?.(text);
      stdoutLines?.push(text);
    });

    child.stderr.on("data", (text) => {
      stderr += text;
      onStderrData?.(text);
      stderrLines?.push(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(describeSpawnError(label, error));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      stdoutLines?.flush();
      stderrLines?.flush();
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

module.exports = {
  ToolStartError,
  createLineSplitter,
  killAllChildren,
  runCommand,
};
