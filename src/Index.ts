import fs from 'node:fs';
import path from 'node:path';
import { Bundle } from './Bundle.js';
import { Compressor, CompressionLevel } from './Oodle.js';
import { BundleRecord } from './records/BundleRecord.js';
import { FileRecord } from './records/FileRecord.js';
import { DirectoryNode } from './nodes/DirectoryNode.js';
import { FileNode } from './nodes/FileNode.js';
import { ITreeNode } from './nodes/ITreeNode.js';
import type { IFileNode } from './nodes/IFileNode.js';
import type { IDirectoryNode } from './nodes/IDirectoryNode.js';
import { DriveBundleFactory } from './DriveBundleFactory.js';
import type { IBundleFactory } from './IBundleFactory.js';

const CUSTOM_BUNDLE_BASE_PATH = 'LibGGPK3/';

/**
 * Directory record struct (20 bytes):
 *   PathHash      (u64)
 *   Offset        (i32)
 *   Size          (i32)
 *   RecursiveSize (i32)
 */
interface DirectoryRecord {
  PathHash: bigint;
  Offset: number;
  Size: number;
  RecursiveSize: number;
}

/**
 * Memory stream-like container for bundle write operations.
 */
export interface MemoryStream {
  buffer: Buffer;
  length: number;
}

const DIRECTORY_RECORD_SIZE = 20;

export class Index {
  bundleFactory: IBundleFactory;

  private baseBundle: Bundle;

  private directoryBundleData: Buffer;

  _Bundles: BundleRecord[];

  _Directories: DirectoryRecord[];

  _Files: Map<bigint, FileRecord>;

  private customBundles: BundleRecord[] = [];

  _BundleToWrite: Bundle | null = null;

  _BundleStreamToWrite: MemoryStream | null = null;

  MaxBundleSize: number = 200 * 1024 * 1024;

  private root: DirectoryNode | null = null;

  private pathsParsed: boolean = false;

  private disposed: boolean = false;

  /**
   * Bundle records.
   */
  get Bundles(): BundleRecord[] { return this._Bundles; }

  /**
   * Files with their PathHash as key.
   */
  get Files(): Map<bigint, FileRecord> { return this._Files; }

  /**
   * Root node of the tree (lazy-initialized).
   */
  get Root(): DirectoryNode {
    if (!this.root) {
      this.root = this.BuildTree();
    }
    return this.root;
  }

  /**
   * Initialize with a _.index.bin file path or buffer.
   * @param source - File path or Buffer
   * @param options - Options for parsing
   */
  constructor(source: string | Buffer, options: { parsePaths?: boolean; bundleFactory?: IBundleFactory } = {}) {
    const { parsePaths = true, bundleFactory = null } = options;

    this.bundleFactory = bundleFactory ?? (
      typeof source === 'string'
        ? new DriveBundleFactory(path.dirname(path.resolve(source)))
        : new DriveBundleFactory('')
    );

    if (Buffer.isBuffer(source)) {
      this.baseBundle = new Bundle(source);
    } else {
      const filePath = path.resolve(source);
      this.baseBundle = new Bundle(filePath);
    }
    const data = this.baseBundle.ReadWithoutCache();

    // Initialize arrays/maps to satisfy strict mode before parsing
    this._Bundles = [];
    this._Directories = [];
    this._Files = new Map();
    this.directoryBundleData = Buffer.alloc(0);

    this._parseIndexData(data);

    if (parsePaths) {
      const failed = this.ParsePaths();
      if (failed !== 0) {
        throw new Error(`Parsing path failed for ${failed} files`);
      }
    }
  }

