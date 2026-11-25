import { test } from "node:test";
import assert from "node:assert/strict";
import { createLog } from "../src/log.mjs";

/** A console that keeps what it was handed, and a clock the test moves itself. */
function harness(windowMs = 60_000) {
  const lines = [];
  const out = {
    log: (...a) => lines.push(a.map(String).join(" ")),
    warn: (...a) => lines.push(a.map(String).join(" ")),
    error: (...a) => lines.push(a.map(String).join(" ")),
  };
  let clock = Date.parse("2026-11-25T01:00:00Z");
  const log = createLog({ out, now: () => clock, windowMs });
  return { lines, log, tick: ms => (clock += ms) };
}

test("the first line is written and the next ones are not", () => {
  const { lines, log } = harness();
  for (let i = 0; i < 500; i++) log.error("eufy: [p2p] send ENETUNREACH 13.38.179.104:32100");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ENETUNREACH/);
});

test("a flood is summarised once per window instead of per line", () => {
  const { lines, log, tick } = harness(60_000);
  for (let i = 0; i < 1000; i++) log.error("eufy: [p2p] send ENETUNREACH 13.38.179.104:32100");
  tick(61_000);
  log.error("eufy: [p2p] send ENETUNREACH 13.38.179.104:32100");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\(1000x in 61s\)/);
});

test("the same failure at another address counts as one repeat", () => {
  const { lines, log } = harness();
  log.error("eufy: [p2p] send ENETUNREACH 13.38.179.104:32100");
  log.error("eufy: [p2p] send ENETUNREACH 54.254.90.185:32100");
  assert.equal(lines.length, 1);
});

test("a different message is written straight away", () => {
  const { lines, log } = harness();
  log.error("eufy: [p2p] send ENETUNREACH 13.38.179.104:32100");
  log.warn("sync T8010: database query timed out");
  log.info("clip 42: 1.3 MB in 21.1 s");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /WARN sync/);
});

test("a repeat after the window carries the stamp of the moment it is written", () => {
  const { lines, log, tick } = harness(1_000);
  log.info("clip 42: requested");
  tick(5_000);
  log.info("clip 42: requested");
  assert.match(lines[0], /^2026-11-25T01:00:00/);
  assert.match(lines[1], /^2026-11-25T01:00:05/);
});
