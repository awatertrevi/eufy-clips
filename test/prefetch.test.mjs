import { test } from "node:test";
import assert from "node:assert/strict";
import { Prefetch } from "../src/prefetch.mjs";

const pad = n => String(n).padStart(2, "0");
const ago = minutes => {
  const d = new Date(Date.now() - minutes * 60_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const event = (id, minutesAgo) => ({ id, start: ago(minutesAgo + 1), end: ago(minutesAgo) });
const log = { info() {}, warn() {} };

function setup(events, { budget = 1e9, clipSize = 1, fail = new Set() } = {}) {
  const clips = new Set();
  const thumbs = new Set();
  const order = [];
  const store = { list: () => [...events].sort((a, b) => (a.start < b.start ? 1 : -1)) };
  const cache = {
    has: e => clips.has(e.id),
    hasThumbnail: e => thumbs.has(e.id),
    size: () => clips.size * clipSize,
    budget: () => budget,
    async thumbnail(e, { background }) { assert.equal(background, true); thumbs.add(e.id); },
    async clip(e, { background }) {
      assert.equal(background, true);
      if (fail.has(e.id)) throw new Error("download failed");
      order.push(e.id);
      clips.add(e.id);
    },
  };
  const client = { state: "connected", idle: true };
  const prefetch = new Prefetch(client, store, cache, { prefetchDays: 7 }, log);
  return { prefetch, clips, thumbs, order };
}

test("prefetches settled events of the window, newest first", async () => {
  const { prefetch, order, thumbs } = setup([
    event(1, 60),
    event(2, 10),
    event(3, 0.5), // ended 30 s ago: may still be written
    event(4, 8 * 24 * 60), // outside the 7-day window
  ]);
  await prefetch.kick();
  assert.deepEqual(order, [2, 1]);
  assert.deepEqual([...thumbs].sort(), [1, 2]);
});

test("stops at 90 % of the budget instead of evicting", async () => {
  const { prefetch, order } = setup([event(1, 30), event(2, 20), event(3, 10)], { budget: 2, clipSize: 1 });
  await prefetch.kick();
  assert.deepEqual(order, [3, 2]);
});

test("gives up on a clip after two failed attempts", async () => {
  const fail = new Set([1]);
  const { prefetch } = setup([event(1, 10)], { fail });
  const attempts = [];
  const warn = log.warn;
  log.warn = message => attempts.push(message);
  await prefetch.kick();
  await prefetch.kick();
  await prefetch.kick();
  log.warn = warn;
  assert.equal(attempts.length, 2);
});

test("does nothing when prefetching is disabled", async () => {
  const disabled = new Prefetch({ state: "connected", idle: true }, { list: () => [event(1, 10)] }, {}, { prefetchDays: 0 }, log);
  assert.equal(disabled.kick(), undefined);
});
