// Decrypts the P2P frames a HomeBase 2 sends for a recorded clip.
//
// Keyframes (sign > 0) carry an ECIES envelope with a fresh AES-256 media key, wrapped for the
// cipher's ecc_private_key; their payload is AES-256-GCM. Delta frames (sign 0) are clear.
// Audio frames are AES-256-GCM with the last media key and decrypt to ADTS AAC.
import { createDecipheriv, createECDH, createHmac, timingSafeEqual } from "node:crypto";

const AAD = Buffer.from("eufy security");
export const CMD_VIDEO = 1300;
export const CMD_AUDIO = 1301;

/** Unwrap the 32-byte media key from a 129-byte ECIES envelope; undefined when it does not authenticate. */
export function unwrapMediaKey(envelope, eccPrivateKey) {
  if (envelope.length !== 129) return undefined;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(eccPrivateKey);
    const shared = ecdh.computeSecret(envelope.subarray(0, 33));
    const label = Buffer.from("ECIES");
    const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
    let previous = label;
    let derived = Buffer.alloc(0);
    while (derived.length < 48) {
      previous = hmac(shared, previous);
      derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]);
    }
    if (!timingSafeEqual(hmac(derived.subarray(16, 48), envelope.subarray(33, 97)), envelope.subarray(97, 129))) return undefined;
    const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), envelope.subarray(33, 49));
    const plain = Buffer.concat([decipher.update(envelope.subarray(49, 97)), decipher.final()]);
    return plain.length === 32 ? plain : undefined;
  } catch {
    return undefined;
  }
}

function gcm(key, iv, tag, data) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Stateful decoder for one download; feed frames in arrival order. */
export class ClipDecoder {
  #ecc;
  #mediaKey = null;
  /** Frame rate from the first video frame header; the 2C records 15 fps, the T8210 doorbell less. */
  fps;
  video = [];
  audio = [];
  stats = { clear: 0, encrypted: 0, failed: 0, audio: 0, audioFailed: 0 };

  constructor(eccPrivateKeyHex) {
    this.#ecc = Buffer.from(eccPrivateKeyHex, "hex");
    if (this.#ecc.length !== 32) throw new Error("ecc_private_key must be 32 bytes");
  }

  push(command, sign, frame) {
    if (command === CMD_VIDEO) this.#video(sign, frame);
    else if (command === CMD_AUDIO) this.#audio(frame);
  }

  #video(sign, frame) {
    if (frame.length < 22) return void this.stats.failed++;
    this.fps ??= frame.readUInt16LE(8) || undefined;
    if (sign <= 0) {
      const length = frame.readUInt32LE(0);
      this.video.push(frame.subarray(22, 22 + length));
      return void this.stats.clear++;
    }
    if (frame.length < 179) return void this.stats.failed++;
    const keyframe = (frame[4] & 1) === 1;
    const key = keyframe ? unwrapMediaKey(frame.subarray(22, 151), this.#ecc) : this.#mediaKey;
    if (!key) return void this.stats.failed++;
    try {
      this.video.push(gcm(key, frame.subarray(167, 179), frame.subarray(151, 167), frame.subarray(179)));
      if (keyframe) this.#mediaKey = key;
      this.stats.encrypted++;
    } catch {
      this.stats.failed++;
    }
  }

  #audio(frame) {
    if (!this.#mediaKey || frame.length < 44) return void this.stats.audioFailed++;
    try {
      this.audio.push(gcm(this.#mediaKey, frame.subarray(32, 44), frame.subarray(16, 32), frame.subarray(44)));
      this.stats.audio++;
    } catch {
      this.stats.audioFailed++;
    }
  }

  /** A clip is usable when at least one keyframe decrypted and nothing failed. */
  get ok() {
    return this.stats.encrypted > 0 && this.stats.failed === 0;
  }
}

/** The station reports cipher ids with a flag in the high byte; the key service wants the low 24 bits. */
export function cipherKeyId(cipherId) {
  return Number(cipherId) & 0xffffff;
}
