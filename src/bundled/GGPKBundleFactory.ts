import type { IBundleFactory } from '../IBundleFactory.js';
import type { GGPK } from '../ggpk/GGPK.js';
import type { DirectoryRecord } from '../ggpk/records/DirectoryRecord.js';
import type { FileRecord } from '../ggpk/records/FileRecord.js';
import { Bundle } from '../Bundle.js';
import type { BundleRecord } from '../records/BundleRecord.js';

/**
 * Factory that provides access to bundle files stored inside a GGPK archive.
 *
 * Used by {@link BundledGGPK} to read/write bundle data directly from the
 * GGPK's internal `Bundles2/` directory, avoiding the need for separate
 * `.bundle.bin` files on disk.
 */
export class GGPKBundleFactory implements IBundleFactory {
  /** GGPK archive containing the bundle files. */
  readonly ggpk: GGPK;

  /** The "Bundles2" directory record within the GGPK archive. */
  readonly bundles2: DirectoryRecord;

  /**
   * @param ggpk - Open GGPK archive
   * @param bundles2 - The `Bundles2` directory record inside the GGPK
   */
  constructor(ggpk: GGPK, bundles2: DirectoryRecord) {
    this.ggpk = ggpk;
    this.bundles2 = bundles2;
  }

  /**
   * Retrieve a bundle stored inside the GGPK archive.
   *
   * Looks up the bundle file by name in the `Bundles2` directory,
   * reads its content as a Buffer, and passes it to {@link Bundle}.
   *
   * @param record - BundleRecord with the relative path (e.g. `Data/0.bundle.bin`)
   */
  GetBundle(record: BundleRecord): Bundle {
    // tryFindNode 支持嵌套路径（如 "Data/0.bundle.bin"）且触发懒加载
    const node = this.bundles2.tryFindNode(record.Path);
    const file = node as FileRecord | null;
    if (!file || !('dataLength' in file)) {
      throw new Error(`Cannot find bundle file "${record.Path}" in the ggpk`);
    }
    const data = file.read();
    return new Bundle(data, record);
  }

  /**
   * Create a new bundle file entry inside the GGPK archive.
   *
   * Adds a {@link FileRecord} under `Bundles2/` for the given path.
   * The returned Buffer is empty — the caller is responsible for writing
   * the actual bundle data through {@link Index} / {@link Bundle}.
   *
   * @param bundlePath - Relative path ending with `.bundle.bin`
   * @returns Empty Buffer (caller handles the write)
   */
  CreateBundle(bundlePath: string): Buffer {
    this.bundles2.findOrAddFile(bundlePath);
    return Buffer.alloc(0);
  }

  /**
   * Remove a bundle file entry from the GGPK archive.
   *
   * Cleans up the parent directory if it becomes empty after removal.
   *
   * @param bundlePath - Relative path ending with `.bundle.bin`
   * @returns `true` if the file was found and removed, `false` otherwise
   */
  /**
   * Write the complete bundle file buffer to the GGPK FileRecord.
   * Used by {@link Index.Save} to persist custom bundle data.
   *
   * @param bundlePath - Relative path (e.g. "LibGGPK3/0.bundle.bin")
   * @param data - Complete bundle file buffer (header + compressed data)
   */
  WriteBundleData(bundlePath: string, data: Buffer): void {
    const { record: file } = this.bundles2.findOrAddFile(bundlePath, data.length);
    file.write(data);
  }

  DeleteBundle(bundlePath: string): boolean {
    const node = this.bundles2.tryFindNode(bundlePath);
    const file = node as FileRecord | null;
    if (!file || !('dataLength' in file)) return false;
    file.remove();

    // Clean up empty parent directory
    const parent = file.parent;
    if (parent && parent.children.every(c => c === null || c === undefined)) {
      parent.remove();
    }
    return true;
  }
}
