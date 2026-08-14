import { DdsFormat, FORMAT_INFO, formatFromFourCC, formatFromDxgi, dxgiFormatName, dxgiIsSrgb } from './Formats.js';
import { decodeBlockBc1, decodeBlockBc2, decodeBlockBc3 } from './BcCodec.js';
import { RgbaSurface, downsample2x2 } from './RgbaSurface.js';

/** 'DDS ' magic number (little-endian u32) */
const DDS_MAGIC = 0x20534444;
/** Size of the DDS header following the magic (must be 124) */
const DDS_HEADER_SIZE = 124;
/** Offset of the first mip's data (magic + header), or +20 more for DX10 headers */
const DDS_DATA_OFFSET = 4 + DDS_HEADER_SIZE;
/** DDPF_FOURCC pixel format flag */
const DDPF_FOURCC = 0x4;
/** DDSCAPS2_CUBEMAP */
const DDSCAPS2_CUBEMAP = 0x200;
/** DDSCAPS2_VOLUME (3D texture) */
const DDSCAPS2_VOLUME = 0x200000;
/** D3D10_RESOURCE_DIMENSION_TEXTURE2D */
const D3D10_RESOURCE_DIMENSION_TEXTURE2D = 3;
/** D3D11_RESOURCE_MISC_TEXTURECUBE */
const D3D11_RESOURCE_MISC_TEXTURECUBE = 0x4;

/**
 * DdsImage - represents a parsed DDS texture container.
 *
 * Supports plain 2D textures: BC1-BC7 block compression via legacy fourCC or
 * DX10 DXGI headers, plus uncompressed 32-bit RGB(A). Decoding to RGBA is
 * implemented for BC1/BC2/BC3/RGBA8; other formats can still be inspected.
 * Cubemaps, 3D textures and texture arrays are rejected.
 */
export class DdsImage {
  readonly width: number;
  readonly height: number;
  /**
   * Number of mip levels (header value, 0 treated as 1).
   */
  readonly mipCount: number;
  readonly format: DdsFormat;
  /**
   * Human readable format name (e.g. 'DXT1', 'BC3_UNORM_SRGB').
   */
  readonly formatName: string;
  /**
   * Whether the format is an sRGB variant.
   */
  readonly srgb: boolean;
  readonly isBlockCompressed: boolean;

  private readonly _buffer: Buffer;
  private readonly _dataOffset: number;
  private readonly _mipOffsets: number[] = [];
  private readonly _mipSizes: number[] = [];
  private readonly _masks: { r: number; g: number; b: number; a: number };

  private constructor(
    buffer: Buffer,
    width: number,
    height: number,
    mipCount: number,
    format: DdsFormat,
    formatName: string,
    srgb: boolean,
    dataOffset: number,
    masks: { r: number; g: number; b: number; a: number },
  ) {
    this._buffer = buffer;
    this._dataOffset = dataOffset;
    this._masks = masks;
    this.width = width;
    this.height = height;
    this.mipCount = mipCount;
    this.format = format;
    this.formatName = formatName;
    this.srgb = srgb;
    this.isBlockCompressed = FORMAT_INFO[format].isBlockCompressed;
    this.computeMipLayout();
  }

