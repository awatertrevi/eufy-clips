import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
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

test("a configured name overrides the one from the Eufy account", async () => {
  const { EufyClient } = await import("../src/eufy.mjs");
  const config = { names: { AAA: "Office outdoor" } };
  const client = new EufyClient(config, log);
  assert.equal(client.name({ getSerial: () => "AAA", getName: () => "Office" }), "Office outdoor");
  assert.equal(client.name({ getSerial: () => "BBB", getName: () => "Bedroom" }), "Bedroom");
});

test("cameras with the same name become one entry, the rest stay apart", async () => {
  const { groupByName } = await import("../src/eufy.mjs");
  const device = (serial, name, station, model = "T8113") => ({
    getSerial: () => serial, getName: () => name, getModel: () => model, getStationSerial: () => station,
  });
  const out = groupByName(
    [device("A", "Office", "HB1"), device("B", "Office", "CAM2", "T8410"), device("C", "Bedroom", "CAM2", "T8410")],
    d => d.getName(),
  );
  assert.deepEqual(out.map(c => c.name), ["Bedroom", "Office"]);
  const merged = out.find(c => c.name === "Office");
  assert.deepEqual(merged.members, ["A", "B"]);
  assert.equal(merged.serial, "A,B", "the filter key carries every member");
  assert.equal(merged.model, "T8113/T8410");
  assert.deepEqual(out.find(c => c.name === "Bedroom").members, ["C"]);
});

test("the event list filters on every member of a merged camera", async () => {
  const { EventStore } = await import("../src/store.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const store = new EventStore(dir);
  store.upsert([
    { id: 1, station: "HB1", device: "A", start: "2026-11-25 01:00:00" },
    { id: 2, station: "CAM2", device: "B", start: "2026-11-25 02:00:00" },
    { id: 3, station: "CAM2", device: "C", start: "2026-11-25 03:00:00" },
  ]);
  assert.deepEqual(store.list({ devices: ["A", "B"] }).map(e => e.id), [2, 1]);
  assert.deepEqual(store.list({ devices: ["C"] }).map(e => e.id), [3]);
  assert.equal(store.list({}).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an event inside a hole gets no clip, one across it gets the part that was recorded", { skip: !hasFfmpeg }, async () => {
  const { dir, wired } = fixture();
  const camDir = path.join(dir, SERIAL);
  const starts = archive(dir, 2, 2);
  assert.ok(starts, "ffmpeg fixture");
  // The recorder was down for an hour and came back: the two halves are hours apart, and an event in
  // between has no video at all even though the archive starts before it and ends after it.
  const later = new Date(starts[1].getTime() + 3600_000);
  fs.copyFileSync(path.join(camDir, name(starts[1])), path.join(camDir, name(later)));
  register(wired);
  const inHole = { id: 7, station: SERIAL, start: local(new Date(starts[1].getTime() + 1800_000)), end: local(new Date(starts[1].getTime() + 1810_000)) };
  const acrossHole = { id: 8, station: SERIAL, start: local(starts[0]), end: local(new Date(later.getTime() + 1000)) };
  assert.equal(wired.covers(inHole), false, "nothing was recorded during the hole");
  assert.equal(wired.covers(acrossHole), true, "part of this event was recorded");
  await assert.rejects(() => wired.cut(inHole, path.join(dir, "hole.mp4")), /not recorded/);
  // The cut must stay on one side of the hole: concat across it fails, and the clip may not silently
  // glue an hour later onto the first seconds as if nothing happened.
  const out = path.join(dir, "across.mp4");
  await wired.cut(acrossHole, out);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
  assert.ok(Number(probe.stdout.trim()) < 60, `clip of ${probe.stdout.trim()}s must not span the hole`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty segment left by a killed recorder does not poison the cut", { skip: !hasFfmpeg }, async () => {
  const { dir, wired } = fixture();
  const starts = archive(dir, 3, 2);
  assert.ok(starts, "ffmpeg fixture");
  // ffmpeg opens the next segment before it has anything to write, so a kill at that moment leaves a
  // file of zero bytes. concat cannot open it and used to fail the whole clip.
  const empty = new Date(starts[2].getTime() + 2000);
  fs.writeFileSync(path.join(dir, SERIAL, name(empty)), "");
  register(wired);
  const event = { id: 10, station: SERIAL, start: local(starts[0]), end: local(new Date(starts[1].getTime() + 1000)) };
  assert.equal(wired.covers(event), true);
  const out = path.join(dir, "empty.mp4");
  await wired.cut(event, out);
  assert.ok(fs.statSync(out).size > 0);
  assert.equal(wired.covers({ id: 11, station: SERIAL, start: local(empty), end: local(new Date(empty.getTime() + 1000)) }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retention also clears away empty segments", () => {
  const { dir, config, wired } = fixture();
  const camDir = path.join(dir, SERIAL);
  fs.mkdirSync(camDir, { recursive: true });
  const empty = new Date(Date.now() - 600_000);
  const fresh = new Date(Date.now() - 60_000);
  fs.writeFileSync(path.join(camDir, name(empty)), "");
  fs.writeFileSync(path.join(camDir, name(fresh)), "x");
  register(wired);
  config.wiredDays = 7;
  wired.prune();
  assert.equal(fs.existsSync(path.join(camDir, name(empty))), false);
  assert.equal(fs.existsSync(path.join(camDir, name(fresh))), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a recorder that stopped writing is killed so it starts over", { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wired-"));
  const warnings = [];
  const noisy = { info() {}, warn: m => warnings.push(String(m)), error() {} };
  const wired = new WiredCameras({ wiredDir: dir, wiredDays: 7, wiredMaxGb: 1 }, noisy);
  // A server that accepts the connection and then says nothing is what a camera looks like when the
  // wifi is congested or another viewer holds its single RTSP slot: ffmpeg waits instead of exiting.
  const server = net.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    wired.start([{ serial: SERIAL, name: "Test", url: `rtsp://127.0.0.1:${server.address().port}/live0` }]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(wired.stalled(SERIAL, Date.now()), false, "a recorder that just started is not stalled");
    const later = Date.now() + 120_000;
    assert.equal(wired.stalled(SERIAL, later), true);
    wired.restartStalled(later);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.match(warnings.join("\n"), /nothing recorded/);
    assert.equal(wired.status()[SERIAL].recording, false, "the hung recorder is gone");
  } finally {
    wired.stop();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a camera that refuses the stream is asked to switch it back on", { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wired-"));
  const wired = new WiredCameras({ wiredDir: dir, wiredDays: 7, wiredMaxGb: 1 }, log);
  // The camera keeps answering RTSP but says it has no stream, which is what a T8410 does once it has
  // quietly dropped its RTSP server. Reconnecting never helps; only the switch does.
  const server = net.createServer(socket => {
    socket.on("data", data => {
      const seq = /CSeq: *(\d+)/i.exec(String(data))?.[1] ?? "1";
      socket.write(`RTSP/1.0 404 Not Found\r\nCSeq: ${seq}\r\n\r\n`);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const asked = [];
  wired.onRefused = serial => {
    asked.push(serial);
    return null; // the caller would hand back a fresh address here
  };
  try {
    wired.start([{ serial: SERIAL, name: "Test", url: `rtsp://127.0.0.1:${server.address().port}/live0` }]);
    for (let i = 0; i < 50 && !asked.length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(asked, [SERIAL]);
  } finally {
    wired.stop();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
