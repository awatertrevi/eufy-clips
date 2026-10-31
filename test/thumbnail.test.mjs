import { test } from "node:test";
import assert from "node:assert/strict";
import { repairThumbnail } from "../src/thumbnail.mjs";

test("leaves images without the substituted header untouched", () => {
  const jpeg = Buffer.from("ffd8ffe0001000ffd9", "hex");
  assert.equal(repairThumbnail(jpeg), jpeg);
});

test("returns the input when the scan cannot be recovered", () => {
  const prefix = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
  const broken = Buffer.concat([prefix, Buffer.alloc(64, 0x11)]);
  assert.equal(repairThumbnail(broken), broken);
});
