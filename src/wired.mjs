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

// MPEG-TS, not MP4: a recorder that is killed mid-segment leaves a readable TS file, while an MP4
// without its closing index cannot be opened at all and would poison every cut that touches it.
const SEGMENT_SECONDS = 30;
// A segment never outlives its clock slot by much, so anything beyond this is not one long recording
// but the hole an outage left: without the cap a seven-hour gap looks like one very long segment and
// the archive would claim to cover events it has no video of.
const MAX_SEGMENT_MS = SEGMENT_SECONDS * 1500;
const RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;
// A camera that goes quiet (wifi congestion, a second viewer taking the single RTSP slot) leaves ffmpeg
// running and reading nothing, so only a watchdog on the archive itself notices.
// Below this there is no clip worth offering, only a flash of video.
const MIN_CLIP_MS = 3_000;
// How long ffmpeg waits for the next byte before giving up; the T8410 drops its stream every few
// minutes, so this decides how much of the archive is missing each time.
const READ_TIMEOUT_S = 15;
// Backstop for a stream that keeps the socket warm but delivers nothing usable.
const STALL_MS = 60_000;
// How often a camera may be asked to switch its RTSP server back on; it needs a P2P round trip.
const REVIVE_INTERVAL_MS = 120_000;
/** ffmpeg's word for "this camera is not serving a stream right now". */
const REFUSED = /404|DESCRIBE failed|Connection refused|401|Unauthorized/i;
const WATCHDOG_INTERVAL_MS = 30_000;
// The camera's clock and the stream clock drift a second or two, so a cut gets a little air on both sides.
const PRE_ROLL_S = 2;
const POST_ROLL_S = 3;
const PRUNE_INTERVAL_MS = 5 * 60_000;

