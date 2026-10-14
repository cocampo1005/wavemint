// Running analyses and extractions, so they can be cancelled.
//
// Each operation belongs to a window and, optionally, to a request id chosen
// by the renderer (Add Music and Upgrade Track each use their own). Cancelling
// with a request id stops only that request's operations, so one part of the
// UI can't cancel another's work; cancelling without one stops everything the
// window started (and quitting stops everything).

const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

/** A request id from the renderer, or "" when absent or malformed. */
function normalizeRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : "";
}

function createOperationRegistry() {
  // window id -> Map<AbortController, requestId>
  const byWindow = new Map();

  function begin(windowId, requestId = "") {
    const controller = new AbortController();
    if (!byWindow.has(windowId)) byWindow.set(windowId, new Map());
    byWindow.get(windowId).set(controller, normalizeRequestId(requestId));
    return {
      signal: controller.signal,
      end: () => {
        const operations = byWindow.get(windowId);
        operations?.delete(controller);
        if (operations && !operations.size) byWindow.delete(windowId);
      },
    };
  }

  /** Aborts the window's operations (only `requestId`'s, if given). Returns how many. */
  function cancel(windowId, requestId = "") {
    const wanted = normalizeRequestId(requestId);
    let count = 0;
    for (const [controller, id] of byWindow.get(windowId) || []) {
      if (wanted && id !== wanted) continue;
      controller.abort();
      count += 1;
    }
    return count;
  }

  function cancelAll() {
    for (const operations of byWindow.values()) for (const controller of operations.keys()) controller.abort();
  }

  return { begin, cancel, cancelAll };
}

module.exports = { createOperationRegistry, normalizeRequestId };
