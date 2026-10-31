// JPEG header recovery for HomeBase event thumbnails, ported to plain JS from eufy-mega-security
// (https://github.com/mscodemonkey/eufy-mega-security, src/mega/jpeg-header-recovery.ts and image.ts),
// MIT License, Copyright (c) 2026 Martin Steven.
//
// The HomeBase hides the thumbnail's frame header; eufy-security-client substitutes a fixed 288x176
// header, which renders as grey stripes. This finds the real geometry from the entropy-coded scan and
// restores contrast lost with the quantization tables, without re-encoding the picture.

import jpeg from "jpeg-js";

const { decode } = jpeg;



/**
 * Reconstruct one bounded event thumbnail, refusing malformed or ambiguous scans.
 *
 * The prefix must contain baseline standard luma tables. The tail must include
 * chroma tables, a three-component scan and its end marker. No identities,
 * transport keys or image contents are retained beyond this call.
 */
export function recoverJpegHeader(prefix, tail) {
  if (tail.length > 4 * 1024 * 1024) return null;
  try {
    const parsed = readTables(Buffer.concat([prefix, tail]));
    if (!parsed) return null;
    let best = null;
    for (const sampling of [0x11, 0x21, 0x22]) {
      const luma = walkScan(parsed, sampling);
      if (!luma) continue;
      const stepX = 8 * (sampling >> 4);
      const stepY = 8 * (sampling & 15);
      for (let columns = 4; columns <= Math.min(luma.length, 1920 / stepX); columns++) {
        if (luma.length % columns !== 0) continue;
        const rows = luma.length / columns;
        const width = columns * stepX;
        const height = rows * stepY;
        if (height < 32 || height > 1080 || width / height < 0.75 || width / height > 3) continue;
        let discontinuity = 0;
        for (let i = columns; i < luma.length; i++) discontinuity += Math.abs(luma[i] - luma[i - columns]);
        const score = discontinuity / (luma.length - columns) + Math.abs(width / height - 4 / 3) * 0.001;
        if (!best || score < best.score) best = { width, height, sampling, score };
      }
    }
    if (!best) return null;
    const header = Buffer.from(prefix);
    const frame = header.indexOf(Buffer.from([0xff, 0xc0]));
    if (frame < 0) return null;
    header.writeUInt16BE(best.height, frame + 5);
    header.writeUInt16BE(best.width, frame + 7);
    header[frame + 11] = best.sampling;
    const candidate = Buffer.concat([header, tail]);
    const pixels = decode(candidate, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 2.1, maxMemoryUsageInMB: 48 });

    // Lost quantization tables can collapse contrast around neutral grey.
    // Recover a bounded scale from the spread, changing tables rather than pixels.
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance = Math.round(0.299 * pixels.data[i] + 0.587 * pixels.data[i + 1] + 0.114 * pixels.data[i + 2]);
      histogram[luminance]++;
    }
    const count = pixels.width * pixels.height;
    let cumulative = 0;
    let low = 0;
    let high = 255;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative < count * 0.02) low = i;
      if (cumulative >= count * 0.98) { high = i; break; }
    }
    const scale = high - low >= 24 ? Math.min(6, Math.max(1, 220 / (high - low))) : 1;
    for (let offset = 2; offset < header.length;) {
      const marker = header[offset + 1];
      const length = header.readUInt16BE(offset + 2);
      if (marker === 0xdb) {
        for (let i = offset + 5; i < offset + 2 + length; i++) header[i] = Math.min(255, Math.round(header[i] * scale));
      }
      offset += 2 + length;
    }
    return Buffer.concat([header, tail]);
  } catch {
    return null;
  }
}