  /**
   * Parse a DDS file from its raw content.
   * @param buffer - Content of a *.dds file
   */
  static parse(buffer: Buffer): DdsImage {
    if (buffer.length < DDS_DATA_OFFSET || buffer.readUInt32LE(0) !== DDS_MAGIC) {
      throw new Error('Not a DDS file: invalid magic');
    }
    if (buffer.readUInt32LE(4) !== DDS_HEADER_SIZE) {
      throw new Error(`Unsupported DDS header size: ${buffer.readUInt32LE(4)}`);
    }

    const height = buffer.readUInt32LE(0x0c);
    const width = buffer.readUInt32LE(0x10);
    const depth = buffer.readUInt32LE(0x18);
    const mipCount = Math.max(1, buffer.readUInt32LE(0x1c));
    const caps2 = buffer.readUInt32LE(0x70);

    if (depth > 1 || (caps2 & DDSCAPS2_VOLUME) !== 0) {
      throw new Error('3D (volume) textures are not supported');
    }
    if ((caps2 & DDSCAPS2_CUBEMAP) !== 0) {
      throw new Error('Cubemaps are not supported');
    }

    const pfFlags = buffer.readUInt32LE(0x50);
    const fourCC = buffer.toString('latin1', 0x54, 0x58);
    const masks = {
      r: buffer.readUInt32LE(0x5c),
      g: buffer.readUInt32LE(0x60),
      b: buffer.readUInt32LE(0x64),
      a: buffer.readUInt32LE(0x68),
    };

    let format: DdsFormat;
    let formatName: string;
    let srgb = false;
    let dataOffset = DDS_DATA_OFFSET;

    if ((pfFlags & DDPF_FOURCC) !== 0 && fourCC === 'DX10') {
      // DX10 extension header: dxgiFormat, resourceDimension, miscFlag, arraySize, miscFlags2
      if (buffer.length < DDS_DATA_OFFSET + 20) {
        throw new Error('Truncated DX10 extension header');
      }
      const dxgiFormat = buffer.readUInt32LE(DDS_DATA_OFFSET);
      const resourceDimension = buffer.readUInt32LE(DDS_DATA_OFFSET + 4);
      const miscFlag = buffer.readUInt32LE(DDS_DATA_OFFSET + 8);
      const arraySize = buffer.readUInt32LE(DDS_DATA_OFFSET + 12);

      if (resourceDimension !== D3D10_RESOURCE_DIMENSION_TEXTURE2D) {
        throw new Error(`Unsupported DX10 resource dimension: ${resourceDimension} (only TEXTURE2D is supported)`);
      }
      if (arraySize > 1) {
        throw new Error(`Texture arrays are not supported (arraySize: ${arraySize})`);
      }
      if ((miscFlag & D3D11_RESOURCE_MISC_TEXTURECUBE) !== 0) {
        throw new Error('Cubemaps are not supported');
      }

      format = formatFromDxgi(dxgiFormat) ?? DdsFormat.Unsupported;
      formatName = dxgiFormatName(dxgiFormat);
      srgb = dxgiIsSrgb(dxgiFormat);
      dataOffset += 20;
      // The legacy pixel-format masks are meaningless for DX10 files. Per the
      // DXGI spec the channel-name order of R8G8B8A8 is the memory byte order
      // (byte 0 = R, byte 3 = A); the B,G,R,A byte order belongs to the legacy
      // D3DFMT DWORD layout only.
      if (format === DdsFormat.RGBA8_Uncompressed) {
        masks.r = 0x000000ff;
        masks.g = 0x0000ff00;
        masks.b = 0x00ff0000;
        masks.a = 0xff000000;
      }
    } else if ((pfFlags & DDPF_FOURCC) !== 0) {
      // Legacy fourCC pixel format
      format = formatFromFourCC(fourCC) ?? DdsFormat.Unsupported;
      formatName = fourCC;
    } else {
      // Uncompressed pixel format described by bit masks
      const rgbBitCount = buffer.readUInt32LE(0x58);
      if (rgbBitCount === 32 && masks.r === 0x00ff0000 && masks.g === 0x0000ff00 && masks.b === 0x000000ff && (masks.a === 0xff000000 || masks.a === 0)) {
        format = DdsFormat.RGBA8_Uncompressed;
        formatName = masks.a === 0 ? 'R8G8B8X8_UNORM' : 'R8G8B8A8_UNORM';
      } else {
        format = DdsFormat.Unsupported;
        formatName = `Unsupported (${rgbBitCount}bpp, R:0x${masks.r.toString(16)}, G:0x${masks.g.toString(16)}, B:0x${masks.b.toString(16)}, A:0x${masks.a.toString(16)})`;
      }
    }

    return new DdsImage(buffer, width, height, mipCount, format, formatName, srgb, dataOffset, masks);
  }

  /**
   * Compute the byte offset and size of every mip level.
   * Skipped for unsupported formats whose layout is unknown.
   */
  private computeMipLayout(): void {
    const info = FORMAT_INFO[this.format];
    if (this.format === DdsFormat.Unsupported) return;

    let offset = this._dataOffset;
    for (let mip = 0; mip < this.mipCount; mip++) {
      const w = Math.max(1, this.width >> mip);
      const h = Math.max(1, this.height >> mip);
      const size = info.isBlockCompressed
        ? Math.ceil(w / 4) * Math.ceil(h / 4) * info.bytesPerBlock
        : w * h * 4;
      this._mipOffsets.push(offset);
      this._mipSizes.push(size);
      offset += size;
    }
  }

