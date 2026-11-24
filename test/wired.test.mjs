import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WiredCameras, localTime, WIRED_MODELS } from "../src/wired.mjs";

const SERIAL = "T8410TEST00000001";
const log = { info() {}, warn() {}, error() {} };
const pad = n => String(n).padStart(2, "0");
const name = date =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.ts`;
const local = date =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wired-"));
  const config = { wiredDir: dir, wiredDays: 7, wiredMaxGb: 1 };
  return { dir, config, wired: new WiredCameras(config, log) };
}

/** Register the camera without starting ffmpeg: the tests lay down the archive themselves. */
function register(wired) {
  wired.stop();
  wired.start([{ serial: SERIAL, name: "Test", url: "rtsp://127.0.0.1/none" }]);
}

/** Lay down <count> one-minute segments of real video ending now, as the recorder would. */
function archive(dir, count, secondsEach = 60) {
  const camDir = path.join(dir, SERIAL);
  fs.mkdirSync(camDir, { recursive: true });
  const starts = [];
  const base = Date.now() - count * secondsEach * 1000;
  for (let i = 0; i < count; i++) {
    const start = new Date(base + i * secondsEach * 1000);
    starts.push(start);
    const file = path.join(camDir, name(start));
    const r = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", `testsrc=size=160x120:rate=10:duration=${secondsEach}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "20", "-f", "mpegts", file]);
    if (r.status !== 0) return null;
  }
  return starts;
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("T8410 counts as a wired camera", () => {
  assert.ok(WIRED_MODELS.has("T8410"));
  assert.ok(!WIRED_MODELS.has("T8010"));
});

test("local timestamps parse in the service's own zone", () => {
  const t = localTime("2026-11-24 23:40:14");
  assert.equal(new Date(t).getHours(), 23);
  assert.equal(localTime("nonsense"), null);
});

test("an event inside the archive is covered, one before it is not", { skip: !hasFfmpeg }, () => {
  const { dir, wired } = fixture();
  const starts = archive(dir, 4, 2);
  assert.ok(starts, "ffmpeg fixture");
  register(wired);
  const inside = { id: 1, station: SERIAL, start: local(starts[1]), end: local(new Date(starts[1].getTime() + 1000)) };
  const before = { id: 2, station: SERIAL, start: local(new Date(starts[0].getTime() - 3600_000)), end: local(new Date(starts[0].getTime() - 3599_000)) };
  assert.equal(wired.covers(inside), true);
  assert.equal(wired.covers(before), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a clip is cut from the segments that cover the event", { skip: !hasFfmpeg }, async () => {
  const { dir, wired } = fixture();
  const starts = archive(dir, 4, 2);
  assert.ok(starts, "ffmpeg fixture");
  register(wired);
  // An event spanning the boundary of two segments must still yield one playable file.
  const event = { id: 3, station: SERIAL, start: local(new Date(starts[1].getTime() + 1000)), end: local(new Date(starts[2].getTime() + 1000)) };
  const out = path.join(dir, "clip.mp4");
  await wired.cut(event, out);
  assert.ok(fs.statSync(out).size > 0);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
  assert.ok(Number(probe.stdout.trim()) > 0.5, `duration ${probe.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an event with nothing recorded is refused with a clear reason", { skip: !hasFfmpeg }, async () => {
  const { dir, wired } = fixture();
  register(wired);
  const event = { id: 4, station: SERIAL, start: "2020-01-01 00:00:00", end: "2020-01-01 00:00:10" };
  await assert.rejects(() => wired.cut(event, path.join(dir, "x.mp4")), /not recorded/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retention drops segments older than the window", { skip: !hasFfmpeg }, () => {
  const { dir, config, wired } = fixture();
  const camDir = path.join(dir, SERIAL);
  fs.mkdirSync(camDir, { recursive: true });
  const old = new Date(Date.now() - 9 * 86_400_000);
  const fresh = new Date(Date.now() - 60_000);
  fs.writeFileSync(path.join(camDir, name(old)), "x");
  fs.writeFileSync(path.join(camDir, name(fresh)), "x");
  register(wired);
  config.wiredDays = 7;
  wired.prune();
  assert.equal(fs.existsSync(path.join(camDir, name(old))), false);
  assert.equal(fs.existsSync(path.join(camDir, name(fresh))), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a segment cut short by a killed recorder is still usable", { skip: !hasFfmpeg }, async () => {
  const { dir, wired } = fixture();
  const starts = archive(dir, 3, 2);
  assert.ok(starts, "ffmpeg fixture");
  // A recorder that is killed mid-segment leaves a half-written file. In MPEG-TS that still reads,
  // which is why the archive uses it: one such file used to fail every cut that touched it.
  const victim = path.join(dir, SERIAL, name(starts[1]));
  const half = fs.readFileSync(victim);
  fs.writeFileSync(victim, half.subarray(0, Math.floor(half.length * 0.6)));
  register(wired);
  const event = { id: 5, station: SERIAL, start: local(starts[0]), end: local(new Date(starts[1].getTime() + 1000)) };
  assert.equal(wired.covers(event), true);
  const out = path.join(dir, "short.mp4");
  await wired.cut(event, out);
  assert.ok(fs.statSync(out).size > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an event past the end of the archive is refused, not half-delivered", { skip: !hasFfmpeg }, async () => {
  const { dir, wired } = fixture();
  const starts = archive(dir, 2, 2);
  assert.ok(starts, "ffmpeg fixture");
  register(wired);
  const future = { id: 6, station: SERIAL, start: local(new Date(starts[1].getTime() + 600_000)), end: local(new Date(starts[1].getTime() + 610_000)) };
  assert.equal(wired.covers(future), false);
  await assert.rejects(() => wired.cut(future, path.join(dir, "future.mp4")), /still being written|outside the local archive/);
  fs.rmSync(dir, { recursive: true, force: true });
});
