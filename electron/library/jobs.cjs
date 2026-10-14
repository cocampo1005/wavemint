// Long-running library jobs (scans, analyses, file operations). Exclusive
// jobs run one at a time so the database and the disks are never hammered
// by competing bulk work. Each job can be cancelled and reports progress.

let nextJobId = 1;

function createJobManager({ emit, logger = console }) {
  const jobs = new Map();
  let exclusiveRunning = null;

  function snapshot(job) {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  function publish(job) {
    emit("job", snapshot(job));
  }

  /**
   * Starts `work({ signal, progress })`. Returns the job snapshot at once;
   * completion is reported through "job" events.
   */
  function start(kind, label, work, { exclusive = true } = {}) {
    if (exclusive && exclusiveRunning) {
      const running = jobs.get(exclusiveRunning);
      const error = new Error(`Wait for "${running.label}" to finish first.`);
      error.code = "busy";
      throw error;
    }

    const controller = new AbortController();
    const job = {
      id: nextJobId++,
      kind,
      label,
      status: "running",
      progress: null,
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      controller,
      exclusive,
    };
    jobs.set(job.id, job);
    if (exclusive) exclusiveRunning = job.id;

    let lastEmit = 0;
    const progress = (value) => {
      job.progress = value;
      const now = Date.now();
      if (now - lastEmit > 200) {
        lastEmit = now;
        publish(job);
      }
    };

    publish(job);
    job.done = Promise.resolve()
      .then(() => work({ signal: controller.signal, progress }))
      .then((result) => {
        job.result = result ?? null;
        job.status = controller.signal.aborted ? "cancelled" : "completed";
      })
      .catch((error) => {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.error = error?.message || String(error);
        if (job.status === "failed") logger.error(`[library] ${label} failed: ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        if (exclusiveRunning === job.id) exclusiveRunning = null;
        publish(job);
        // Keep recent history small.
        const finished = [...jobs.values()].filter((item) => item.finishedAt);
        for (const old of finished.slice(0, Math.max(0, finished.length - 20))) jobs.delete(old.id);
      });

    return snapshot(job);
  }

  function cancel(id) {
    const job = jobs.get(Number(id));
    if (!job || job.finishedAt) return false;
    job.controller.abort();
    return true;
  }

  function cancelAll() {
    for (const job of jobs.values()) if (!job.finishedAt) job.controller.abort();
  }

  function list() {
    return [...jobs.values()].map(snapshot);
  }

  function isBusy() {
    return !!exclusiveRunning;
  }

  /** Resolves once every running job has finished, or after `timeoutMs`. */
  function settle(timeoutMs) {
    const running = [...jobs.values()].filter((job) => !job.finishedAt).map((job) => job.done);
    if (!running.length) return Promise.resolve();
    let timer;
    return Promise.race([Promise.allSettled(running), new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]).finally(() => clearTimeout(timer));
  }

  return { cancel, cancelAll, isBusy, list, settle, start };
}

module.exports = { createJobManager };
