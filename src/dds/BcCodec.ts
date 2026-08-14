/**
 * Software decoder for BC1/BC2/BC3 block-compressed texture data (pure TS, no native dependencies).
 *
 * Every block covers a 4x4 pixel tile. Decoders write RGBA8888 pixels into a
 * row-major surface buffer, clipping pixels that fall outside the surface
 * dimensions (surfaces with width/height not divisible by 4).
 */

/**
 * Expand a 5-bit channel value to 8-bit.
 */
function expand5(value: number): number {
  return (value << 3) | (value >> 2);
}

/**
 * Expand a 6-bit channel value to 8-bit.
 */
function expand6(value: number): number {
  return (value << 2) | (value >> 4);
}

/**
 * Read `count` bits from a little-endian bit stream (LSB first) starting at
 * `byteOffset * 8 + bitPos`.
 */
function readBits(data: Uint8Array, byteOffset: number, bitPos: number, count: number): number {
  let result = 0;
  let pos = byteOffset * 8 + bitPos;
  for (let i = 0; i < count; i++, pos++) {
    result |= ((data[pos >> 3] >> (pos & 7)) & 1) << i;
  }
  return result;
}

/**
 * Iterate the 4x4 pixels of a block whose top-left pixel sits at `outOffset`
 * in a row-major RGBA surface of the given `width`. `callback` receives the
 * block-local row/column and the destination offset of that pixel. Pixels
 * beyond `width` or `height` (when provided) are skipped.
 */
function forEachBlockPixel(
  out: Uint8Array,
  outOffset: number,
  width: number,
  height: number | undefined,
  callback: (row: number, col: number, pixelOffset: number) => void,
): void {
  const startPixel = outOffset >>> 2;
  const blockX = startPixel % width;
  const blockY = height === undefined ? -1 : Math.floor(startPixel / width);
  for (let row = 0; row < 4; row++) {
    if (height !== undefined && blockY + row >= height) break;
    const rowBase = outOffset + row * width * 4;
    for (let col = 0; col < 4; col++) {
      if (blockX + col >= width) break;
      callback(row, col, rowBase + col * 4);
    }
  }
}

/**
 * Decode the BC1-style RGB part of a block: two 5:6:5 endpoint colors followed
 * by 16x 2-bit palette indices (row-major, LSB first within each byte).
 *
 * When `punchthrough` is true (BC1 standalone mode) and color0 <= color1, the
 * palette has 3 colors and the 4th entry is transparent black. BC2/BC3 always
 * request the 4 opaque interpolated colors (`punchthrough` false).
 *
 * @param block - Buffer holding the block data
 * @param rgbOffset - Offset of the 8-byte BC1 RGB sub-block within `block`
 * @param out - Row-major RGBA8888 surface buffer
 * @param outOffset - Offset of the block's top-left pixel in `out`
 * @param width - Surface width in pixels
 * @param height - Surface height in pixels (undefined to skip vertical clipping)
 * @param punchthrough - Enable BC1 3-color transparent mode
 */
function decodeBc1Rgb(
  block: Uint8Array,
  rgbOffset: number,
  out: Uint8Array,
  outOffset: number,
  width: number,
  height: number | undefined,
  punchthrough: boolean,
): void {
  const c0 = block[rgbOffset] | (block[rgbOffset + 1] << 8);
  const c1 = block[rgbOffset + 2] | (block[rgbOffset + 3] << 8);

  // Unpack 5:6:5 endpoints to 8-bit channels
  const r0 = expand5((c0 >> 11) & 0x1f);
  const g0 = expand6((c0 >> 5) & 0x3f);
  const b0 = expand5(c0 & 0x1f);
  const r1 = expand5((c1 >> 11) & 0x1f);
  const g1 = expand6((c1 >> 5) & 0x3f);
  const b1 = expand5(c1 & 0x1f);

  // Build the 4-entry RGBA palette; entry 4 defaults to transparent black for
  // the punchthrough case (Uint8Array starts zeroed)
  const pal = new Uint8Array(16);
  pal[0] = r0;
  pal[1] = g0;
  pal[2] = b0;
  pal[3] = 255;
  pal[4] = r1;
  pal[5] = g1;
  pal[6] = b1;
  pal[7] = 255;
  if (punchthrough && c0 <= c1) {
    // 3-color mode: midpoint + transparent 4th entry
    pal[8] = (r0 + r1) >> 1;
    pal[9] = (g0 + g1) >> 1;
    pal[10] = (b0 + b1) >> 1;
    pal[11] = 255;
  } else {
    // 4-color mode with two interpolated entries
    pal[8] = ((2 * r0 + r1) / 3) | 0;
    pal[9] = ((2 * g0 + g1) / 3) | 0;
    pal[10] = ((2 * b0 + b1) / 3) | 0;
    pal[11] = 255;
    pal[12] = ((r0 + 2 * r1) / 3) | 0;
    pal[13] = ((g0 + 2 * g1) / 3) | 0;
    pal[14] = ((b0 + 2 * b1) / 3) | 0;
    pal[15] = 255;
  }

  // 16x 2-bit indices: one byte per row, LSB first within the row
  forEachBlockPixel(out, outOffset, width, height, (row, col, po) => {
    const idx = (block[rgbOffset + 4 + row] >> (col * 2)) & 3;
    out[po] = pal[idx * 4];
    out[po + 1] = pal[idx * 4 + 1];
    out[po + 2] = pal[idx * 4 + 2];
    out[po + 3] = pal[idx * 4 + 3];
  });
}