  /**
   * Parse the decompressed index data.
   */
  private _parseIndexData(data: Buffer): void {
    let offset = 0;

    // Bundle records
    const bundleCount = data.readUInt32LE(offset);
    offset += 4;

    this._Bundles = new Array(bundleCount);
    for (let i = 0; i < bundleCount; i++) {
      const pathLength = data.readUInt32LE(offset);
      offset += 4;
      const pathStr = data.subarray(offset, offset + pathLength).toString('utf8');
      offset += pathLength;
      const uncompressedSize = data.readUInt32LE(offset);
      offset += 4;

      this._Bundles[i] = new BundleRecord(pathStr, uncompressedSize, this, i);
      if (pathStr.startsWith(CUSTOM_BUNDLE_BASE_PATH)) {
        this.customBundles.push(this._Bundles[i]);
      }
    }

    // File records
    const fileCount = data.readUInt32LE(offset);
    offset += 4;

    this._Files = new Map();
    for (let i = 0; i < fileCount; i++) {
      const nameHash = data.readBigUInt64LE(offset);
      offset += 8;
      const bundleIndex = data.readInt32LE(offset);
      offset += 4;
      const fileOffset = data.readInt32LE(offset);
      offset += 4;
      const fileSize = data.readInt32LE(offset);
      offset += 4;

      const bundle = this._Bundles[bundleIndex];
      const f = new FileRecord(nameHash, bundle, fileOffset, fileSize);
      this._Files.set(nameHash, f);
      bundle._Files.push(f);
    }

    // Directory records
    const directoryCount = data.readUInt32LE(offset);
    offset += 4;

    this._Directories = new Array(directoryCount);
    for (let i = 0; i < directoryCount; i++) {
      this._Directories[i] = {
        PathHash: data.readBigUInt64LE(offset),
        Offset: data.readInt32LE(offset + 8),
        Size: data.readInt32LE(offset + 12),
        RecursiveSize: data.readInt32LE(offset + 16),
      };
      offset += DIRECTORY_RECORD_SIZE;
    }

    // Remaining data is the directory bundle data
    this.directoryBundleData = data.subarray(offset);
  }

  /**
   * Parse all file paths from directory records.
   * @returns Number of paths that failed to parse.
   */
  ParsePaths(): number {
    this.ensureNotDisposed();
    if (this.pathsParsed) return 0;

    const directoryBundle = new Bundle(this.directoryBundleData);
    const directory = directoryBundle.ReadWithoutCache();

    let failed = 0;
    for (const d of this._Directories) {
      const temp: Buffer[] = [];
      let isBase = false;
      const startOffset = d.Offset;
      const endOffset = d.Offset + d.Size;
      let ptr = startOffset;

      while (ptr <= endOffset - 4) {
        let index = directory.readInt32LE(ptr);
        ptr += 4;
        if (index === 0) {
          isBase = !isBase;
          if (isBase) temp.length = 0;
        } else {
          index -= 1;
          // Read null-terminated string
          let strEnd = ptr;
          while (strEnd < directory.length && directory[strEnd] !== 0) strEnd++;
          const str = directory.subarray(ptr, strEnd);
          ptr = strEnd + 1; // skip null terminator

          if (index < temp.length) {
            const combined = Buffer.concat([temp[index], str]);
            if (isBase) {
              temp.push(combined);
            } else {
              const hash = this.NameHashBytes(combined);
              const f = this._Files.get(hash);
              if (f) {
                f.Path = combined.toString('latin1');
              } else {
                failed++;
              }
            }
          } else {
            if (isBase) {
              temp.push(Buffer.from(str));
            } else {
              const hash = this.NameHashBytes(str);
              const f = this._Files.get(hash);
              if (f) {
                f.Path = str.toString('latin1');
              } else {
                failed++;
              }
            }
          }
        }
      }
    }

    this.pathsParsed = true;
    return failed;
  }