const pad = n => String(n).padStart(2, "0");
const stamp = date =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/** "20261125-002448.ts" (local time, as ffmpeg's strftime writes it) → epoch ms. */
function segmentStart(file) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ts$/.exec(file);
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
  /**
   * Called with a serial when a camera refuses the stream, so the caller can switch its RTSP server
   * back on: the camera drops it silently and no amount of reconnecting by ffmpeg brings it back.
   */
  onRefused = null;
  #pruner = null;
  #watchdog = null;
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
    if (!this.#watchdog) this.#watchdog = setInterval(() => this.restartStalled(), WATCHDOG_INTERVAL_MS).unref();
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#pruner);
    clearInterval(this.#watchdog);
    this.#pruner = null;
    this.#watchdog = null;
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
    const rec = { child: null, restarts: 0, failures: 0, startedAt: 0, revivedAt: 0 };
    const spawnOnce = () => {
      if (this.#stopped) return;
      rec.startedAt = Date.now();
      const dir = this.#cameraDir(camera.serial);
      const args = [
        "-nostdin", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-use_wallclock_as_timestamps", "1",
        // Without this ffmpeg waits forever on a camera that went quiet. Exiting makes it the close
        // handler's problem, which reconnects and, if the camera refuses, asks for its stream back.
        "-timeout", String(READ_TIMEOUT_S * 1_000_000),
        "-i", camera.url,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "copy",
        // The stream's AAC carries no decoder config, so the MP4 muxer drops it unless it is re-encoded;
        // 16 kHz mono costs almost nothing on a Pi.
        "-c:a", "aac", "-ar", "16000", "-ac", "1",
        "-f", "segment", "-segment_time", String(SEGMENT_SECONDS), "-segment_atclocktime", "1",
        "-reset_timestamps", "1", "-strftime", "1", "-segment_format", "mpegts",
        path.join(dir, "%Y%m%d-%H%M%S.ts"),
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
        // A camera that keeps refusing (it serves one RTSP viewer at a time) would otherwise be retried
        // every few seconds for as long as it is away, so each failed run waits a little longer.
        rec.failures = Date.now() - rec.startedAt > MAX_RESTART_DELAY_MS ? 0 : rec.failures + 1;
        const delay = Math.min(RESTART_DELAY_MS * Math.max(1, rec.failures), MAX_RESTART_DELAY_MS);
        if (REFUSED.test(stderr) && Date.now() - rec.revivedAt > REVIVE_INTERVAL_MS) {
          rec.revivedAt = Date.now();
          this.#revive(camera.serial);
        }
        this.#log.warn(`wired ${camera.name}: recorder stopped (${code}) ${stderr.trim().slice(0, 200)}; restarting in ${delay / 1000}s`);
        setTimeout(spawnOnce, delay).unref();
      });
      this.#log.info(`wired ${camera.name}: recording ${camera.url}`);
    };
    spawnOnce();
    return rec;
  }

  /**
   * Segments of one camera, oldest first, each with the window it covers. The newest file is still
   * being written, which a TS file takes in its stride, so it counts too: its end is how far the
   * recorder has got, which keeps a clip available within seconds of an event ending.
   */
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
    return list.map((s, i) => {
      // The next file starting later does not mean this one ran that long: between the two there may be
      // hours in which nothing was recorded at all, so a segment never reaches past its own slot.
      const limit = s.start + MAX_SEGMENT_MS;
      if (i + 1 < list.length) return { ...s, end: Math.min(list[i + 1].start, limit) };
      let end = s.start;
      try {
        end = Math.min(Math.max(s.start, fs.statSync(s.file).mtimeMs), limit);
      } catch {
        /* the recorder rotated the file away between the listing and here */
      }
      return { ...s, end };
    });
  }

  /**
   * The longest unbroken run of video the archive holds for an event, clamped to [from, to], or null
   * when there is nothing worth showing. The archive has holes — a camera drops off the wifi, the
   * recorder is restarted, the Pi loses its network for a night — and a concat across such a hole
   * fails outright, so the hole has to be found before the cut, not during it.
   *
   * A file of zero bytes is left out: ffmpeg opens the next segment before it has anything to write,
   * so a recorder killed at that moment leaves one behind, and concat cannot open it at all.
   */
  #usable(serial, from, to, inside = { from, to }) {
    const overlapping = this.#segments(serial)
      .filter(s => s.end > from && s.start < to)
      .filter(s => {
        try {
          return fs.statSync(s.file).size > 0;
        } catch {
          return false;
        }
      });
    const runs = [];
    for (const segment of overlapping) {
      const run = runs[runs.length - 1];
      if (run && segment.start <= run.end) {
        run.end = Math.max(run.end, segment.end);
        run.segments.push(segment);
      } else {
        runs.push({ start: segment.start, end: segment.end, segments: [segment] });
      }
    }
    return runs
      .map(run => ({
        segments: run.segments,
        from: Math.max(run.start, from),
        to: Math.min(run.end, to),
        // What the run shows of the event itself: a run holding only the pre-roll is no use.
        shows: Math.min(run.end, inside.to) - Math.max(run.start, inside.from),
      }))
      .filter(run => run.shows >= MIN_CLIP_MS && run.to > run.from)
      .sort((a, b) => b.shows - a.shows)[0] ?? null;
  }

  /**
   * True when the archive holds video of this event. An event the recorder slept through is shown as
   * "not recorded" rather than offered and then failing when the player asks for it.
   */
  covers(event) {
    const from = localTime(event.start);
    const to = localTime(event.end) ?? from;
    if (from === null) return false;
    return this.#usable(event.station, from, Math.max(to, from + MIN_CLIP_MS)) !== null;
  }

  /**
   * Cut the event's window out of the archive into `file`. Seeking before the input lets ffmpeg copy the
   * streams instead of re-encoding: it starts at the keyframe before the mark, which only adds a moment.
   */
  async cut(event, file) {
    const from = localTime(event.start);
    const to = localTime(event.end) ?? from + 30_000;
    if (from === null) throw new Error(`event ${event.id} has no start time`);
    const archive = this.#segments(event.station);
    if (!archive.length) throw new Error("not recorded: the local archive is still empty");
    const wantFrom = from - PRE_ROLL_S * 1000;
    const wantTo = Math.min(to + POST_ROLL_S * 1000, archive[archive.length - 1].end);
    if (wantTo <= wantFrom) throw new Error("the recording of this event is still being written");

    const span = this.#usable(event.station, wantFrom, wantTo, { from, to: Math.max(to, from + MIN_CLIP_MS) });
    if (!span) throw new Error("not recorded: the archive has no video of this event");
    const { segments } = span;
    if (span.to - span.from < wantTo - wantFrom) {
      const seconds = Math.round((span.to - span.from) / 1000);
      this.#log.warn(`clip ${event.id}: the archive has a gap here, cutting the ${seconds}s it does have`);
    }

    const tmp = `${file}.tmp`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const list = path.join(tmp, "segments.txt");
      fs.writeFileSync(list, segments.map(s => `file '${s.file.replaceAll("'", "'\\''")}'`).join("\n"));
      const offset = Math.max(0, (span.from - segments[0].start) / 1000);
      const duration = (span.to - span.from) / 1000;
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

  /** Ask the owner to switch the camera's stream back on, and point the recorder at what comes back. */
  async #revive(serial) {
    if (!this.onRefused) return;
    try {
      const camera = await this.onRefused(serial);
      this.#log.info(`wired ${this.#cameras.get(serial)?.name ?? serial}: asked the camera for its stream again`);
      if (camera?.url) this.start([{ ...this.#cameras.get(serial), ...camera }]);
    } catch (error) {
      this.#log.warn(`wired ${serial}: could not switch the stream back on: ${error.message}`);
    }
  }

  /**
   * True when a recorder is running but the archive has stopped growing. ffmpeg keeps waiting on a
   * stream that has gone quiet instead of exiting, so without this the camera stays silently off.
   */
  stalled(serial, now = Date.now()) {
    const rec = this.#recorders.get(serial);
    if (!rec?.child) return false;
    const segments = this.#segments(serial);
    const lastWrite = segments.length ? segments[segments.length - 1].end : 0;
    return now - Math.max(lastWrite, rec.startedAt) > STALL_MS;
  }

  /** Kill the recorders that stopped writing; their close handler starts them again. */
  restartStalled(now = Date.now()) {
    for (const serial of this.#recorders.keys()) {
      if (!this.stalled(serial, now)) continue;
      const name = this.#cameras.get(serial)?.name ?? serial;
      this.#log.warn(`wired ${name}: nothing recorded for ${STALL_MS / 1000}s; restarting the recorder`);
      // SIGTERM can sit unanswered while ffmpeg blocks on a read that never returns.
      this.#recorders.get(serial).child?.kill("SIGKILL");
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
        // An empty file is what a recorder killed on a segment boundary leaves behind: no video, and
        // ffmpeg cannot open it, so it only gets in the way.
        if (segment.start < cutoff || (size === 0 && segment.start < Date.now() - MAX_SEGMENT_MS)) {
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