function readTables(jpeg) {
  const tables = new Map();
  for (let offset = 2; offset + 4 <= jpeg.length;) {
    if (jpeg[offset] !== 0xff) return null;
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > jpeg.length) return null;
    if (marker === 0xda) {
      if (length !== 12 || jpeg[offset + 4] !== 3 || jpeg[end - 3] !== 0 || jpeg[end - 2] !== 63 || jpeg[end - 1] !== 0) return null;
      return { tables, scan: jpeg.subarray(end) };
    }
    if (marker === 0xc4) {
      let position = offset + 4;
      while (position < end) {
        const id = jpeg[position++];
        if (position + 16 > end) return null;
        const counts = jpeg.subarray(position, position + 16);
        position += 16;
        const table = new Map();
        let code = 0;
        for (let bits = 1; bits <= 16; bits++) {
          for (let n = 0; n < counts[bits - 1]; n++) {
            if (position >= end || code >= 2 ** bits) return null;
            table.set((1 << bits) | code++, jpeg[position++]);
          }
          code *= 2;
        }
        tables.set(id, table);
      }
    }
    offset = end;
  }
  return null;
}

function walkScan(parsed, sampling) {
  const bytes = [];
  let ended = false;
  for (let i = 0; i < parsed.scan.length; i++) {
    const byte = parsed.scan[i];
    if (byte !== 0xff) { bytes.push(byte); continue; }
    const marker = parsed.scan[++i];
    if (marker === 0) { bytes.push(0xff); continue; }
    if (marker === 0xd9 && i === parsed.scan.length - 1) { ended = true; break; }
    return null;
  }
  if (!ended || bytes.length === 0) return null;
  let bit = 0;
  const read = count => {
    if (bit + count > bytes.length * 8) throw new Error("Incomplete JPEG scan");
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  const symbol = id => {
    const table = parsed.tables.get(id);
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      code = code * 2 + read(1);
      const result = table?.get((1 << bits) | code);
      if (result !== undefined) return result;
    }
    throw new Error("Invalid JPEG entropy code");
  };
  const previous = [0, 0, 0];
  const luma = [];
  const blocks = (sampling >> 4) * (sampling & 15);
  try {
    while (luma.length < 32_400) {
      const remaining = bytes.length * 8 - bit;
      if (remaining <= 8) {
        if (remaining > 0 && read(remaining) !== 2 ** remaining - 1) return null;
        return luma.length > 0 ? luma : null;
      }
      let total = 0;
      for (let component = 0; component < 3; component++) {
        for (let block = 0; block < (component === 0 ? blocks : 1); block++) {
          const table = component === 0 ? 0 : 1;
          const size = symbol(table);
          if (size > 11) return null;
          const value = read(size);
          previous[component] += size > 0 && value < 2 ** (size - 1) ? value + 1 - 2 ** size : value;
          if (component === 0) total += previous[component];
          for (let coefficient = 1; coefficient < 64;) {
            const code = symbol(0x10 | table);
            if (code === 0) break;
            const run = code >> 4;
            const magnitude = code & 15;
            if (magnitude === 0 && run !== 15 || magnitude > 10) return null;
            coefficient += magnitude === 0 ? 16 : run + 1;
            if (coefficient > 64) return null;
            read(magnitude);
          }
        }
      }
      luma.push(total / blocks);
    }
  } catch {
    return null;
  }
  return null;
}

/** Header eufy-security-client (and the Android app) put in front of a recovered thumbnail. */
const JPEG_PREFIX = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb0043000503040404030504040405050506070c08070707070f0b0b090c110f1212110f111113161c1713141a1511111821181a1d1d1f1f1f13172224221e241c1e1f1effdb0043010505050706070e08080e1e1411141e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1effc000110800b0012003012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
  "hex",
);

/** Repair a thumbnail that starts with the substituted header; anything else is returned unchanged. */
export function repairThumbnail(data) {
  if (!data.subarray(0, JPEG_PREFIX.length).equals(JPEG_PREFIX)) return data;
  return recoverJpegHeader(JPEG_PREFIX, data.subarray(JPEG_PREFIX.length)) ?? data;
}