  /**
   * Save the _.index.bin file.
   * @param compressor - Compressor to use, defaults to Mermaid
   * @param compressionLevel - Compression level to use
   */
  Save(compressor: Compressor = Compressor.Mermaid, compressionLevel: CompressionLevel = CompressionLevel.Normal): void {
    if (this._BundleToWrite) {
      const ms = this._BundleStreamToWrite!;
      this._BundleToWrite.Save(ms.buffer.subarray(0, ms.length));
      // Write custom bundle data
      if (this._BundleToWrite.Record) {
        const buf = this._BundleToWrite.getFileBuffer();
        if (this.bundleFactory instanceof DriveBundleFactory) {
          const customPath = this.bundleFactory.BaseDirectory + this._BundleToWrite.Record.Path;
          fs.writeFileSync(customPath, buf);
        } else if (this.bundleFactory.WriteBundleData) {
          // GGPKBundleFactory: 写入 GGPK 内部 FileRecord
          this.bundleFactory.WriteBundleData(this._BundleToWrite.Record.Path, buf);
        }
      }
      this._BundleToWrite.Dispose();
      this._BundleToWrite = null;
      this._BundleStreamToWrite = null;
    }

    this.ensureNotDisposed();

    // Remove empty custom bundles
    const removed: BundleRecord[] = [];
    for (let i = this.customBundles.length - 1; i >= 0; i--) {
      const br = this.customBundles[i];
      if (br._Files.length === 0) {
        this.customBundles.splice(i, 1);
        this._Bundles.splice(br.BundleIndex, 1);
        this.baseBundle.UncompressedSize -= br.RecordLength;
        removed.push(br);
      }
    }

    // Re-index bundle indices after removal
    for (let i = 0; i < this._Bundles.length; i++) {
      this._Bundles[i].BundleIndex = i;
    }

    // Serialize
    const parts: Buffer[] = [];

    // Bundle count + bundle records
    const bundleCountBuf = Buffer.alloc(4);
    bundleCountBuf.writeUInt32LE(this._Bundles.length);
    parts.push(bundleCountBuf);
    for (const b of this._Bundles) {
      parts.push(b.Serialize());
    }

    // File count + file records
    const fileCountBuf = Buffer.alloc(4);
    fileCountBuf.writeUInt32LE(this._Files.size);
    parts.push(fileCountBuf);
    for (const f of this._Files.values()) {
      parts.push(f.Serialize());
    }

    // Directory count + directory records
    const dirCountBuf = Buffer.alloc(4);
    dirCountBuf.writeUInt32LE(this._Directories.length);
    parts.push(dirCountBuf);
    for (const d of this._Directories) {
      const dBuf = Buffer.alloc(DIRECTORY_RECORD_SIZE);
      dBuf.writeBigUInt64LE(d.PathHash, 0);
      dBuf.writeInt32LE(d.Offset, 8);
      dBuf.writeInt32LE(d.Size, 12);
      dBuf.writeInt32LE(d.RecursiveSize, 16);
      parts.push(dBuf);
    }

    // Directory bundle data
    parts.push(this.directoryBundleData);

    const newContent = Buffer.concat(parts);
    this.baseBundle.Save(newContent, compressor, compressionLevel);

    // Delete removed bundles
    for (const br of removed) {
      this.bundleFactory.DeleteBundle(br.Path);
    }
  }

  /**
   * Get a FileRecord from its absolute path.
   * @param pathStr - Path with forward slashes
   */
  TryGetFile(pathStr: string): FileRecord | null {
    this.ensureNotDisposed();
    return this._Files.get(this.NameHash(pathStr)) ?? null;
  }

  /**
   * Build tree with default implementation.
   */
  BuildTree(ignoreNullPath: boolean = false): DirectoryNode {
    return this.BuildTreeCustom(
      DirectoryNode.CreateInstance,
      FileNode.CreateInstance,
      ignoreNullPath,
    ) as DirectoryNode;
  }

