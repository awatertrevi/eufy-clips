import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { ClipDecoder, CMD_AUDIO, CMD_VIDEO, cipherKeyId, unwrapMediaKey } from "../src/decode.mjs";

const AAD = Buffer.from("eufy security");

/** Build the ECIES envelope the HomeBase puts in a keyframe (inverse of unwrapMediaKey). */
function wrap(mediaKey, recipientPublicKey) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(recipientPublicKey);
  const label = Buffer.from("ECIES");
  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  let previous = label, derived = Buffer.alloc(0);
  while (derived.length < 48) { previous = hmac(shared, previous); derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]); }
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  const body = Buffer.concat([iv, cipher.update(mediaKey), cipher.final()]);
  return Buffer.concat([ephemeral.getPublicKey(null, "compressed"), body, hmac(derived.subarray(16, 48), body)]);
}

function gcmFrame(key, clear) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(clear), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function header(length, keyframe) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(length, 0);
  h[4] = keyframe ? 1 : 0;
  return h;
}

const recipient = createECDH("prime256v1");
recipient.generateKeys();
const mediaKey = randomBytes(32);

test("unwraps the media key and rejects a tampered envelope", () => {
  const envelope = wrap(mediaKey, recipient.getPublicKey());
  assert.deepEqual(unwrapMediaKey(envelope, recipient.getPrivateKey()), mediaKey);
  envelope[60] ^= 1;
  assert.equal(unwrapMediaKey(envelope, recipient.getPrivateKey()), undefined);
});

test("decodes an encrypted keyframe, a clear delta and audio in order", () => {
  const keyNal = Buffer.from("000000016764002a", "hex");
  const { iv, tag, data } = gcmFrame(mediaKey, keyNal);
  const keyframe = Buffer.concat([header(data.length, true), wrap(mediaKey, recipient.getPublicKey()), tag, iv, data]);
  const deltaNal = Buffer.from("0000000141e0", "hex");
  const delta = Buffer.concat([header(deltaNal.length, false), deltaNal]);
  const adts = Buffer.from("fff1604018024001aabb", "hex");
  const a = gcmFrame(mediaKey, adts);
  const audio = Buffer.concat([Buffer.alloc(16), a.tag, a.iv, a.data]);

  const decoder = new ClipDecoder(recipient.getPrivateKey("hex").padStart(64, "0"));
  decoder.push(CMD_VIDEO, 7, keyframe);
  decoder.push(CMD_VIDEO, 0, delta);
  decoder.push(CMD_AUDIO, 7, audio);
  assert.equal(decoder.ok, true);
  assert.deepEqual(Buffer.concat(decoder.video), Buffer.concat([keyNal, deltaNal]));
  assert.deepEqual(Buffer.concat(decoder.audio), adts);
});

test("a keyframe for another key fails instead of producing garbage", () => {
  const other = createECDH("prime256v1");
  other.generateKeys();
  const { iv, tag, data } = gcmFrame(mediaKey, Buffer.alloc(32, 1));
  const keyframe = Buffer.concat([header(data.length, true), wrap(mediaKey, other.getPublicKey()), tag, iv, data]);
  const decoder = new ClipDecoder(recipient.getPrivateKey("hex").padStart(64, "0"));
  decoder.push(CMD_VIDEO, 7, keyframe);
  assert.equal(decoder.ok, false);
  assert.equal(decoder.stats.failed, 1);
});

test("strips the flag byte from station cipher ids", () => {
  assert.equal(cipherKeyId(134217735), 7);
  assert.equal(cipherKeyId("7"), 7);
});
