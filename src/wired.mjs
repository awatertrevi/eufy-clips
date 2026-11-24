// Wired cameras (Eufy Indoor Cam T8410) store their recordings on their own SD card, encrypted with a key
// that the app holds but the account's cipher API never hands out, so those .dat files cannot be played
// back. Their RTSP stream carries the same picture in the clear, so the service records that stream
// continuously in short segments and cuts a clip out of the archive whenever an event names a time range.
//
// The event index and the thumbnails still come from the camera's own database over P2P; only the video
// comes from here. An event older than the archive has no clip, which the UI shows as "not recorded".
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** Models that are their own station and keep recordings we cannot decrypt. */
export const WIRED_MODELS = new Set(["T8410"]);

const SEGMENT_SECONDS = 60;
const RESTART_DELAY_MS = 5_000;
// The camera's clock and the stream clock drift a second or two, so a cut gets a little air on both sides.
const PRE_ROLL_S = 2;
const POST_ROLL_S = 3;
const PRUNE_INTERVAL_MS = 5 * 60_000;

const pad = n => String(n).padStart(2, "0");
const stamp = date =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/** "20261125-002448.mp4" (local time, as ffmpeg's strftime writes it) → epoch ms. */
function segmentStart(file) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/.exec(file);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** The HomeBase and the cameras store local times ("YYYY-MM-DD HH:mm:ss"). */
export function localTime(text) {
  const t = Date.parse(String(text).replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}

export class WiredCameras {
  #config;
  #log;
  #dir;
  #cameras = new Map();
  #recorders = new Map();
  #pruner = null;
  #stopped = false;

  constructor(config, log) {
    this.#config = config;
    this.#log = log;
    this.#dir = config.wiredDir;
  }

  /** Serials this instance records, so the clip cache knows which events to cut locally. */
  has(serial) {
    return this.#cameras.has(serial);
  }

  get cameras() {
    return [...this.#cameras.values()];
  }

  /** Start (or restart) one continuous recording per camera. */
  start(cameras) {
    if (this.#config.wiredDays <= 0) return;
    fs.mkdirSync(this.#dir, { recursive: true });
    for (const camera of cameras) {
      const previous = this.#cameras.get(camera.serial);
      this.#cameras.set(camera.serial, camera);
      // A camera that moved to another address needs its recorder pointed at the new one.
      if (previous && previous.url !== camera.url) {
        this.#recorders.get(camera.serial)?.child?.kill("SIGTERM");
        this.#recorders.delete(camera.serial);
      }
      if (!this.#recorders.has(camera.serial)) this.#recorders.set(camera.serial, this.#record(camera));
    }
    if (!this.#pruner) this.#pruner = setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
  }

  stop() {
    this.#stopped = true;
    for (const rec of this.#recorders.values()) rec.child?.kill("SIGTERM");
  }

  #cameraDir(serial) {
    const dir = path.join(this.#dir, serial);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Keep one ffmpeg per camera writing clock-aligned segments, restarting it whenever it exits: a camera
   * reboots, drops off the wifi or refuses a second viewer, and the archive should resume by itself.
   */
  #record(camera) {
    const rec = { child: null, restarts: 0 };
    const spawnOnce = () => {
      if (this.#stopped) return;
      const dir = this.#cameraDir(camera.serial);
      const args = [
        "-nostdin", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-use_wallclock_as_timestamps", "1",
        "-i", camera.url,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "copy",
        // The stream's AAC carries no decoder config, so the MP4 muxer drops it unless it is re-encoded;
        // 16 kHz mono costs almost nothing on a Pi.
        "-c:a", "aac", "-ar", "16000", "-ac", "1",
        "-f", "segment", "-segment_time", String(SEGMENT_SECONDS), "-segment_atclocktime", "1",
        "-reset_timestamps", "1", "-strftime", "1", "-segment_format", "mp4",
        path.join(dir, "%Y%m%d-%H%M%S.mp4"),
      ];
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      rec.child = child;
      let stderr = "";
      child.stderr.on("data", chunk => (stderr = (stderr + chunk).slice(-400)));
      child.on("error", error => this.#log.warn(`wired ${camera.name}: ffmpeg ${error.message}`));
      child.on("close", code => {
        rec.child = null;
        if (this.#stopped) return;
        rec.restarts++;
        this.#log.warn(`wired ${camera.name}: recorder stopped (${code}) ${stderr.trim().slice(0, 200)}; restarting`);
        setTimeout(spawnOnce, RESTART_DELAY_MS).unref();
      });
      this.#log.info(`wired ${camera.name}: recording ${camera.url}`);
    };
    spawnOnce();
    return rec;
  }

  /** Segments of one camera, oldest first, each with the window it covers. */
  #segments(serial) {
    const dir = path.join(this.#dir, serial);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const list = files
      .map(file => ({ file: path.join(dir, file), start: segmentStart(file) }))
      .filter(s => s.start !== null)
      .sort((a, b) => a.start - b.start);
    return list.map((s, i) => ({
      ...s,
      // A segment runs until the next one starts; the newest one is still being written.
      end: i + 1 < list.length ? list[i + 1].start : s.start + SEGMENT_SECONDS * 1000,
    }));
  }

  /** True when the archive covers the event's whole window. */
  covers(event) {
    const from = localTime(event.start);
    const to = localTime(event.end) ?? from;
    if (from === null) return false;
    const segments = this.#segments(event.station);
    if (!segments.length) return false;
    return segments[0].start <= from && segments[segments.length - 1].end >= Math.min(to, Date.now());
  }

  /**
   * Cut the event's window out of the archive into `file`. Seeking before the input lets ffmpeg copy the
   * streams instead of re-encoding: it starts at the keyframe before the mark, which only adds a moment.
   */
  async cut(event, file) {
    const from = localTime(event.start);
    const to = localTime(event.end) ?? from + 30_000;
    if (from === null) throw new Error(`event ${event.id} has no start time`);
    const wantFrom = from - PRE_ROLL_S * 1000;
    const wantTo = Math.min(to + POST_ROLL_S * 1000, Date.now() - 1000);
    if (wantTo <= wantFrom) throw new Error("recording is still being written");

    const segments = this.#segments(event.station).filter(s => s.end > wantFrom && s.start < wantTo);
    if (!segments.length) throw new Error("not recorded: outside the local archive");

    const tmp = `${file}.tmp`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const list = path.join(tmp, "segments.txt");
      fs.writeFileSync(list, segments.map(s => `file '${s.file.replaceAll("'", "'\\''")}'`).join("\n"));
      const offset = Math.max(0, (wantFrom - segments[0].start) / 1000);
      const duration = (wantTo - wantFrom) / 1000;
      const out = path.join(tmp, "out.mp4");
      await run("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-ss", offset.toFixed(3), "-i", list,
        "-t", duration.toFixed(3), "-map", "0", "-c", "copy", "-movflags", "+faststart", out,
      ]);
      if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error("the cut produced no video");
      fs.renameSync(out, file);
      return file;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Drop segments older than the retention window, and the oldest ones once the archive is over budget. */
  prune() {
    const cutoff = Date.now() - this.#config.wiredDays * 86_400_000;
    const budget = this.#config.wiredMaxGb * 1024 ** 3;
    const all = [];
    for (const serial of this.#cameras.keys()) {
      for (const segment of this.#segments(serial)) {
        let size = 0;
        try {
          size = fs.statSync(segment.file).size;
        } catch {
          continue;
        }
        if (segment.start < cutoff) {
          fs.rmSync(segment.file, { force: true });
          continue;
        }
        all.push({ ...segment, size });
      }
    }
    let total = all.reduce((sum, s) => sum + s.size, 0);
    for (const segment of all.sort((a, b) => a.start - b.start)) {
      if (total <= budget) break;
      fs.rmSync(segment.file, { force: true });
      total -= segment.size;
    }
  }

  /** What the archive holds per camera, for the status endpoint. */
  status() {
    const out = {};
    for (const [serial, camera] of this.#cameras) {
      const segments = this.#segments(serial);
      out[serial] = {
        name: camera.name,
        recording: Boolean(this.#recorders.get(serial)?.child),
        segments: segments.length,
        from: segments.length ? new Date(segments[0].start).toISOString() : null,
        bytes: segments.reduce((sum, s) => {
          try {
            return sum + fs.statSync(s.file).size;
          } catch {
            return sum;
          }
        }, 0),
      };
    }
    return out;
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