  /**
   * Build tree with custom factory functions.
   */
  BuildTreeCustom(
    createDirectory: (name: string, parent: IDirectoryNode | null) => IDirectoryNode,
    createFile: (record: FileRecord, parent: IDirectoryNode) => IFileNode,
    ignoreNullPath: boolean = false,
  ): IDirectoryNode {
    this.ensureNotDisposed();
    if (!ignoreNullPath && !this.pathsParsed) {
      throw new Error('ParsePaths() must be called before building the tree');
    }

    const root = createDirectory('', null);

    // Sort files by path
    const sortedFiles = [...this._Files.values()].sort((a, b) => {
      const pa = a.Path ?? '';
      const pb = b.Path ?? '';
      return pa.localeCompare(pb);
    });

    for (const f of sortedFiles) {
      if (!f.Path) {
        if (!ignoreNullPath) {
          throw new Error('A file has null or empty path, the Index may be broken');
        }
        continue;
      }

      const parts = f.Path.split('/');
      let parent = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        const lastChild = parent.Children[parent.Children.length - 1];
        if (parent.Children.length > 0 && lastChild.Name === name && 'Children' in lastChild && lastChild.Children) {
          parent = lastChild as IDirectoryNode;
        } else {
          const dr = createDirectory(name, parent);
          parent.Children.push(dr);
          parent = dr;
        }
      }

      parent.Children.push(createFile(f, parent));
    }

