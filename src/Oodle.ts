import koffi from 'koffi';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Compressor enum
 */
export enum Compressor {
  Invalid = -1,
  None = 3,
  Kraken = 8,
  Mermaid = 9,
  Selkie = 11,
  Hydra = 12,
  Leviathan = 13,
  BitKnit = 10,
  LZB16 = 4,
  LZNA = 7,
  LZH = 0,
  LZHLW = 1,
  LZNIB = 2,
  LZBLW = 5,
  LZA = 6,
  Count = 14,
}

/**
 * CompressionLevel enum
 */
export enum CompressionLevel {
  HyperFast4 = -4,
  HyperFast3 = -3,
  HyperFast2 = -2,
  HyperFast1 = -1,
  HyperFast = -1,
  None = 0,
  SuperFast = 1,
  VeryFast = 2,
  Fast = 3,
  Normal = 4,
  Optimal1 = 5,
  Optimal2 = 6,
  Optimal = 6,
  Optimal3 = 7,
  Optimal4 = 8,
  Optimal5 = 9,
  Max = 9,
  Min = -4,
}

/**
 * Settings for Oodle compression/decompression
 */
export class Settings {
  ChunkSize: number;
  Compressor: Compressor;
  CompressionLevel: CompressionLevel;
  EnableCompressing: boolean;

  constructor({
    chunkSize = 256 * 1024,
    compressor = Compressor.Leviathan,
    compressionLevel = CompressionLevel.Normal,
    enableCompressing = true,
  }: {
    chunkSize?: number;
    compressor?: Compressor;
    compressionLevel?: CompressionLevel;
    enableCompressing?: boolean;
  } = {}) {
    this.ChunkSize = chunkSize;
    this.Compressor = compressor;
    this.CompressionLevel = compressionLevel;
    this.EnableCompressing = enableCompressing;
  }

  validate(): void {
    if (this.ChunkSize <= 0) {
      throw new RangeError('ChunkSize must be positive');
    }
    const compressorVal = this.Compressor as number;
    // Only allow None(3) through Leviathan(13), matching original validation
    if (compressorVal < Compressor.None || compressorVal > Compressor.Leviathan) {
      throw new RangeError('Invalid compressor type');
    }
    if (this.CompressionLevel > CompressionLevel.Max || this.CompressionLevel < CompressionLevel.Min) {
      throw new RangeError('CompressionLevel is not defined');
    }
  }
}

// --- FFI Library Loading ---

type KoffiCallback = (...args: unknown[]) => unknown;
let lib: koffi.IKoffiLib | null = null;

function loadLibrary(): koffi.IKoffiLib {
  if (lib) return lib;

  const dllName = 'oo2core.dll';
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // package root: one level up from src/ (dev) or dist/ (after build)
  const packageRoot = path.dirname(__dirname);

  // Search order:
  // 1. libs/ directory under package root (node_modules/poe-bundle-lib/libs/)
  // 2. libs/ directory under cwd (user's project root)
  // 3. Current working directory
  // 4. OS standard search paths (PATH, system directories)
  // 5. Node.exe directory
  const bundledDll = path.join(packageRoot, 'libs', dllName);
  if (fs.existsSync(bundledDll)) {
    lib = koffi.load(bundledDll);
    return lib;
  }

  const cwdLibsDll = path.join(process.cwd(), 'libs', dllName);
  if (fs.existsSync(cwdLibsDll)) {
    lib = koffi.load(cwdLibsDll);
    return lib;
  }

  // Try loading by name (uses OS DLL search path: PATH, system dirs, etc.)
  try {
    lib = koffi.load(dllName);
    return lib;
  } catch {
    // Fall through to explicit path search
  }

  const searchPaths = [
    process.cwd(),                // Current working directory
    path.dirname(process.execPath), // Node.exe directory
  ];

  let dllPath: string | null = null;
  for (const dir of searchPaths) {
    const candidate = path.join(dir, dllName);
    if (fs.existsSync(candidate)) {
      dllPath = candidate;
      break;
    }
  }

  if (!dllPath) {
    throw new Error(
      `Could not find ${dllName}. Searched:\n` +
      `  - ${bundledDll}\n` +
      `  - ${cwdLibsDll}\n` +
      searchPaths.map(p => `  - ${p}`).join('\n') +
      '\nPlus OS standard search paths (PATH, system directories).'
    );
  }

  lib = koffi.load(dllPath);

  return lib;
}

