// On-demand clip and thumbnail cache. Clips are fetched from the HomeBase the first time they are
// played, muxed to MP4 with ffmpeg and kept until the cache exceeds its size budget.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { repairThumbnail } from "./thumbnail.mjs";

export class ClipCache {
  #client;
  #dir;
  #maxBytes;
  #log;
  #inflight = new Map();

  constructor(client, config, log) {
    this.#client = client;
    this.#dir = path.join(config.dataDir, "cache");
    this.#maxBytes = config.cacheMaxMb * 1024 * 1024;
    this.#log = log;
    fs.mkdirSync(this.#dir, { recursive: true });
    for (const file of fs.readdirSync(this.#dir)) {
      if (/\.(mp4|jpg)$/.test(file) && !/\.v2\.(mp4|jpg)$/.test(file)) fs.rmSync(path.join(this.#dir, file));
    }
  }

  // v2: clips cached before the completeness and channel checks may be truncated or mixed up.
  clipPath(event) {
    return path.join(this.#dir, `${event.id}.v2.mp4`);
  }

  thumbPath(event) {
    return path.join(this.#dir, `${event.id}.v2.jpg`);
  }

  has(event) {
    return fs.existsSync(this.clipPath(event));
  }

  /** Path to a playable MP4 for the event, downloading it once even when requested concurrently. */
  clip(event) {
    const file = this.clipPath(event);
    if (fs.existsSync(file)) return Promise.resolve(file);
    return this.#once(`clip:${event.id}`, async () => {
      const started = Date.now();
      this.#log.info(`clip ${event.id}: requested`);
      const { video, audio, fps, stats } = await this.#client.downloadClip(event);
      await mux(video, audio, fps, file);
      this.#log.info(`clip ${event.id}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s ${JSON.stringify(stats)}`);
      this.#evict();
      return file;
    });
  }

  thumbnail(event) {
    const file = this.thumbPath(event);
    if (fs.existsSync(file)) return Promise.resolve(file);
    return this.#once(`thumb:${event.id}`, async () => {
      const data = await this.#client.thumbnail(event.station, event.thumb);
      if (!data?.length) throw new Error("empty thumbnail");
      fs.writeFileSync(file, repairThumbnail(data));
      return file;
    });
  }

  #once(key, task) {
    if (!this.#inflight.has(key)) {
      this.#inflight.set(key, task().finally(() => this.#inflight.delete(key)));
    }
    return this.#inflight.get(key);
  }

  /** Remove least recently used clips once the cache is over budget; thumbnails are small and stay. */
  #evict() {
    const clips = fs.readdirSync(this.#dir).filter(f => f.endsWith(".mp4")).map(f => {
      const stat = fs.statSync(path.join(this.#dir, f));
      return { file: path.join(this.#dir, f), size: stat.size, used: stat.atimeMs };
    }).sort((a, b) => a.used - b.used);
    let total = clips.reduce((sum, c) => sum + c.size, 0);
    for (const clip of clips) {
      if (total <= this.#maxBytes) break;
      fs.rmSync(clip.file, { force: true });
      total -= clip.size;
    }
  }
}

/** Wrap H.264 and ADTS AAC into a faststart MP4 without re-encoding video. */
async function mux(video, audio, fps, file) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const h264 = path.join(tmp, "v.h264");
    const aac = path.join(tmp, "a.aac");
    fs.writeFileSync(h264, video);
    const args = ["-loglevel", "error", "-y", "-fflags", "+genpts", "-r", String(fps), "-i", h264];
    if (audio.length) {
      fs.writeFileSync(aac, audio);
      args.push("-f", "aac", "-i", aac, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac");
    }
    args.push("-c:v", "copy", "-movflags", "+faststart", path.join(tmp, "out.mp4"));
    await run("ffmpeg", args);
    fs.renameSync(path.join(tmp, "out.mp4"), file);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 300)}`))));
  });
}