  /**
   * Decode a mip level into an RGBA8888 surface.
   * @param mip - Zero-based mip level index
   */
  decodeMip(mip: number = 0): RgbaSurface {
    const info = FORMAT_INFO[this.format];
    if (!info.decodable) {
      throw new Error(`Cannot decode DDS format: ${this.formatName}`);
    }
    if (mip < 0 || mip >= this._mipOffsets.length) {
      throw new RangeError(`Mip level out of range: ${mip} (available: 0..${this._mipOffsets.length - 1})`);
    }

    const w = Math.max(1, this.width >> mip);
    const h = Math.max(1, this.height >> mip);
    const start = this._mipOffsets[mip];
    const end = start + this._mipSizes[mip];
    if (end > this._buffer.length) {
      throw new Error(`Truncated DDS data: mip ${mip} needs bytes ${start}..${end} but file has ${this._buffer.length}`);
    }
    const data = this._buffer.subarray(start, end);

    if (info.isBlockCompressed) {
      const blockRows = Math.ceil(h / 4);
      const blockCols = Math.ceil(w / 4);
      const pixels = new Uint8Array(w * h * 4);
      const blockStride = info.bytesPerBlock;
      for (let by = 0; by < blockRows; by++) {
        for (let bx = 0; bx < blockCols; bx++) {
          const blockOffset = (by * blockCols + bx) * blockStride;
          // Top-left pixel of the block: (bx*4, by*4) in the mip surface
          const outOffset = ((by * 4) * w + bx * 4) * 4;
          switch (this.format) {
            case DdsFormat.BC1:
              decodeBlockBc1(data.subarray(blockOffset, blockOffset + 8), pixels, outOffset, w, h);
              break;
            case DdsFormat.BC2:
              decodeBlockBc2(data.subarray(blockOffset, blockOffset + 16), pixels, outOffset, w, h);
              break;
            case DdsFormat.BC3:
              decodeBlockBc3(data.subarray(blockOffset, blockOffset + 16), pixels, outOffset, w, h);
              break;
          }
        }
      }
      return new RgbaSurface(w, h, pixels);
    }

    // Uncompressed RGBA (channel order per the pixel-format masks: legacy
    // headers use the BGRA DWORD layout, DX10 headers the DXGI RGBA order)
    const pixels = new Uint8Array(w * h * 4);
    const aMask = this._masks.a;
    for (let p = 0; p < w * h; p++) {
      const px = data.readUInt32LE(p * 4);
      pixels[p * 4] = extractChannel(px, this._masks.r);
      pixels[p * 4 + 1] = extractChannel(px, this._masks.g);
      pixels[p * 4 + 2] = extractChannel(px, this._masks.b);
      pixels[p * 4 + 3] = aMask === 0 ? 255 : extractChannel(px, aMask);
    }
    return new RgbaSurface(w, h, pixels);
  }

