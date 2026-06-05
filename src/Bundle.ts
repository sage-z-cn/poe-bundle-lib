import fs from 'node:fs';
import path from 'node:path';
import { Compress, Decompress, Initialize, GetCompressedBufferSize, Compressor, CompressionLevel, Settings } from './Oodle.js';
import type { BundleRecord } from './records/BundleRecord.js';

/**
 * Bundle header structure (60 bytes).
 */
interface BundleHeader {
  uncompressedSize: number;
  compressedSize: number;
  headSize: number;
  compressor: Compressor;
  unknown: number;
  uncompressedSizeLong: bigint;
  compressedSizeLong: bigint;
  chunkCount: number;
  chunkSize: number;
  unknown3: number;
  unknown4: number;
  unknown5: number;
  unknown6: number;
}

/**
 * Class to handle the *.bundle.bin file.
 * Bundle binary layout:
 *   Header (60 bytes)
 *   compressed_chunk_sizes (chunk_count * 4 bytes)
 *   compressed data
 */
const HEADER_SIZE = 60;

export class Bundle {
  Record: BundleRecord | null;

  get UncompressedSize(): number { return this.privateHeader.uncompressedSize; }
  set UncompressedSize(val: number) { this.privateHeader.uncompressedSize = val; }
  get CompressedSize(): number { return this.privateHeader.compressedSize; }

  private fileBuffer: Buffer;
  private isMemory: boolean;
  private privateHeader: BundleHeader;
  private compressedChunkSizes: Int32Array;
  private cachedContent: Buffer | null;
  private cacheTable: boolean[] | null;

  get _header(): BundleHeader { return this.privateHeader; }
  get _compressedChunkSizes(): Int32Array { return this.compressedChunkSizes; }
  set _compressedChunkSizes(val: Int32Array) { this.compressedChunkSizes = val; }

  /**
   * @param source - File path or Buffer containing bundle data
   * @param record - Optional BundleRecord
   * @param options - Options (leaveOpen)
   */
  constructor(source: string | Buffer, record: BundleRecord | null = null, _options: { leaveOpen?: boolean } = {}) {
    this.Record = record;
    this.cachedContent = null;
    this.cacheTable = null;
    this.isMemory = Buffer.isBuffer(source);

    if (this.isMemory) {
      this.fileBuffer = source as Buffer;
    } else {
      // Read entire file into buffer for random access
      const filePath = path.resolve(source as string);
      this.fileBuffer = fs.readFileSync(filePath);
    }

    // Initialize with default values first (will be overwritten by readHeader)
    this.privateHeader = {
      uncompressedSize: 0,
      compressedSize: 0,
      headSize: 48,
      compressor: Compressor.Leviathan,
      unknown: 1,
      uncompressedSizeLong: 0n,
      compressedSizeLong: 0n,
      chunkCount: 0,
      chunkSize: 256 * 1024,
      unknown3: 0,
      unknown4: 0,
      unknown5: 0,
      unknown6: 0,
    };
    this.compressedChunkSizes = new Int32Array(0);

    this.readHeader();

    if (record) {
      record.UncompressedSize = this.privateHeader.uncompressedSize;
    }
  }

  /**
   * Create an empty bundle for writing.
   */
  static createEmpty(record: BundleRecord | null): Bundle {
    const header: BundleHeader = {
      uncompressedSize: 0,
      compressedSize: 0,
      headSize: 48,
      compressor: Compressor.Leviathan,
      unknown: 1,
      uncompressedSizeLong: 0n,
      compressedSizeLong: 0n,
      chunkCount: 0,
      chunkSize: 256 * 1024,
      unknown3: 0,
      unknown4: 0,
      unknown5: 0,
      unknown6: 0,
    };

    const bundle = Object.create(Bundle.prototype) as Bundle;
    bundle.Record = record;
    bundle.isMemory = true;
    bundle.fileBuffer = writeHeaderToBuffer(header);
    bundle.privateHeader = header;
    bundle.compressedChunkSizes = new Int32Array(0);
    bundle.cachedContent = null;
    bundle.cacheTable = null;
    return bundle;
  }

