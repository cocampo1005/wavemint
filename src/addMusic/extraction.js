// Extraction helpers for the Add Music workspace (and Upgrade Track's URL
// source, which uses the same analysis and extraction IPC).

/**
 * An id for one part of the UI's analyses and extractions. The main process
 * tags progress events with it and can cancel just its operations, so Add
 * Music and an upgrade never see or stop each other's work.
 */
export function createRequestId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function describeComponentProblems(problems, isPackaged) {
  const names = problems.map((tool) => tool.label).join(", ");

  if (!isPackaged) {
    return `These tools are not available: ${names}. Run "npm run binaries:fetch", or install them on PATH.`;
  }

  const blocked = problems.some((tool) => tool.problem === "blocked");
  return `Some of WaveMint's built-in components could not be started: ${names}. ${
    blocked ? "Your antivirus may have quarantined them. " : ""
  }Reinstall WaveMint to repair them.`;
}

// Plain-language labels for the phases reported by the main process. Only
// phases the extraction pipeline really goes through are listed.
export const PHASE_LABELS = {
  analyzing: "Analyzing video…",
  "loading-playlist": "Loading playlist…",
  waiting: "Pausing briefly to avoid YouTube limits…",
  preparing: "Preparing audio…",
  downloading: "Downloading audio…",
  converting: "Extracting audio…",
  artwork: "Processing artwork…",
  metadata: "Writing metadata…",
  checking: "Checking the file…",
  saving: "Adding to your library…",
  complete: "Complete",
};

export function describeProgress(status, fallback) {
  if (!status?.phase) return fallback;

  if (status.phase === "retrying") {
    return status.reason === "network"
      ? "Connection interrupted. Retrying…"
      : "Trying another way…";
  }

  return PHASE_LABELS[status.phase] || fallback;
}

// Runs async work over items with limited parallelism.
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export const PREVIEW_CONCURRENCY = 4;

export const ARTWORK_OPTIONS = [
  { value: "original_thumbnail", label: "Original" },
  { value: "square_crop", label: "Square" },
  { value: "custom_file", label: "Custom" },
];

export function createArtworkState(item) {
  return {
    ...item,
    artworkMode: "square_crop",
    squareCropPreview: "",
    customArtworkPath: "",
    customArtworkPreview: "",
    artworkPreviewLoading: false,
    artworkPreviewError: "",
  };
}

export function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
