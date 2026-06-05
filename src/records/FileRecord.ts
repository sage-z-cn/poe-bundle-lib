import type { Index } from '../Index.js';
import type { Bundle } from '../Bundle.js';
import type { BundleRecord } from './BundleRecord.js';

/**
 * Memory stream-like container for bundle write operations.
 */
interface MemoryStream {
  buffer: Buffer;
  length: number;
}

/**
 * FileRecord - represents a file entry in the index.
 */
export class FileRecord {
  PathHash: bigint;
  BundleRecord: BundleRecord;
  Offset: number;
  Size: number;

  /**
   * Full path of the file (set by Index.ParsePaths)
   */
  Path: string | null;

  static RecordLength: number = 20; // 8 + 4*3

  constructor(pathHash: bigint, bundleRecord: BundleRecord, offset: number, size: number) {
    this.PathHash = pathHash;
    this.BundleRecord = bundleRecord;
    this.Offset = offset;
    this.Size = size;
    this.Path = null;
  }

  /**
   * Read the content of the file.
   * @param bundle - Optional bundle to read from
   */
  Read(bundle?: Bundle): Buffer {
    if (bundle) {
      return bundle.ReadSlice(this.Offset, this.Size);
    }

    // Try the bundle being written
    const btw = this.BundleRecord.Index._BundleToWrite;
    if (btw && btw.Record === this.BundleRecord) {
      return btw.ReadSliceWithoutCache(this.Offset, this.Size);
    }

    const { bundle: b, exception, success } = this.BundleRecord.TryGetBundle();
    if (success && b) {
      try {
        return b.ReadSliceWithoutCache(this.Offset, this.Size);
      } finally {
        b.Dispose();
      }
    }
    if (exception) throw exception;
    throw new Error('Failed to get bundle: ' + this.BundleRecord.Path);
  }

  /**
   * Replace the content of the file.
   */
  Write(newContent: Buffer, saveIndex: boolean = false): void {
    const index = this.BundleRecord.Index;
    let b = index._BundleToWrite;
    let ms = index._BundleStreamToWrite;

    if (!b) {
      const { bundle, originalSize } = index.GetBundleToWrite();
      b = bundle;
      index._BundleToWrite = b;
      const msBuffer = Buffer.concat([b.ReadSliceWithoutCache(0, originalSize), Buffer.alloc(0)]);
      // Store as { buffer, length } since we don't have MemoryStream
      index._BundleStreamToWrite = { buffer: msBuffer, length: originalSize } as MemoryStream;
      ms = index._BundleStreamToWrite;
    }

    this.Redirect(b.Record!, ms!.length, newContent.length);

    // Append new content to the memory stream buffer (with exponential growth)
    const needed = ms!.length + newContent.length;
    if (needed > ms!.buffer.length) {
      const newCapacity = Math.max(needed, ms!.buffer.length * 2);
      const newBuf = Buffer.alloc(newCapacity);
      ms!.buffer.copy(newBuf, 0, 0, ms!.length);
      ms!.buffer = newBuf;
    }
    newContent.copy(ms!.buffer, ms!.length);
    ms!.length += newContent.length;

    if (ms!.length >= index.MaxBundleSize) {
      b.Save(ms!.buffer.subarray(0, ms!.length));
      b.Dispose();
      index._BundleToWrite = null;
      index._BundleStreamToWrite = null;
    }

    if (saveIndex) {
      index.Save();
    }
  }

  /**
   * Redirect the FileRecord to another section in specified bundle.
   * Must call Index.Save() to save changes after editing.
   */
  Redirect(bundle: BundleRecord, offset: number, size: number): void {
    if (this.BundleRecord !== bundle) {
      if (bundle.Index !== this.BundleRecord.Index) {
        throw new Error('Attempt to redirect the file to a bundle in another index');
      }
      const idx = this.BundleRecord._Files.indexOf(this);
      if (idx !== -1) this.BundleRecord._Files.splice(idx, 1);
      this.BundleRecord = bundle;
      bundle._Files.push(this);
    }
    this.Offset = offset;
    this.Size = size;
  }

  /**
   * Serialize this record to a buffer.
   */
  Serialize(): Buffer {
    const result = Buffer.alloc(FileRecord.RecordLength);
    result.writeBigUInt64LE(this.PathHash, 0);
    result.writeInt32LE(this.BundleRecord.BundleIndex, 8);
    result.writeInt32LE(this.Offset, 12);
    result.writeInt32LE(this.Size, 16);
    return result;
  }
}