  /**
   * Read and parse the 60-byte header from the file buffer.
   */
  private readHeader(): void {
    const buf = this.fileBuffer;
    this.privateHeader = {
      uncompressedSize: buf.readInt32LE(0),
      compressedSize: buf.readInt32LE(4),
      headSize: buf.readInt32LE(8),
      compressor: buf.readInt32LE(12),
      unknown: buf.readInt32LE(16),
      uncompressedSizeLong: buf.readBigInt64LE(20),
      compressedSizeLong: buf.readBigInt64LE(28),
      chunkCount: buf.readInt32LE(36),
      chunkSize: buf.readInt32LE(40),
      unknown3: buf.readInt32LE(44),
      unknown4: buf.readInt32LE(48),
      unknown5: buf.readInt32LE(52),
      unknown6: buf.readInt32LE(56),
    };

    const chunkCount = this.privateHeader.chunkCount;
    this.compressedChunkSizes = new Int32Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      this.compressedChunkSizes[i] = buf.readInt32LE(HEADER_SIZE + i * 4);
    }
  }

  /**
   * Get the last chunk size (the remainder).
   */
  private getLastChunkSize(): number {
    const h = this.privateHeader;
    return h.uncompressedSize - (h.chunkSize * (h.chunkCount - 1));
  }

  /**
   * Read the whole data of the bundle without caching.
   */
  ReadWithoutCache(): Buffer {
    const result = Buffer.alloc(this.privateHeader.uncompressedSize);
    this.readChunks(result, 0, this.privateHeader.chunkCount);
    return result;
  }

  /**
   * Read the data with the given offset and length without caching.
   */
  ReadSliceWithoutCache(offset: number, length: number): Buffer {
    if (offset > this.privateHeader.uncompressedSize) {
      throw new RangeError(`offset ${offset} exceeds uncompressed size ${this.privateHeader.uncompressedSize}`);
    }
    if (length === 0) return Buffer.alloc(0);
    if (length > this.privateHeader.uncompressedSize - offset) {
      throw new RangeError(`length ${length} + offset ${offset} exceeds uncompressed size ${this.privateHeader.uncompressedSize}`);
    }

    const chunkSize = this.privateHeader.chunkSize;
    const startChunk = Math.floor(offset / chunkSize);
    const endChunk = Math.floor((offset + length - 1) / chunkSize) + 1;

    // Allocate enough for the chunks we need to decompress
    let totalChunkData: number;
    if (endChunk === this.privateHeader.chunkCount) {
      totalChunkData = this.privateHeader.uncompressedSize - chunkSize * startChunk;
    } else {
      totalChunkData = chunkSize * (endChunk - startChunk);
    }
    const chunkBuf = Buffer.alloc(totalChunkData);
    this.readChunks(chunkBuf, startChunk, endChunk);

    return chunkBuf.subarray(offset % chunkSize, offset % chunkSize + length);
  }

  /**
   * Read the whole data of the bundle (use cached data if exists).
   */
  Read(): Buffer {
    if (!this.cachedContent) {
      this.cachedContent = Buffer.alloc(this.privateHeader.uncompressedSize);
    }
    this.readChunks(this.cachedContent, 0, this.privateHeader.chunkCount, true);
    return this.cachedContent;
  }

  /**
   * Read data with the given offset and length (use cached data if exists).
   */
  ReadSlice(offset: number, length: number): Buffer {
    if (offset > this.privateHeader.uncompressedSize) {
      throw new RangeError(`offset ${offset} exceeds uncompressed size ${this.privateHeader.uncompressedSize}`);
    }
    if (length === 0) return Buffer.alloc(0);
    if (length > this.privateHeader.uncompressedSize - offset) {
      throw new RangeError(`length ${length} + offset ${offset} exceeds uncompressed size ${this.privateHeader.uncompressedSize}`);
    }

    const chunkSize = this.privateHeader.chunkSize;
    const startChunk = Math.floor(offset / chunkSize);
    const endChunk = Math.floor((offset + length - 1) / chunkSize) + 1;

    if (!this.cachedContent) {
      this.cachedContent = Buffer.alloc(this.privateHeader.uncompressedSize);
    }
    this.readChunks(
      this.cachedContent.subarray(startChunk * chunkSize),
      startChunk,
      endChunk,
      true,
    );
    return this.cachedContent.subarray(offset, offset + length);
  }

  /**
   * Internal: decompress chunks [start, end) into span.
   */
  private readChunks(span: Buffer, start: number, end: number, cached: boolean = false): void {
    if (start === end) return;

    const h = this.privateHeader;
    const buf = this.fileBuffer;
    const chunkSizes = this.compressedChunkSizes;

    // Initialize Oodle with this bundle's settings
    Initialize(new Settings({
      chunkSize: h.chunkSize,
      compressor: h.compressor,
      enableCompressing: false,
    }));

    // Calculate compressed data start position:
    // 3 * sizeof(int) + head_size + sum of previous compressed_chunk_sizes
    let compressedPos = 12 + h.headSize;
    for (let i = 0; i < start; i++) {
      compressedPos += chunkSizes[i];
    }

    if (cached) {
      this.cacheTable ??= new Array(h.chunkCount).fill(false) as boolean[];
    }

    const lastChunkIdx = h.chunkCount - 1;
    let writePos = 0;

    for (let i = start; i < end; i++) {
      if (cached && this.cacheTable![i]) {
        compressedPos += chunkSizes[i];
        writePos += h.chunkSize;
        continue;
      }

      const chunkCompressedSize = chunkSizes[i];
      const outputBuf = span.subarray(writePos);

      if (i === lastChunkIdx) {
        const lastSize = this.getLastChunkSize();
        const decompressed = Decompress(
          buf.subarray(compressedPos, compressedPos + chunkCompressedSize),
          outputBuf,
          lastSize,
        );
        if (decompressed !== lastSize) {
          throw new Error(`Failed to decompress last chunk with index: ${i}`);
        }
      } else {
        const decompressed = Decompress(
          buf.subarray(compressedPos, compressedPos + chunkCompressedSize),
          outputBuf,
          h.chunkSize,
        );
        if (decompressed !== h.chunkSize) {
          throw new Error(`Failed to decompress chunk with index: ${i}`);
        }
      }

      if (cached) {
        this.cacheTable![i] = true;
      }

      compressedPos += chunkCompressedSize;
      writePos += h.chunkSize;
    }
  }

  /**
   * Remove all cached data.
   */
  RemoveCache(): void {
    this.cachedContent = null;
    this.cacheTable = null;
  }

  /**
   * Save the bundle with new contents.
   * @param newContent - New uncompressed data
   * @param compressor - Compressor to use, Compressor.Invalid to keep current
   * @param compressionLevel - Compression level to use
   */
  Save(newContent: Buffer, compressor: Compressor = Compressor.Invalid, compressionLevel: CompressionLevel = CompressionLevel.Normal): void {
    this.RemoveCache();

    const h = this.privateHeader;
    if (compressor === Compressor.Invalid) {
      compressor = h.compressor;
    } else {
      h.compressor = compressor;
    }
    Initialize(new Settings({
      chunkSize: h.chunkSize,
      compressor,
      compressionLevel,
      enableCompressing: true,
    }));

    h.uncompressedSizeLong = BigInt(newContent.length);
    h.uncompressedSize = newContent.length;
    h.chunkCount = Math.floor(newContent.length / h.chunkSize);
    if (newContent.length > h.chunkCount * h.chunkSize) {
      h.chunkCount++;
    }
    h.headSize = h.chunkCount * 4 + 48;

    const newChunkSizes = new Int32Array(h.chunkCount);
    const compressedChunks: Buffer[] = [];
    h.compressedSize = 0;

    if (h.chunkCount !== 0) {
      const lastIdx = h.chunkCount - 1;
      let readPos = 0;
      for (let i = 0; i < lastIdx; i++) {
        const inputSlice = newContent.subarray(readPos, readPos + h.chunkSize);
        const { compressedSize, output } = Compress(inputSlice);
        newChunkSizes[i] = compressedSize;
        compressedChunks.push(output.subarray(0, compressedSize));
        h.compressedSize += compressedSize;
        readPos += h.chunkSize;
      }

      // Last chunk
      const lastSize = this.getLastChunkSize();
      const lastInput = newContent.subarray(readPos, readPos + lastSize);
      const { compressedSize: lastCompressedSize, output: lastOutput } = Compress(lastInput);
      newChunkSizes[lastIdx] = lastCompressedSize;
      compressedChunks.push(lastOutput.subarray(0, lastCompressedSize));
      h.compressedSize += lastCompressedSize;
    }

    h.compressedSizeLong = BigInt(h.compressedSize);

    // Build the new file buffer
    const totalSize = 12 + h.headSize + h.compressedSize;
    const result = Buffer.alloc(totalSize);

    // Write header
    writeHeaderToBuffer(h, result);

    // Write compressed chunk sizes (after the first 60 bytes)
    const chunkSizesOffset = HEADER_SIZE;
    for (let i = 0; i < h.chunkCount; i++) {
      result.writeInt32LE(newChunkSizes[i], chunkSizesOffset + i * 4);
    }

    // Write compressed data
    let writeOffset = 12 + h.headSize;
    for (const chunk of compressedChunks) {
      chunk.copy(result, writeOffset);
      writeOffset += chunk.length;
    }

    this.fileBuffer = result;
    this.compressedChunkSizes = newChunkSizes;
    this.privateHeader = h;

    if (this.Record) {
      this.Record.UncompressedSize = h.uncompressedSize;
    }
  }

  /**
   * Get the underlying file buffer (for saving to disk).
   */
  getFileBuffer(): Buffer {
    return this.fileBuffer;
  }

  /**
   * Dispose - clear caches.
   */
  Dispose(): void {
    this.RemoveCache();
  }
}

/**
 * Write header struct to buffer at offset 0.
 */
function writeHeaderToBuffer(h: BundleHeader, buf?: Buffer): Buffer {
  const b = buf ?? Buffer.alloc(HEADER_SIZE);
  b.writeInt32LE(h.uncompressedSize, 0);
  b.writeInt32LE(h.compressedSize, 4);
  b.writeInt32LE(h.headSize, 8);
  b.writeInt32LE(h.compressor, 12);
  b.writeInt32LE(h.unknown, 16);
  b.writeBigInt64LE(BigInt(h.uncompressedSizeLong ?? 0n), 20);
  b.writeBigInt64LE(BigInt(h.compressedSizeLong ?? 0n), 28);
  b.writeInt32LE(h.chunkCount, 36);
  b.writeInt32LE(h.chunkSize, 40);
  b.writeInt32LE(h.unknown3 ?? 0, 44);
  b.writeInt32LE(h.unknown4 ?? 0, 48);
  b.writeInt32LE(h.unknown5 ?? 0, 52);
  b.writeInt32LE(h.unknown6 ?? 0, 56);
  return b;
}