/**
 * Decode an 8-byte BC1 block (color0, color1, 16x 2-bit indices) into RGBA pixels.
 *
 * @param block - 8-byte block data
 * @param out - Row-major RGBA8888 surface buffer
 * @param outOffset - Offset of the block's top-left pixel in `out`
 * @param width - Surface width in pixels
 * @param height - Surface height in pixels (undefined to skip vertical clipping)
 */
export function decodeBlockBc1(block: Uint8Array, out: Uint8Array, outOffset: number, width: number, height?: number): void {
  decodeBc1Rgb(block, 0, out, outOffset, width, height, true);
}

/**
 * Decode a 16-byte BC2 block (8 bytes explicit 4-bit alpha + 8 bytes BC1-style
 * RGB with a forced 4-color palette) into RGBA pixels.
 *
 * @param block - 16-byte block data
 * @param out - Row-major RGBA8888 surface buffer
 * @param outOffset - Offset of the block's top-left pixel in `out`
 * @param width - Surface width in pixels
 * @param height - Surface height in pixels (undefined to skip vertical clipping)
 */
export function decodeBlockBc2(block: Uint8Array, out: Uint8Array, outOffset: number, width: number, height?: number): void {
  // RGB first (writes opaque alpha), then overlay the explicit alpha values
  decodeBc1Rgb(block, 8, out, outOffset, width, height, false);

  // 16x 4-bit alpha values packed into the first 8 bytes, LSB first
  forEachBlockPixel(out, outOffset, width, height, (row, col, po) => {
    const i = row * 4 + col;
    const a4 = (block[i >> 1] >> ((i & 1) << 2)) & 0xf;
    out[po + 3] = (a4 << 4) | a4; // scale 0..15 to 0..255
  });
}

/**
 * Decode a 16-byte BC3 block (8 bytes BC4-style interpolated alpha + 8 bytes
 * BC1-style RGB with a forced 4-color palette) into RGBA pixels.
 *
 * @param block - 16-byte block data
 * @param out - Row-major RGBA8888 surface buffer
 * @param outOffset - Offset of the block's top-left pixel in `out`
 * @param width - Surface width in pixels
 * @param height - Surface height in pixels (undefined to skip vertical clipping)
 */
export function decodeBlockBc3(block: Uint8Array, out: Uint8Array, outOffset: number, width: number, height?: number): void {
  // RGB first (writes opaque alpha), then overlay the interpolated alpha values
  decodeBc1Rgb(block, 8, out, outOffset, width, height, false);

  // BC4-style alpha: two u8 endpoints + 16x 3-bit indices in 6 bytes
  const a0 = block[0];
  const a1 = block[1];
  const alpha = new Uint8Array(8);
  alpha[0] = a0;
  alpha[1] = a1;
  if (a0 > a1) {
    // 8 interpolated entries
    for (let i = 2; i < 8; i++) {
      alpha[i] = ((8 - i) * a0 + (i - 1) * a1) / 7 | 0;
    }
  } else {
    // 6 interpolated entries + absolute 0 and 255
    alpha[2] = (4 * a0 + 3 * a1) / 7 | 0;
    alpha[3] = (3 * a0 + 4 * a1) / 7 | 0;
    alpha[4] = (2 * a0 + 5 * a1) / 7 | 0;
    alpha[5] = (a0 + 6 * a1) / 7 | 0;
    alpha[6] = 0;
    alpha[7] = 255;
  }

  forEachBlockPixel(out, outOffset, width, height, (row, col, po) => {
    const i = row * 4 + col;
    out[po + 3] = alpha[readBits(block, 2, i * 3, 3)];
  });
}
