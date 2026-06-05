import type { BundleRecord } from './records/BundleRecord.js';
import type { Bundle } from './Bundle.js';

/**
 * Interface for bundle factory.
 */
export interface IBundleFactory {
  /**
   * Create a Bundle instance of the given record.
   */
  GetBundle(record: BundleRecord): Bundle;

  /**
   * Create a new bundle stream/buffer for writing.
   * @param bundlePath - Relative path ending with ".bundle.bin"
   */
  CreateBundle(bundlePath: string): Buffer;

  /**
   * Remove a bundle file.
   * @param bundlePath - Relative path ending with ".bundle.bin"
   * @returns true if removed, false if not found
   */
  DeleteBundle(bundlePath: string): boolean;
}
