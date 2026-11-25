import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore, toEvent } from "../src/store.mjs";
import { ClipCache } from "../src/clips.mjs";

const log = { info() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "eufy-clips-"));
const row = (station, record) => ({ record_id: record, station_sn: station, device_sn: station, start_time: "2026-11-25 19:14:29", storage_path: "/x.dat" });

test("two wired cameras with the same record id are two events", () => {
  const store = new EventStore(tmp());
  store.upsert([toEvent(row("T8410CAMA", 2)), toEvent(row("T8410CAMB", 2))]);
  assert.equal(store.get("T8410CAMA-2").station, "T8410CAMA");
  assert.equal(store.get("T8410CAMB-2").station, "T8410CAMB");
});

test("events saved with bare record ids are loaded with station ids", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify([{ id: 1607431, station: "T8010HB", device: "T8113CAM" }]));
  const store = new EventStore(dir);
  assert.equal(store.get("T8010HB-1607431").device, "T8113CAM");
  assert.deepEqual(store.legacy.map(l => l.legacyId), [1607431]);
});

test("legacy cache files: HomeBase clips are kept, wired camera files are dropped", () => {
  const dir = tmp();
  const cacheDir = path.join(dir, "cache");
  fs.mkdirSync(cacheDir);
  for (const f of ["1607431.v2.mp4", "1607431.v2.jpg", "2.v2.jpg", "99.v2.jpg"]) fs.writeFileSync(path.join(cacheDir, f), "x");
  const cache = new ClipCache(null, null, { dataDir: dir, cacheMaxMb: 1, minFreeMb: 0 }, log);
  cache.adoptLegacy([
    { legacyId: 1607431, event: { id: "T8010HB-1607431", station: "T8010HB", device: "T8113CAM" } },
    { legacyId: 2, event: { id: "T8410CAMB-2", station: "T8410CAMB", device: "T8410CAMB" } },
  ]);
  assert.deepEqual(fs.readdirSync(cacheDir).sort(), ["T8010HB-1607431.v2.jpg", "T8010HB-1607431.v2.mp4"]);
});