    return root;
  }

  /**
   * Get a bundle to write modified files to.
   */
  GetBundleToWrite(): { bundle: Bundle; originalSize: number } {
    this.ensureNotDisposed();
    let originalSize = 0;

    const getSize = (br: BundleRecord): number => {
      let maxOffset = 0;
      for (const f of br._Files) {
        const end = f.Offset + f.Size;
        if (end > maxOffset) maxOffset = end;
      }
      return maxOffset;
    };

    let b: Bundle | null = null;
    for (const cb of this.customBundles) {
      originalSize = getSize(cb);
      if (originalSize < this.MaxBundleSize) {
        const { bundle, success } = cb.TryGetBundle();
        if (success) {
          b = bundle;
          break;
        }
      }
    }

    if (!b) {
      let bundlePath = CUSTOM_BUNDLE_BASE_PATH + this.customBundles.length;
      if (this.customBundles.some(br => br._Path === bundlePath)) {
        for (let i = 0; i < this.customBundles.length; i++) {
          if (!this.customBundles.some(br => br._Path === CUSTOM_BUNDLE_BASE_PATH + i)) {
            bundlePath = CUSTOM_BUNDLE_BASE_PATH + i;
            break;
          }
        }
      }
      b = this.createBundle(bundlePath);
      this.customBundles.push(b.Record!);
      originalSize = getSize(b.Record!);
    }

    return { bundle: b, originalSize };
  }

  /**
   * Create a new bundle and add it to Bundles.
   * @param bundlePath - Relative path without ".bundle.bin"
   */
  private createBundle(bundlePath: string): Bundle {
    this.ensureNotDisposed();
    const len = this._Bundles.length;
    const br = new BundleRecord(bundlePath, 0, this, len);
    this.bundleFactory.CreateBundle(bundlePath + '.bundle.bin');
    const b = Bundle.createEmpty(br);
    this._Bundles.push(br);
    this.baseBundle.UncompressedSize += br.RecordLength; // Prevent reallocation when saving
    return b;
  }

  // --- Name Hashing ---

  /**
   * Get the hash of a file path (string).
   */
  NameHash(name: string): bigint {
    if (this._Directories[0].PathHash === 0xF42A94E69CFF42FEn) {
      // Newer: MurmurHash64A (lowercase first)
      const lower = name.toLowerCase();
      const utf8 = Buffer.from(lower, 'utf8');
      return this.NameHashBytes(utf8);
    } else {
      // Older: FNV1a64Hash
      const utf8 = Buffer.from(name, 'utf8');
      return this.NameHashBytes(utf8);
    }
  }

  /**
   * Get the hash of a file path (bytes).
   */
  NameHashBytes(utf8Name: Buffer): bigint {
    this.ensureNotDisposed();
    switch (this._Directories[0].PathHash) {
      case 0xF42A94E69CFF42FEn:
        return MurmurHash64A(utf8Name);
      case 0x07E47507B4A92E53n:
        return FNV1a64Hash(utf8Name);
    }
    throw new Error('Unable to detect the namehash algorithm');
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Index has been disposed');
    }
  }

  /**
   * Dispose the index.
   */
  Dispose(): void {
    if (this._BundleToWrite) {
      console.warn('[LibBundle3] There are still unsaved changes when disposing Index. Did you forget to call Save()?');
      this._BundleToWrite.Dispose();
      this._BundleToWrite = null;
    }
    this._BundleStreamToWrite = null;
    this.baseBundle?.Dispose();
    this.root = null;
    this.disposed = true;
  }

  // --- Static Extract/Replace Methods ---

  /**
   * Extract files in batch.
   * @param files - Array of FileRecord to extract
   * @param callback - return true to cancel
   * @returns Number of files extracted successfully
   */
  static Extract(files: FileRecord[], callback: (file: FileRecord, data: Buffer | null) => boolean): number {
    const groups = new Map<BundleRecord, FileRecord[]>();
    for (const f of files) {
      const key = f.BundleRecord;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }

    let count = 0;
    for (const [br, fileGroup] of groups) {
      const { bundle, success } = br.TryGetBundle();
      if (success && bundle) {
        try {
          for (const f of fileGroup) {
            count++;
            if (callback(f, f.Read(bundle))) break;
          }
        } finally {
          bundle.Dispose();
        }
      } else {
        for (const f of fileGroup) {
          if (callback(f, null)) break;
        }
      }
    }
    return count;
  }

  /**
   * Extract files under a node recursively.
   */
  static ExtractNode(node: ITreeNode, callback: (file: FileRecord, data: Buffer | null) => boolean): number {
    return Index.Extract([...Index.RecurseFiles(node)].map(n => n.Record), callback);
  }

  /**
   * Replace files from a zip-like entries iterator.
   */
  static ReplaceFromEntries(
    index: Index,
    entries: Iterable<{ fullName: string; getData: () => Buffer }>,
    callback: ((file: FileRecord, fullName: string) => boolean) | null = null,
    saveIndex: boolean = true,
  ): number {
    index.ensureNotDisposed();
    let count = 0;
    for (const entry of entries) {
      if (entry.fullName.endsWith('/')) continue;

      const fr = index._Files.get(index.NameHash(entry.fullName));
      if (!fr) {
        throw new Error('Could not find file in Index: ' + entry.fullName);
      }

      const data = entry.getData();
      fr.Write(data);
      count++;

      if (callback?.(fr, entry.fullName)) break;
    }

    if (saveIndex && count !== 0) {
      index.Save();
    }
    return count;
  }

  /**
   * Replace files from disk under a node.
   */
  static ReplaceFromDisk(
    node: ITreeNode,
    diskPath: string,
    callback: ((file: FileRecord, filePath: string) => boolean) | null = null,
    saveIndex: boolean = true,
  ): number {
    const resolvedDiskPath = path.resolve(diskPath).replace(/[\\/]+$/, '') + path.sep;
    const trim = ITreeNode.GetPath(node).length;

    let index: Index | null = null;
    let count = 0;
    for (const fn of Index.RecurseFiles(node)) {
      const fr = fn.Record;
      if (!index) {
        index = fr.BundleRecord.Index;
        index.ensureNotDisposed();
      }

      const p = resolvedDiskPath + fr.Path!.slice(trim);
      if (fs.existsSync(p)) {
        fr.Write(fs.readFileSync(p));
        count++;
        if (callback?.(fr, p)) break;
      }
    }

    if (saveIndex && count !== 0) {
      index?.Save();
    }
    return count;
  }

  /**
   * Enumerate all file nodes under a node (DFS).
   */
  static *RecurseFiles(node: ITreeNode): Generator<IFileNode> {
    if ('Record' in node && node.Record !== undefined) {
      yield node as IFileNode;
    } else if ('Children' in node && node.Children) {
      for (const child of (node as IDirectoryNode).Children) {
        yield* Index.RecurseFiles(child);
      }
    }
  }

  /**
   * Sort files by bundle index (stable counting sort).
   */
  static SortByBundle(files: FileRecord[]): FileRecord[] {
    if (files.length === 0) return [];
    const index = files[0].BundleRecord.Index;
    const bundleCount = index._Bundles.length;
    const count = new Int32Array(bundleCount);

    for (const f of files) {
      if (f.BundleRecord.Index !== index) {
        throw new Error('Attempt to mixedly use FileRecords from different Index');
      }
      count[f.BundleRecord.BundleIndex]++;
    }

    for (let i = 1; i < bundleCount; i++) {
      count[i] += count[i - 1];
    }

    const sorted = new Array<FileRecord>(files.length);
    for (let i = files.length - 1; i >= 0; i--) {
      sorted[--count[files[i].BundleRecord.BundleIndex]] = files[i];
    }
    return sorted;
  }
}

