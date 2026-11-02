// Eufy Clips: index and play back clips recorded on Eufy HomeBase 2 stations.
// Configuration comes from the environment (see README.md); secrets live in /etc/eufy-clips.env.
import fs from "node:fs";
import { EufyClient } from "./eufy.mjs";
import { EventStore } from "./store.mjs";
import { ClipCache } from "./clips.mjs";
import { Sync } from "./sync.mjs";
import { Prefetch } from "./prefetch.mjs";
import { startHttp } from "./http.mjs";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

const config = {
  username: env("EUFY_USERNAME"),
  password: env("EUFY_PASSWORD"),
  country: env("EUFY_COUNTRY", "NL"),
  stations: env("EUFY_STATIONS", "").split(",").map(s => s.trim()).filter(Boolean),
  token: env("EUFY_CLIPS_TOKEN"),
  dataDir: env("EUFY_CLIPS_DATA", "./data"),
  host: env("EUFY_CLIPS_HOST", "0.0.0.0"),
  port: Number(env("EUFY_CLIPS_PORT", "8787")),
  syncIntervalMs: Number(env("EUFY_CLIPS_SYNC_MINUTES", "5")) * 60_000,
  backfillDays: Number(env("EUFY_CLIPS_BACKFILL_DAYS", "30")),
  cacheMaxMb: Number(env("EUFY_CLIPS_CACHE_MB", "1024")),
  minFreeMb: Number(env("EUFY_CLIPS_MIN_FREE_MB", "1024")),
  prefetchDays: Number(env("EUFY_CLIPS_PREFETCH_DAYS", "7")),
};
if (config.token.length < 24) throw new Error("EUFY_CLIPS_TOKEN must be at least 24 characters");
fs.mkdirSync(config.dataDir, { recursive: true });

const stamp = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.warn(stamp(), "WARN", ...a),
  error: (...a) => console.error(stamp(), "ERROR", ...a),
};

const client = new EufyClient(config, log);
const store = new EventStore(config.dataDir);
const cache = new ClipCache(client, config, log);
const sync = new Sync(client, store, config, log);
const prefetch = new Prefetch(client, store, cache, config, log);
sync.onSynced = () => prefetch.kick();
startHttp({ client, store, cache, sync, config, log });
client.on("state", state => state === "connected" && sync.run().catch(error => log.warn(`sync: ${error.message}`)));
sync.start();
await client.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    store.flush();
    client.close();
    process.exit(0);
  });
}