  /**
   * Write RGBA pixels back into a mip level and return a new complete DDS buffer.
   * The original buffer of this DdsImage is not modified.
   *
   * Only uncompressed RGBA8 is supported (block-compressed formats cannot be
   * re-encoded yet).
   *
   * @param mip - Zero-based mip level to replace
   * @param pixels - RGBA8888 row-major pixel data, length must equal w*h*4
   * @param regenerateMips - Rebuild mips 1..n from the edited mip 0 via 2x2 box downsampling
   */
  writeMipPixels(mip: number, pixels: Uint8Array, regenerateMips: boolean): Buffer {
    if (this.format !== DdsFormat.RGBA8_Uncompressed) {
      throw new Error(`Writing mip pixels for format ${this.formatName} is not supported yet`);
    }
    if (mip < 0 || mip >= this._mipOffsets.length) {
      throw new RangeError(`Mip level out of range: ${mip} (available: 0..${this._mipOffsets.length - 1})`);
    }

    const w = Math.max(1, this.width >> mip);
    const h = Math.max(1, this.height >> mip);
    if (pixels.length !== w * h * 4) {
      throw new Error(`Pixel data size mismatch for mip ${mip}: expected ${w * h * 4} bytes (RGBA8888), got ${pixels.length}`);
    }
    const end = this._mipOffsets[mip] + this._mipSizes[mip];
    if (end > this._buffer.length) {
      throw new Error(`Truncated DDS data: mip ${mip} needs bytes ${this._mipOffsets[mip]}..${end} but file has ${this._buffer.length}`);
    }

    const out = Buffer.from(this._buffer); // copy
    writeRgbaMasked(out, this._mipOffsets[mip], pixels, this._masks);

    if (regenerateMips && mip === 0) {
      // Rebuild every subsequent mip from the edited mip 0
      let src = new RgbaSurface(w, h, pixels);
      for (let m = 1; m < this.mipCount; m++) {
        src = downsample2x2(src);
        const mw = Math.max(1, this.width >> m);
        const mh = Math.max(1, this.height >> m);
        if (src.width !== mw || src.height !== mh || this._mipSizes[m] !== mw * mh * 4) {
          throw new Error(`Mip ${m} layout mismatch: expected ${mw}x${mh}`);
        }
        writeRgbaMasked(out, this._mipOffsets[m], src.pixels, this._masks);
      }
    }

    return out;
  }

  /**
   * Human readable summary: dimensions, format, mip count and per-mip layout.
   */
  inspect(): string {
    const lines: string[] = [];
    lines.push(
      `${this.width}x${this.height} ${this.formatName}${this.srgb ? ' (sRGB)' : ''}, ${this.mipCount} mip${this.mipCount === 1 ? '' : 's'}${this.isBlockCompressed ? ', block-compressed' : ''}`,
    );
    if (this._mipOffsets.length === 0) {
      lines.push('  mip layout unknown (unsupported format)');
    } else {
      for (let mip = 0; mip < this._mipOffsets.length; mip++) {
        const w = Math.max(1, this.width >> mip);
        const h = Math.max(1, this.height >> mip);
        lines.push(`  mip ${mip}: ${w}x${h}, offset ${this._mipOffsets[mip]}, ${this._mipSizes[mip]} bytes`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * Extract an 8-bit channel value from a 32-bit pixel using a contiguous bit mask.
 */
function extractChannel(pixel: number, mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let width = 0;
  let m = mask >>> shift;
  while (m >>> width !== 0) width++;
  const raw = (pixel & mask) >>> shift;
  return width >= 8 ? raw >>> (width - 8) : (raw << (8 - width)) & 0xff;
}

/**
 * Bit position of the lowest set bit of a contiguous channel mask.
 */
function channelShift(mask: number): number {
  let shift = 0;
  while (((mask >>> shift) & 1) === 0 && shift < 32) shift++;
  return shift;
}

/**
 * Write row-major RGBA8888 pixel data into a DDS buffer at `offset`, packing
 * each channel into the bit positions described by the pixel-format masks.
 * Handles both the legacy D3DFMT DWORD layout (B,G,R,A byte order, mask
 * R=0x00ff0000) and the DXGI R8G8B8A8 order (byte 0 = R, mask R=0x000000ff).
 * A zero alpha mask (R8G8B8X8) writes 255 into the top byte, matching the
 * common writer convention for the unused channel.
 */
function writeRgbaMasked(target: Buffer, offset: number, pixels: Uint8Array, masks: { r: number; g: number; b: number; a: number }): void {
  const rs = masks.r === 0 ? -1 : channelShift(masks.r);
  const gs = masks.g === 0 ? -1 : channelShift(masks.g);
  const bs = masks.b === 0 ? -1 : channelShift(masks.b);
  const as = masks.a === 0 ? 24 : channelShift(masks.a); // absent alpha -> opaque
  const av = masks.a === 0 ? 255 : 0;

  for (let i = 0; i < pixels.length; i += 4) {
    let px = 0;
    if (rs >= 0) px |= pixels[i] << rs;
    if (gs >= 0) px |= pixels[i + 1] << gs;
    if (bs >= 0) px |= pixels[i + 2] << bs;
    px |= (pixels[i + 3] | av) << as;
    target.writeUInt32LE(px >>> 0, offset + i);
  }
}