// --- Hash Functions ---

/**
 * MurmurHash64A implementation.
 */
function MurmurHash64A(data: Buffer, seed: bigint = 0x1337B33Fn): bigint {
  if (data.length === 0) return 0xF42A94E69CFF42FEn;

  // TrimEnd('/')
  let len = data.length;
  if (data[len - 1] === 0x2F) len--;

  const m = 0xC6A4A7935BD1E995n;
  const r = 47;

  let h = seed ^ (BigInt(len) * m);

  // Process 8-byte chunks
  const numChunks = Math.floor(len / 8);
  for (let i = 0; i < numChunks; i++) {
    let k = data.readBigUInt64LE(i * 8);
    k = (k * m) & 0xFFFFFFFFFFFFFFFFn;
    k = k ^ (k >> BigInt(r));
    k = (k * m) & 0xFFFFFFFFFFFFFFFFn;
    h = (h ^ k) & 0xFFFFFFFFFFFFFFFFn;
    h = (h * m) & 0xFFFFFFFFFFFFFFFFn;
  }

  // Remaining bytes
  const remaining = len % 8;
  if (remaining !== 0) {
    let tail = 0n;
    for (let i = 0; i < remaining; i++) {
      tail |= BigInt(data[numChunks * 8 + i]) << BigInt(i * 8);
    }
    h = (h ^ tail) & 0xFFFFFFFFFFFFFFFFn;
    h = (h * m) & 0xFFFFFFFFFFFFFFFFn;
  }

  h = (h ^ (h >> BigInt(r))) & 0xFFFFFFFFFFFFFFFFn;
  h = (h * m) & 0xFFFFFFFFFFFFFFFFn;
  h = (h ^ (h >> BigInt(r))) & 0xFFFFFFFFFFFFFFFFn;
  return h;
}

/**
 * FNV1a64Hash implementation.
 */
function FNV1a64Hash(data: Buffer): bigint {
  const FNV_prime = 0x100000001B3n;
  let hash = 0xCBF29CE484222325n;
  const len = data.length;

  if (data[len - 1] === 0x2F) { // ends with '/'
    for (let i = 0; i < len - 1; i++) {
      hash = ((hash ^ BigInt(data[i])) * FNV_prime) & 0xFFFFFFFFFFFFFFFFn;
    }
  } else {
    for (let i = 0; i < len; i++) {
      let ch = BigInt(data[i]);
      if (ch >= 0x41n && ch <= 0x5An) { // 'A' - 'Z'
        ch += 0x20n; // toLower
      }
      hash = ((hash ^ ch) * FNV_prime) & 0xFFFFFFFFFFFFFFFFn;
    }
  }

  // Append "++"
  hash = ((hash ^ 0x2Bn) * FNV_prime) & 0xFFFFFFFFFFFFFFFFn; // '+'
  hash = ((hash ^ 0x2Bn) * FNV_prime) & 0xFFFFFFFFFFFFFFFFn; // '+'

  return hash;
}
