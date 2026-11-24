// Downloads the clips and thumbnails of recent events in the background, so playing them is instant.
// It only starts P2P work when nothing else is queued, at the lowest priority, so a clip someone
// clicks never waits behind more than the one download already running.

// The HomeBase stores local times ("YYYY-MM-DD HH:mm:ss"), so compare in the service's time zone.
const pad = n => String(n).padStart(2, "0");
const localStamp = date =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 2;
const HEADROOM = 0.9;

export class Prefetch {
  #client;
  #store;
  #cache;
  #config;
  #log;
  #running = false;
  #attempts = new Map();

  constructor(client, store, cache, config, log) {
    this.#client = client;
    this.#store = store;
    this.#cache = cache;
    this.#config = config;
    this.#log = log;
  }

  /** Start a pass over the recent events unless one is already running (called after every sync). */
  kick() {
    if (this.#running || this.#config.prefetchDays <= 0) return;
    this.#running = true;
    return this.#pass()
      .catch(error => this.#log.warn(`prefetch: ${error.message}`))
      .finally(() => (this.#running = false));
  }

  async #pass() {
    const since = localStamp(new Date(Date.now() - this.#config.prefetchDays * 86_400_000));
    // An event that ended moments ago may still be written to the HomeBase's storage.
    const settled = localStamp(new Date(Date.now() - 120_000));
    const events = this.#store.list({ limit: Infinity })
      .filter(e => e.start >= since && e.end && e.end <= settled && (this.#attempts.get(e.id) ?? 0) < MAX_ATTEMPTS);
    let fetched = 0;
    for (const event of events) {
      if (this.#client.state !== "connected") break;
      const needsClip = !this.#cache.has(event);
      // Prefetching never evicts clips to make room for more; it stops once the cache is nearly full.
      if (needsClip && this.#cache.size() > this.#cache.budget() * HEADROOM) {
        this.#log.info(`prefetch: cache full, stopping after ${fetched} clips`);
        break;
      }
      try {
        if (!this.#cache.hasThumbnail(event)) {
          await this.#idle();
          await this.#cache.thumbnail(event, { background: true });
        }
        if (needsClip) {
          await this.#idle();
          await this.#cache.clip(event, { background: true });
          fetched++;
        }
      } catch (error) {
        this.#attempts.set(event.id, (this.#attempts.get(event.id) ?? 0) + 1);
        this.#log.warn(`prefetch ${event.id}: ${error.message}`);
      }
    }
    if (fetched) this.#log.info(`prefetch: ${fetched} clips cached`);
  }

  async #idle() {
    while (!this.#client.idle) {
      if (this.#client.state !== "connected") throw new Error("Eufy session not connected");
      await sleep(1_000);
    }
  }
}
