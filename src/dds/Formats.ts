/**
 * Texture formats used by DDS files and their metadata.
 */

/**
 * Block-compressed or uncompressed formats that can be described by a DDS header.
 */
export enum DdsFormat {
  /** 4x4 blocks, 8 bytes per block, optional 1-bit punchthrough alpha (a.k.a. DXT1) */
  BC1,
  /** 4x4 blocks, 16 bytes per block: 8 bytes explicit alpha + BC1-style RGB (a.k.a. DXT3) */
  BC2,
  /** 4x4 blocks, 16 bytes per block: 8 bytes BC4-style alpha + BC1-style RGB (a.k.a. DXT5) */
  BC3,
  /** 4x4 blocks, 8 bytes per block, single red channel */
  BC4,
  /** 4x4 blocks, 16 bytes per block, red + green channels */
  BC5,
  /** 4x4 blocks, 16 bytes per block, HDR RGB (float) */
  BC6H,
  /** 4x4 blocks, 16 bytes per block, high quality RGBA */
  BC7,
  /** Plain 8-bit RGBA, 4 bytes per pixel */
  RGBA8_Uncompressed,
  /** Unknown or unsupported format */
  Unsupported,
}

/**
 * Metadata of a {@link DdsFormat}.
 */
export interface DdsFormatInfo {
  /**
   * Whether the format stores 4x4 compressed blocks instead of plain pixels.
   */
  readonly isBlockCompressed: boolean;
  /**
   * Compressed size of a single 4x4 block in bytes (0 for uncompressed formats).
   */
  readonly bytesPerBlock: number;
  /**
   * Human readable display name of the base variant.
   */
  readonly name: string;
  /**
   * Whether DdsImage.decodeMip can decode this format into an RgbaSurface.
   */
  readonly decodable: boolean;
}

/**
 * Format metadata table.
 */
export const FORMAT_INFO: Readonly<Record<DdsFormat, DdsFormatInfo>> = {
  [DdsFormat.BC1]: { isBlockCompressed: true, bytesPerBlock: 8, name: 'DXT1 (BC1)', decodable: true },
  [DdsFormat.BC2]: { isBlockCompressed: true, bytesPerBlock: 16, name: 'DXT3 (BC2)', decodable: true },
  [DdsFormat.BC3]: { isBlockCompressed: true, bytesPerBlock: 16, name: 'DXT5 (BC3)', decodable: true },
  [DdsFormat.BC4]: { isBlockCompressed: true, bytesPerBlock: 8, name: 'BC4_UNORM', decodable: false },
  [DdsFormat.BC5]: { isBlockCompressed: true, bytesPerBlock: 16, name: 'BC5_UNORM', decodable: false },
  [DdsFormat.BC6H]: { isBlockCompressed: true, bytesPerBlock: 16, name: 'BC6H_UF16', decodable: false },
  [DdsFormat.BC7]: { isBlockCompressed: true, bytesPerBlock: 16, name: 'BC7_UNORM', decodable: false },
  [DdsFormat.RGBA8_Uncompressed]: { isBlockCompressed: false, bytesPerBlock: 0, name: 'R8G8B8A8_UNORM', decodable: true },
  [DdsFormat.Unsupported]: { isBlockCompressed: false, bytesPerBlock: 0, name: 'Unsupported', decodable: false },
};

/**
 * DXGI format code lookup for DX10 extension headers.
 */
const DXGI_LOOKUP: ReadonlyMap<number, { format: DdsFormat; name: string; srgb: boolean }> = new Map([
  [71, { format: DdsFormat.BC1, name: 'BC1_UNORM', srgb: false }],
  [72, { format: DdsFormat.BC1, name: 'BC1_UNORM_SRGB', srgb: true }],
  [74, { format: DdsFormat.BC2, name: 'BC2_UNORM', srgb: false }],
  [75, { format: DdsFormat.BC2, name: 'BC2_UNORM_SRGB', srgb: true }],
  [77, { format: DdsFormat.BC3, name: 'BC3_UNORM', srgb: false }],
  [78, { format: DdsFormat.BC3, name: 'BC3_UNORM_SRGB', srgb: true }],
  [80, { format: DdsFormat.BC4, name: 'BC4_UNORM', srgb: false }],
  [81, { format: DdsFormat.BC4, name: 'BC4_SNORM', srgb: false }],
  [83, { format: DdsFormat.BC5, name: 'BC5_UNORM', srgb: false }],
  [84, { format: DdsFormat.BC5, name: 'BC5_SNORM', srgb: false }],
  [95, { format: DdsFormat.BC6H, name: 'BC6H_UF16', srgb: false }],
  [96, { format: DdsFormat.BC6H, name: 'BC6H_SF16', srgb: false }],
  [98, { format: DdsFormat.BC7, name: 'BC7_UNORM', srgb: false }],
  [99, { format: DdsFormat.BC7, name: 'BC7_UNORM_SRGB', srgb: true }],
  [28, { format: DdsFormat.RGBA8_Uncompressed, name: 'R8G8B8A8_UNORM', srgb: false }],
  [29, { format: DdsFormat.RGBA8_Uncompressed, name: 'R8G8B8A8_UNORM_SRGB', srgb: true }],
]);

/**
 * fourCC lookup for legacy (non-DX10) DDS pixel formats.
 */
const FOURCC_LOOKUP: ReadonlyMap<string, DdsFormat> = new Map([
  ['DXT1', DdsFormat.BC1],
  ['DXT2', DdsFormat.BC2],
  ['DXT3', DdsFormat.BC2],
  ['DXT4', DdsFormat.BC3],
  ['DXT5', DdsFormat.BC3],
]);

/**
 * Map a fourCC string (e.g. 'DXT1') to a format, or null if unknown.
 */
export function formatFromFourCC(fourCC: string): DdsFormat | null {
  return FOURCC_LOOKUP.get(fourCC) ?? null;
}

/**
 * Map a DXGI format code (from a DX10 extension header) to a format, or null if unknown.
 */
export function formatFromDxgi(dxgiFormat: number): DdsFormat | null {
  return DXGI_LOOKUP.get(dxgiFormat)?.format ?? null;
}

/**
 * Human readable name of a DXGI format code (e.g. 'BC3_UNORM_SRGB'),
 * falling back to a generic label for unknown codes.
 */
export function dxgiFormatName(dxgiFormat: number): string {
  return DXGI_LOOKUP.get(dxgiFormat)?.name ?? `DXGI_FORMAT_${dxgiFormat}`;
}

/**
 * Whether a DXGI format code is an sRGB variant.
 */
export function dxgiIsSrgb(dxgiFormat: number): boolean {
  return DXGI_LOOKUP.get(dxgiFormat)?.srgb ?? false;
}
