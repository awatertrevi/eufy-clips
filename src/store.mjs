// Event index persisted as one JSON file; a HomeBase holds a few thousand records, which fits in memory.
import fs from "node:fs";
import path from "node:path";

const DETECTION = { 1: "motion", 2: "person", 3: "pet", 4: "vehicle", 5: "crying", 6: "sound" };

/** Project a history_record_info row (plus its crop pictures) to what the UI and clip fetcher need. */
export function toEvent(row, pictures = []) {
  return {
    id: row.record_id,
    station: row.station_sn,
    device: row.device_sn,
    start: row.start_time,
    end: row.end_time,
    frames: row.frame_num,
    path: row.storage_path,
    thumb: row.thumb_path,
    cipher: row.cipher_id,
    detections: [...new Set(pictures.map(p => DETECTION[p.detection_type] ?? `type${p.detection_type}`))],
  };
}

export class EventStore {
  #file;
  #events = new Map();
  #dirty = false;

  constructor(dataDir) {
    this.#file = path.join(dataDir, "events.json");
    try {
      for (const event of JSON.parse(fs.readFileSync(this.#file, "utf8"))) this.#events.set(event.id, event);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    setInterval(() => this.flush(), 30_000).unref();
  }

  /** Insert or update events; returns how many were new. */
  upsert(events) {
    let added = 0;
    for (const event of events) {
      if (!this.#events.has(event.id)) added++;
      this.#events.set(event.id, event);
    }
    if (events.length) this.#dirty = true;
    return added;
  }

  get(id) {
    return this.#events.get(id);
  }

  list({ stations, device, before, limit = 100 } = {}) {
    return [...this.#events.values()]
      .filter(e => (!stations || stations.includes(e.station)) && (!device || e.device === device) && (!before || e.start < before))
      .sort((a, b) => (a.start < b.start ? 1 : -1))
      .slice(0, limit);
  }

  countsByDevice(stations) {
    const counts = {};
    for (const e of this.#events.values()) if (!stations || stations.includes(e.station)) counts[e.device] = (counts[e.device] ?? 0) + 1;
    return counts;
  }

  flush() {
    if (!this.#dirty) return;
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.#events.values()]));
    fs.renameSync(tmp, this.#file);
    this.#dirty = false;
  }
}
