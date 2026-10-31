// Keeps the event index in step with the HomeBases: recent days often, older days once (backfill).
import { toEvent } from "./store.mjs";

// The HomeBase stores local times, so dates are formatted in the service's (Europe/Amsterdam) zone.
const day = date => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);
const cursorOf = start => start.replace(/[-: ]/g, "");

export class Sync {
  #client;
  #store;
  #config;
  #log;
  #backfilled = new Set();
  running = false;
  last = null;

  constructor(client, store, config, log) {
    this.#client = client;
    this.#store = store;
    this.#config = config;
    this.#log = log;
  }

  start() {
    const tick = async () => {
      if (this.#client.state === "connected") await this.run().catch(error => this.#log.warn(`sync: ${error.message}`));
      setTimeout(tick, this.#config.syncIntervalMs);
    };
    setTimeout(tick, 5_000);
  }

  /** Sync today and yesterday every run; walk back a few older days per run until the backfill window is done. */
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const cameras = await this.#client.cameras();
      const byStation = Map.groupBy(cameras, c => c.station);
      const today = new Date();
      let added = 0;
      for (const [station, devices] of byStation) {
        const serials = devices.map(d => d.serial);
        added += await this.#window(station, serials, addDays(today, -1), addDays(today, 1));
        let budget = 5;
        for (let back = 2; back <= this.#config.backfillDays && budget > 0; back++) {
          const key = `${station}:${day(addDays(today, -back))}`;
          if (this.#backfilled.has(key)) continue;
          added += await this.#window(station, serials, addDays(today, -back), addDays(today, -back + 1));
          this.#backfilled.add(key);
          budget--;
        }
      }
      this.last = { at: new Date().toISOString(), added };
      if (added) this.#log.info(`sync: ${added} new events`);
    } finally {
      this.running = false;
    }
  }

  /** Page through one date window newest-first, using the oldest start_time seen as the next cursor. */
  async #window(station, devices, from, to) {
    let cursor = "0";
    let added = 0;
    for (let page = 0; page < 200; page++) {
      const { history, pictures } = await this.#client.queryEvents(station, devices, { startDate: day(from), endDate: day(to), cursor });
      if (!history.length) break;
      const byRecord = Map.groupBy(pictures, p => p.record_id);
      added += this.#store.upsert(history.filter(r => r.storage_path).map(r => toEvent(r, byRecord.get(r.record_id) ?? [])));
      const oldest = history.reduce((min, r) => (r.start_time < min ? r.start_time : min), history[0].start_time);
      const next = cursorOf(oldest);
      if (next === cursor) break;
      cursor = next;
    }
    return added;
  }
}