// --- FFI Function Definitions ---

type KoffiFunc = KoffiCallback;

const OodleLZ_Compress = (): KoffiFunc => {
  const l = loadLibrary();
  return l.func('OodleLZ_Compress', 'int64', [
    'int',    // compressor
    'void *', // buffer
    'int64',  // bufferSize
    'void *', // output
    'int',    // level
    'void *', // pOptions
    'void *', // dictionaryBase
    'void *', // longRangeMatcher
    'void *', // scratchMem
    'int64',  // scratchSize
  ]);
};

const OodleLZ_Decompress = (): KoffiFunc => {
  const l = loadLibrary();
  return l.func('OodleLZ_Decompress', 'int64', [
    'void *', // buffer
    'int64',  // bufferSize
    'void *', // output
    'int64',  // outputSize
    'int',    // fuzzSafe
    'int',    // checkCRC
    'int',    // verbosity
    'void *', // dictionaryBase
    'int64',  // dictionarySize
    'void *', // fpCallback
    'void *', // callbackUserData
    'void *', // decoderMemory
    'int64',  // decoderMemorySize
    'int',    // threadPhase
  ]);
};

const OodleLZ_GetCompressedBufferSizeNeeded = (): KoffiFunc => {
  const l = loadLibrary();
  return l.func('OodleLZ_GetCompressedBufferSizeNeeded', 'int64', [
    'int',   // compressor
    'int64', // bufferSize
  ]);
};

const OodleLZ_GetCompressScratchMemBound = (): KoffiFunc => {
  const l = loadLibrary();
  return l.func('OodleLZ_GetCompressScratchMemBound', 'int64', [
    'int',   // compressor
    'int',   // level
    'int64', // bufferSize
    'void *', // pOptions
  ]);
};

const OodleLZDecoder_MemorySizeNeeded = (): KoffiFunc => {
  const l = loadLibrary();
  return l.func('OodleLZDecoder_MemorySizeNeeded', 'int', [
    'int',   // compressor
    'int64', // outputSize
  ]);
};

// --- State ---

let currentSettings: Settings | null = null;
let preAllocatedMemory: Buffer | null = null;

// Lazy-loaded function references
let fnCompress: KoffiFunc | null = null;
let fnDecompress: KoffiFunc | null = null;
let fnGetCompressedBufferSizeNeeded: KoffiFunc | null = null;
let fnGetCompressScratchMemBound: KoffiFunc | null = null;
let fnDecoderMemorySizeNeeded: KoffiFunc | null = null;

function ensureFunctions(): void {
  if (!fnCompress) {
    fnCompress = OodleLZ_Compress();
    fnDecompress = OodleLZ_Decompress();
    fnGetCompressedBufferSizeNeeded = OodleLZ_GetCompressedBufferSizeNeeded();
    fnGetCompressScratchMemBound = OodleLZ_GetCompressScratchMemBound();
    fnDecoderMemorySizeNeeded = OodleLZDecoder_MemorySizeNeeded();
  }
}

/**
 * Call this method before first time using any other method.
 * You can re-call this method at any time to change the settings.
 */
