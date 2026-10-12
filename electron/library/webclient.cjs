// A polite HTTP client for public music databases (MusicBrainz, Cover Art
// Archive): requests to a host are queued and spaced out (MusicBrainz allows
// about one per second), identified with a User-Agent, time out, retry only
// a little (honouring Retry-After), and are cached in the library database.
// Nothing here runs unless the user starts an identification.


const DAY = 24 * 60 * 60 * 1000;
const HOST_SPACING = { "musicbrainz.org": 1100, "coverartarchive.org": 300 };

class WebError extends Error {
  constructor(message, { status = 0, code = "web" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createWebClient({
  db,
  userAgent,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  retries = 2,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  logger = console,
}) {
  const queues = new Map(); // host -> { tail: Promise, last: number }

  function enqueue(host, task) {
    const spacing = HOST_SPACING[host] ?? 500;
    const state = queues.get(host) || { tail: Promise.resolve(), last: 0 };
    const run = state.tail.then(async () => {
      const wait = state.last + spacing - now();
      if (wait > 0) await sleep(wait);
      state.last = now();
      return task();
    });
    // The queue continues even if a request fails.
    state.tail = run.catch(() => {});
    queues.set(host, state);
    return run;
  }

  function cached(key, ttlDays) {
    const row = db.prepare("SELECT status, body, fetched_at FROM web_cache WHERE key = ?").get(key);
    if (!row) return null;
    const age = now() - Date.parse(row.fetched_at);
    // Failures other than "not found" are not cached for long.
    const ttl = row.status === 200 || row.status === 404 ? ttlDays * DAY : 0;
    return age <= ttl ? row : null;
  }

  function store(key, status, body) {
    db.prepare(
      `INSERT INTO web_cache (key, status, body, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`,
    ).run(key, status, body, new Date(now()).toISOString());
  }

  async function request(url, { accept = "application/json", signal } = {}) {
    const host = new URL(url).hostname.replace(/^www\./, "");
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw new WebError("Cancelled", { code: "cancelled" });
      const response = await enqueue(host, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const forward = () => controller.abort();
        signal?.addEventListener("abort", forward, { once: true });
        try {
          return await fetchImpl(url, { headers: { "User-Agent": userAgent, Accept: accept }, signal: controller.signal, redirect: "follow" });
        } catch {
          if (signal?.aborted) throw new WebError("Cancelled", { code: "cancelled" });
          throw new WebError(controller.signal.aborted ? "The request timed out" : `Couldn't reach ${host}`, { code: "network" });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", forward);
        }
      }).catch((error) => ({ error }));

      const retryable = response.error ? response.error.code === "network" : [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= retries) {
        if (response.error) throw response.error;
        return response;
      }
      attempt += 1;
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30, retryAfter) * 1000 : attempt * 2500;
      logger.warn(`[library] ${host} asked to slow down; retrying in ${Math.round(delay / 1000)} s`);
      await sleep(delay);
    }
  }

  /** GET JSON (cached). Returns null for 404. */
  async function getJson(url, { ttlDays = 30, signal } = {}) {
    const hit = cached(url, ttlDays);
    if (hit) return hit.status === 404 ? null : JSON.parse(hit.body);
    const response = await request(url, { signal });
    if (response.status === 404) {
      store(url, 404, null);
      return null;
    }
    if (!response.ok) throw new WebError(`${new URL(url).hostname} answered ${response.status}`, { status: response.status });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new WebError("The service sent an unreadable answer");
    }
    store(url, 200, text);
    return data;
  }

  /** GET binary data (not cached here). Returns null for 404. */
  async function getBytes(url, { signal, maxBytes = 15 * 1024 * 1024 } = {}) {
    const response = await request(url, { accept: "image/*", signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new WebError(`${new URL(url).hostname} answered ${response.status}`, { status: response.status });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new WebError("The image is too large");
    return { data: buffer, type: response.headers?.get?.("content-type") || "" };
  }

  return { getBytes, getJson, cached, store };
}

module.exports = { WebError, createWebClient };
