import type { Index } from '../Index.js';
import type { Bundle } from '../Bundle.js';
import type { FileRecord } from './FileRecord.js';

/**
 * BundleRecord - represents a bundle file entry in the index.
 */
export class BundleRecord {
  /**
   * Path without extension (as stored in index)
   */
  _Path: string;

  /**
   * Path with ".bundle.bin" extension
   */
  get Path(): string { return this._Path + '.bundle.bin'; }

  /**
   * Size of the uncompressed content in bytes
   */
  UncompressedSize: number;

  /**
   * Index of this BundleRecord in Index.Bundles
   */
  BundleIndex: number;

  /**
   * Index instance which contains this bundle
   */
  Index: Index;

  /**
   * Files contained in this bundle
   */
  _Files: FileRecord[] = [];

  constructor(path: string, uncompressedSize: number, index: Index, bundleIndex: number) {
    this._Path = path;
    this.UncompressedSize = uncompressedSize;
    this.Index = index;
    this.BundleIndex = bundleIndex;
  }

  /**
   * Try to get the bundle instance using IBundleFactory.GetBundle.
   */
  TryGetBundle(): { bundle: Bundle | null; exception: Error | null; success: boolean } {
    try {
      const bundle = this.Index.bundleFactory.GetBundle(this);
      return { bundle, exception: null, success: true };
    } catch (ex) {
      return { bundle: null, exception: ex instanceof Error ? ex : new Error(String(ex)), success: false };
    }
  }

  /**
   * Size of the content when serialized to index.
   */
  get RecordLength(): number {
    return this._Path.length + 8; // pathLength(u32) + pathUTF8 + uncompressedSize(u32)
  }

  /**
   * Serialize this record to a buffer.
   */
  Serialize(): Buffer {
    const pathBuf = Buffer.from(this._Path, 'utf8');
    const result = Buffer.alloc(4 + pathBuf.length + 4);
    result.writeUInt32LE(pathBuf.length, 0);
    pathBuf.copy(result, 4);
    result.writeUInt32LE(this.UncompressedSize, 4 + pathBuf.length);
    return result;
  }
}