export function Initialize(settings: Settings): void {
  settings.validate();
  ensureFunctions();

  if (currentSettings !== null && currentSettings.ChunkSize >= settings.ChunkSize) {
    if (!settings.EnableCompressing) {
      currentSettings = settings;
      return;
    }
    if (
      currentSettings?.EnableCompressing
      && currentSettings.CompressionLevel >= settings.CompressionLevel
      && currentSettings.Compressor === settings.Compressor
    ) {
      currentSettings = settings;
      return;
    }
  }

  let sizeNeeded = Number(fnDecoderMemorySizeNeeded!(Compressor.Invalid, settings.ChunkSize));
  if (settings.EnableCompressing) {
    const scratchBound = Number(fnGetCompressScratchMemBound!(settings.Compressor, settings.CompressionLevel, settings.ChunkSize, null));
    if (scratchBound < 0) {
      sizeNeeded = 6 * 1024 * 1024; // 6MB
    } else if (scratchBound > sizeNeeded) {
      sizeNeeded = scratchBound;
    }
  }
  if (!preAllocatedMemory || preAllocatedMemory.length < sizeNeeded) {
    preAllocatedMemory = Buffer.alloc(sizeNeeded);
  }
  currentSettings = settings;
}

/**
 * Get the minimum size needed for the output buffer when compressing.
 * @param uncompressedSize - Size of uncompressed data, defaults to settings.ChunkSize
 * @returns Size needed for compressed output buffer
 */
export function GetCompressedBufferSize(uncompressedSize?: number): number {
  if (!currentSettings) throw new Error('Oodle not initialized. Call Initialize() first.');
  const size = uncompressedSize ?? currentSettings.ChunkSize;
  return Number(fnGetCompressedBufferSizeNeeded!(currentSettings.Compressor, BigInt(size)));
}

/**
 * Compress data.
 * @param buffer - The uncompressed data to compress
 * @param output - Buffer to save compressed output
 * @returns Object with compressedSize and output buffer
 */
export function Compress(buffer: Buffer, output?: Buffer): { compressedSize: number; output: Buffer } {
  if (!currentSettings) throw new Error('Oodle not initialized. Call Initialize() first.');
  if (!currentSettings.EnableCompressing) {
    throw new Error('Compressing is not enabled in settings');
  }

  const neededSize = GetCompressedBufferSize(buffer.length);
  if (!output) {
    output = Buffer.alloc(neededSize);
  } else if (output.length < neededSize) {
    throw new Error(`Output buffer too small: ${output.length} < ${neededSize}`);
  }

  const compressedSize = Number(fnCompress!(
    currentSettings.Compressor,
    buffer,
    BigInt(buffer.length),
    output,
    currentSettings.CompressionLevel,
    null, // pOptions
    null, // dictionaryBase
    null, // longRangeMatcher
    preAllocatedMemory,
    BigInt(preAllocatedMemory!.length),
  ));

  return { compressedSize, output };
}

/**
 * Decompress data.
 * @param buffer - The compressed data
 * @param output - Buffer to save decompressed output
 * @param uncompressedSize - Size of original uncompressed data (defaults to output.length or settings.ChunkSize)
 * @returns Size of decompressed data
 */
export function Decompress(buffer: Buffer, output: Buffer, uncompressedSize?: number): number {
  if (!currentSettings) throw new Error('Oodle not initialized. Call Initialize() first.');

  const outputSize = uncompressedSize ?? output.length ?? currentSettings.ChunkSize;

  const result = Number(fnDecompress!(
    buffer,                       // buffer
    BigInt(buffer.length),        // bufferSize
    output,                       // output
    BigInt(outputSize),           // outputSize
    1,                            // fuzzSafe
    0,                            // checkCRC
    0,                            // verbosity
    null,                         // dictionaryBase
    BigInt(0),                    // dictionarySize
    null,                         // fpCallback
    null,                         // callbackUserData
    preAllocatedMemory,           // decoderMemory
    BigInt(preAllocatedMemory!.length), // decoderMemorySize
    3,                            // threadPhase
  ));

  return result;
}

/**
 * Release the pre-allocated memory.
 * After calling this, you must call Initialize() again if you want to use any other method.
 */
export function Release(): void {
  currentSettings = null;
  preAllocatedMemory = null;
}
