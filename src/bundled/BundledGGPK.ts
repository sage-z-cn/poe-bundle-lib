import { GGPK } from '../ggpk/GGPK.js';
import { Index } from '../Index.js';
import { GGPKBundleFactory } from './GGPKBundleFactory.js';
import type { DirectoryRecord } from '../ggpk/records/DirectoryRecord.js';
import type { FileRecord } from '../ggpk/records/FileRecord.js';
import type { TreeNode } from '../ggpk/records/TreeNode.js';

/**
 * Additional options for opening a {@link BundledGGPK}.
 */
export interface BundledGGPKOptions {
  /**
   * Path prefix (ending with `/`) identifying custom bundles stored inside the
   * GGPK (e.g. `TinyBundle/` for EasyFarm-style patches). Forwarded to the
   * internal {@link Index} so existing custom bundles under that prefix are
   * recognized and reused for new writes. Defaults to `LibGGPK3/`.
   */
  customBundleBasePath?: string;
}

/**
 * Unified handler for a Content.ggpk file that contains both regular GGPK
 * records and a bundled file index (Bundles2/_.index.bin).
 *
 * Extends {@link GGPK} to automatically discover and parse the bundle index
 * during construction, providing seamless access to files stored inside
 * `.bundle.bin` archives via the {@link Index} property.
 *
 * @example
 * ```ts
 * const ggpk = new BundledGGPK('Content.ggpk');
 * const file = ggpk.Index.TryGetFile('Metadata/StatDescriptions.dat');
 * if (file) {
 *   const data = file.Read();
 * }
 * ggpk.Dispose();
 * ```
 */
export class BundledGGPK extends GGPK {
  /** The parsed bundle index (_.index.bin). */
  readonly Index: Index;

  /** Reference to the _.index.bin FileRecord in GGPK for writing back changes. */
  private _indexFile: FileRecord;

  /**
   * Open a Content.ggpk file and automatically initialize the bundle index.
   *
   * @param filePath - Path to the Content.ggpk file
   * @param parsePathsInIndex - Whether to parse file paths from the index
   *   immediately. Set to `false` for faster startup — you can call
    *   {@link Index.ParsePaths} later when paths are needed.
    * @param options - Additional options forwarded to the internal {@link Index}.
    */
  constructor(filePath: string, parsePathsInIndex: boolean = true, options: BundledGGPKOptions = {}) {
    super(filePath);
    try {
      const result = this.initIndex(parsePathsInIndex, options);
      this.Index = result.index;
      this._indexFile = result.indexFile;
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  /**
   * Locate `Bundles2/_.index.bin` inside the GGPK and create the {@link Index}.
   */
  private initIndex(parsePathsInIndex: boolean, options: BundledGGPKOptions): { index: Index; indexFile: FileRecord } {
    const bundles2 = this.root.findByName('Bundles2') as DirectoryRecord | null;
    if (!bundles2) {
      throw new Error('Cannot find directory "Bundles2" in the ggpk');
    }

    const indexFile = bundles2.findByName('_.index.bin') as FileRecord | null;
    if (!indexFile) {
      throw new Error('Cannot find file "Bundles2/_.index.bin" in the ggpk');
    }

    const data = indexFile.read();
    return {
      index: new Index(data, {
        parsePaths: parsePathsInIndex,
        bundleFactory: new GGPKBundleFactory(this, bundles2),
        customBundleBasePath: options.customBundleBasePath,
      }),
      indexFile,
    };
  }

  /**
   * Save index modifications back to the GGPK's _.index.bin FileRecord.
   * Must be called after {@link Index.Save}.
   *
   * Skipped when the index was never modified ({@link Index.Dirty}), so
   * read-only sessions do not rewrite the (possibly very large) index.
   */
  saveIndex(): void {
    if (!this.Index || !this.Index.Dirty) return;
    // Index 的 baseBundle.getFileBuffer() 包含完整压缩后的 index 数据
    const buf = (this.Index as any).baseBundle?.getFileBuffer() as Buffer | undefined;
    if (buf) {
      this._indexFile.write(buf);
      this.Index.MarkClean();
    }
  }

  /**
   * Dispose the index and the underlying GGPK.
   * Automatically writes the index back to the GGPK before closing,
   * but only if the index was modified.
   */
  Dispose(): void {
    this.saveIndex();
    this.Index?.Dispose();
    super.dispose();
  }
}
