import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { GGPKRecord } from './records/GGPKRecord.js';
import { FreeRecord } from './records/FreeRecord.js';
import { TreeNode } from './records/TreeNode.js';
import { BaseRecord } from './records/BaseRecord.js';
import { DirectoryRecord } from './records/DirectoryRecord.js';
import { FileRecord } from './records/FileRecord.js';
import { GGPKBrokenError } from './GGPKBrokenError.js';

/**
 * Record tag constants (little-endian ASCII values).
 */
const TAG_GGPK = 0x4B504747; // "GGPK"
const TAG_PDIR = 0x52494450; // "PDIR" (DirectoryRecord)
const TAG_FILE = 0x454C4946; // "FILE" (FileRecord)
const TAG_FREE = 0x45455246; // "FREE" (FreeRecord)

/**
 * Minimum record size: 4B length + 4B tag + 8B nextFreeOffset = 16 bytes
 */
const MIN_FREE_LENGTH = 16;

/** Size of a SHA-256 hash in bytes */
const SHA256_LEN = 32;

/**
 * Class to handle the Content.ggpk file.
 *
 * Port of LibGGPK3/GGPK.cs.
 *
 * Use {@link open} to create an instance (passes a file descriptor for positional I/O).
 * When done, call {@link dispose} to flush and close.
 */
export class GGPK {
  // ── Internal state ──────────────────────────────────────────

  /** File descriptor from fs.openSync */
  private _fd: number;

  /** If false, close the fd on dispose */
  private _leaveOpen: boolean;

  /** Current read/write position within the file (BigInt). */
  private _pos: bigint;

  /** Set of DirectoryRecords whose hashes need renewal. */
  readonly dirtyHashes: Set<DirectoryRecord> = new Set();

  // ── Core records ────────────────────────────────────────────

  /** GGPKRecord (first record in file). */
  readonly record: GGPKRecord;

  /** Root DirectoryRecord of the filesystem tree. */
  readonly root: DirectoryRecord;

  // ── FreeRecord tracking ─────────────────────────────────────

  /**
   * First FreeRecord in the linked list (lazy).
   * @privateRemarks `undefined` means not yet loaded.
   */
  private _firstFreeRecord: FreeRecord | null | undefined;

  /**
   * Sorted list of FreeRecords by length (ascending), lazy-initialized.
   */
  private _sortedFreeRecords: FreeRecord[] | null = null;

  // ── Constructor ─────────────────────────────────────────────

  /**
   * Open a Content.ggpk file for reading and writing.
   *
   * @param filePath - Path to Content.ggpk on disk.
   * @throws {@link GGPKBrokenError} if the file is corrupted or unrecognized.
   */
  constructor(filePath: string) {
    const fd = fs.openSync(filePath, 'r+');
    this._fd = fd;
    this._leaveOpen = false;
    this._pos = 0n;

    try {
      this.record = this.readRecord(0n) as GGPKRecord;
      if (!(this.record instanceof GGPKRecord)) {
        throw new GGPKBrokenError(
          this,
          `Expected GGPKRecord at offset 0, got tag 0x${(this.record as BaseRecord).length.toString(16)}`,
          0,
          0,
        );
      }
      this.root = this.readRecord(this.record.rootDirectoryOffset) as DirectoryRecord;
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  /**
   * Advanced constructor — accepts a pre-opened file descriptor.
   * Exposed for bundled-GGPK scenarios (reading from a sub-stream).
   *
   * @param fd - Pre-opened file descriptor (r+ mode).
   * @param leaveOpen - If true, leave fd open on dispose.
   * @param rootOffset - Where to start reading from (default 0 for full file).
   */
  static fromFd(
    fd: number,
    leaveOpen: boolean,
    rootOffset: bigint = 0n,
  ): GGPK {
    const ggpk = Object.create(GGPK.prototype) as GGPK;
    ggpk._fd = fd;
    ggpk._leaveOpen = leaveOpen;
    ggpk._pos = rootOffset;
    // Manually call the initialization that the constructor would do
    try {
      Object.defineProperty(ggpk, 'record', {
        value: ggpk.readRecord(rootOffset),
        writable: false,
        configurable: false,
      });
      if (!(ggpk.record instanceof GGPKRecord)) {
        throw new GGPKBrokenError(ggpk, 'Expected GGPKRecord at root offset', 0, 0);
      }
      Object.defineProperty(ggpk, 'root', {
        value: ggpk.readRecord(ggpk.record.rootDirectoryOffset),
        writable: false,
        configurable: false,
      });
    } catch (e) {
      ggpk.dispose();
      throw e;
    }
    return ggpk;
  }

  // ── Public properties ───────────────────────────────────────

  /** Current read/write position in bytes. */
  get position(): bigint {
    return this._pos;
  }

  /** Total length of the GGPK file in bytes. */
  get length(): bigint {
    return BigInt(fs.fstatSync(this._fd).size);
  }

  /** GGPK format version (3 for PC, 4 for Mac, 2 for pre-3.11.2). */
  get Version(): number {
    return this.record.ggpkVersion;
  }

  /** Alias for {@link Version} — used by record classes. */
  get version(): number {
    return this.record.ggpkVersion;
  }

  /** First FreeRecord in the linked-list (lazy-initialized). */
  get firstFreeRecord(): FreeRecord | null {
    if (this._firstFreeRecord === undefined) {
      if (this.record.firstFreeRecordOffset !== 0n) {
        try {
          this._firstFreeRecord = this.readRecord(
            this.record.firstFreeRecordOffset,
          ) as FreeRecord;
        } catch (e) {
          // FreeRecord offset 指向无效数据，重置为空闲链表为空
          this.record.firstFreeRecordOffset = 0n;
          this._firstFreeRecord = null;
        }
      } else {
        this._firstFreeRecord = null;
      }
    }
    return this._firstFreeRecord ?? null;
  }

  set firstFreeRecord(value: FreeRecord | null) {
    if (value === null) {
      this.record.firstFreeRecordOffset = 0n;
    } else {
      this.record.firstFreeRecordOffset = value.offset;
      if (value.previous !== null) {
        const prev = value.previous;
        prev.next = null;
        value.previous = null;
      }
    }
    this._firstFreeRecord = value;
  }

  /**
   * Enumerate all FreeRecords in the linked list.
   */
  get freeRecords(): Generator<FreeRecord> {
    return this.enumerateFreeRecords();
  }

  private *enumerateFreeRecords(): Generator<FreeRecord> {
    let free = this.firstFreeRecord;
    while (free !== null) {
      yield free;
      free = free.next;
    }
  }

  /**
   * Sorted list of FreeRecords by length (ascending, lazy-initialized).
   */
  get sortedFreeRecords(): FreeRecord[] {
    if (!this._sortedFreeRecords) {
      this._sortedFreeRecords = [...this.enumerateFreeRecords()].sort(
        BaseRecord.lengthComparer,
      );
    }
    return this._sortedFreeRecords;
  }

  /**
   * Invalidate the sorted FreeRecord cache (call after structural changes).
   */
  invalidateSortedFreeRecords(): void {
    this._sortedFreeRecords = null;
  }

  // ── Low-level I/O (used by record classes) ──────────────────

  /**
   * Read a 4-byte unsigned integer (little-endian) and advance position.
   */
  readUInt32(): number {
    const buf = Buffer.alloc(4);
    fs.readSync(this._fd, buf, 0, 4, Number(this._pos));
    this._pos += 4n;
    return buf.readUInt32LE(0);
  }

  /**
   * Read a 4-byte signed integer (little-endian) and advance position.
   */
  readInt32(): number {
    const buf = Buffer.alloc(4);
    fs.readSync(this._fd, buf, 0, 4, Number(this._pos));
    this._pos += 4n;
    return buf.readInt32LE(0);
  }

  /**
   * Read an 8-byte signed bigint (little-endian) and advance position.
   */
  readBigInt64(): bigint {
    const buf = Buffer.alloc(8);
    fs.readSync(this._fd, buf, 0, 8, Number(this._pos));
    this._pos += 8n;
    return buf.readBigInt64LE(0);
  }

  /**
   * Read `length` raw bytes into a new Buffer and advance position.
   */
  readBytes(length: number): Buffer {
    const buf = Buffer.alloc(length);
    fs.readSync(this._fd, buf, 0, length, Number(this._pos));
    this._pos += BigInt(length);
    return buf;
  }

  /**
   * Skip `bytes` forward from the current position.
   */
  skip(bytes: number): void {
    this._pos += BigInt(bytes);
  }

  /**
   * Read raw bytes into a pre-allocated Buffer and advance position.
   *
   * @returns Number of bytes actually read.
   */
  readBuffer(buf: Buffer, offset: number, length: number): number {
    const bytesRead = fs.readSync(this._fd, buf, offset, length, Number(this._pos));
    this._pos += BigInt(bytesRead);
    return bytesRead;
  }

  /**
   * Read exactly `length` bytes into a pre-allocated Buffer, throw on short read.
   */
  readExactly(buf: Buffer, offset: number, length: number): void {
    let totalRead = 0;
    while (totalRead < length) {
      const bytesRead = fs.readSync(
        this._fd,
        buf,
        offset + totalRead,
        length - totalRead,
        Number(this._pos + BigInt(totalRead)),
      );
      if (bytesRead === 0) {
        throw new Error(
          `Unexpected end of file: expected ${length} bytes, got ${totalRead}`,
        );
      }
      totalRead += bytesRead;
    }
    this._pos += BigInt(totalRead);
  }

  /**
   * Copy bytes from the file into a Buffer (without changing position).
   *
   * @param buf - Target buffer
   * @param dstOffset - Offset in target buffer
   * @param fromPos - Start position in file
   * @param toPos - End position in file (exclusive)
   */
  copyBytesFrom(buf: Buffer, dstOffset: number, fromPos: number, toPos: number): void {
    const len = toPos - fromPos;
    if (len <= 0) return;
    fs.readSync(this._fd, buf, dstOffset, len, fromPos);
  }

  /**
   * Write a 4-byte unsigned integer (little-endian) and advance position.
   */
  writeUInt32(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    fs.writeSync(this._fd, buf, 0, 4, Number(this._pos));
    this._pos += 4n;
  }

  /**
   * Write a 4-byte signed integer (little-endian) and advance position.
   */
  writeInt32(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(value, 0);
    fs.writeSync(this._fd, buf, 0, 4, Number(this._pos));
    this._pos += 4n;
  }

  /**
   * Write a 2-byte unsigned integer (little-endian) and advance position.
   */
  writeUInt16LE(value: number): void {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value, 0);
    fs.writeSync(this._fd, buf, 0, 2, Number(this._pos));
    this._pos += 2n;
  }

  /**
   * Write an 8-byte signed bigint (little-endian) and advance position.
   */
  writeBigInt64(value: bigint): void {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value, 0);
    fs.writeSync(this._fd, buf, 0, 8, Number(this._pos));
    this._pos += 8n;
  }

  /**
   * Write an 8-byte signed bigint at a specific offset without changing position.
   */
  writeBigInt64At(value: bigint, position: bigint): void {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value, 0);
    fs.writeSync(this._fd, buf, 0, 8, Number(position));
  }

  /**
   * Write an unsigned 32-bit integer at a specific offset without changing position.
   */
  writeUInt32At(value: number, position: bigint): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    fs.writeSync(this._fd, buf, 0, 4, Number(position));
  }

  /**
   * Write raw bytes to the file at the current position and advance.
   */
  writeBytes(buf: Buffer): void {
    fs.writeSync(this._fd, buf, 0, buf.length, Number(this._pos));
    this._pos += BigInt(buf.length);
  }

  /**
   * Write raw bytes at offset in buffer and advance position.
   */
  writeBuffer(buf: Buffer, offset: number, length: number): void {
    fs.writeSync(this._fd, buf, offset, length, Number(this._pos));
    this._pos += BigInt(length);
  }

  /**
   * Set the current position.
   */
  seek(offset: bigint): void {
    this._pos = offset;
  }

  /**
   * Truncate the file to the given length.
   */
  setLength(offset: bigint): void {
    fs.ftruncateSync(this._fd, Number(offset));
  }

  /**
   * Flush pending writes to disk.
   */
  flush(): void {
    fs.fsyncSync(this._fd);
  }

  // ── Record reading ──────────────────────────────────────────

  /**
   * Read a record from GGPK at the current position.
   *
   * Reads [length:uint32, tag:uint32], then dispatches to the appropriate
   * record constructor based on the tag value.
   */
  readRecord(offset?: bigint): BaseRecord {
    if (offset !== undefined) {
      this._pos = offset;
    }

    const length = this.readUInt32();
    const tag = this.readUInt32();

    // Dynamically import constructors to avoid circular dependency deadlocks
    switch (tag) {
      case TAG_GGPK:
        return new GGPKRecord(length, this);
      case TAG_PDIR:
        return new DirectoryRecord(length, this);
      case TAG_FILE:
        return new FileRecord(length, this);
      case TAG_FREE:
        return new FreeRecord(length, this);
      default:
        throw new GGPKBrokenError(
          this,
          `Invalid record tag 0x${tag.toString(16).padStart(8, '0')} at offset ${this._pos - 4n}`,
          Number(this._pos - 4n),
          tag,
        );
    }
  }

  // ── FreeRecord management ───────────────────────────────────

  /**
   * Find the most suitable FreeRecord to write a record of the given length.
   *
   * Binary-searches {@link sortedFreeRecords} by length.
   * The chosen FreeRecord must have enough room: its length must equal the
   * required length, or be at least 16 bytes larger (to hold a residual FreeRecord).
   *
   * @param length - Required length in bytes for the new record.
   * @param maxOffset - Optional upper bound for the FreeRecord's offset.
   * @returns The best FreeRecord, or `null` if none found.
   */
  findBestFreeRecord(length: number, maxOffset?: bigint): FreeRecord | null {
    const list = this.sortedFreeRecords;
    if (list.length === 0) return null;

    // Binary search for first element with length >= target
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].length < length) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Look forward for an acceptable record
    for (let i = lo; i < list.length; i++) {
      const result = list[i];
      if (result.isInvalid) continue;

      // Exact match — use it
      if (result.length === length) {
        if (maxOffset !== undefined && result.offset > maxOffset) continue;
        return result;
      }

      // Must have 16+ bytes extra for a residual FreeRecord
      if (result.length >= length + MIN_FREE_LENGTH) {
        if (maxOffset !== undefined && result.offset > maxOffset) continue;
        return result;
      }
    }

    return null;
  }

  /**
   * Compact the ggpk to reduce its size by filling FreeRecord gaps.
   *
   * @param cancellation - Optional callback; return `true` to cancel early.
   * @param progress - Optional callback receiving remaining FreeRecord count.
   */
  fastCompact(
    cancellation?: (() => boolean) | null,
    progress?: ((remaining: number) => void) | null,
  ): void {
    if (cancellation?.()) return;

    this.freeRecordConcat();

    // Build priority queue of FreeRecords (sorted by offset ascending)
    const freeRecords = Array.from(this.freeRecords);
    // Sort by offset ascending (smallest offset = highest priority)
    freeRecords.sort(BaseRecord.offsetComparer);

    progress?.(freeRecords.length);
    if (freeRecords.length === 0) return;

    if (cancellation?.()) return;

    // Collect all tree nodes (excluding FreeRecords), sorted by length descending
    const treeNodes = Array.from(TreeNode.recurseTree(this.root));
    treeNodes.sort((a, b) => b.length - a.length);

    if (cancellation?.()) return;

    // Process free records from smallest offset to largest
    let freeIdx = 0;
    while (freeIdx < freeRecords.length) {
      const free = freeRecords[freeIdx];
      if (free.isInvalid) {
        freeIdx++;
        continue;
      }

      if (cancellation?.()) return;
      progress?.(freeRecords.length - freeIdx);

      // Find the largest tree node that fits in this free space
      for (let i = treeNodes.length - 1; i >= 0; i--) {
        const node = treeNodes[i];

        if (node.length > free.length) break;
        if (node.offset < free.offset) continue;
        // Must fit exactly or leave 16+ bytes
        if (
          node.length > free.length - MIN_FREE_LENGTH &&
          node.length !== free.length
        )
          continue;

        // Remove from consideration
        treeNodes.splice(i, 1);

        // Cast to access protected writeWithNewLengthExplicit
        const nodeWritable = node as unknown as {
          writeWithNewLengthExplicit: (len: number, free?: FreeRecord | null) => FreeRecord | null;
        };

        if ('dataLength' in node) {
          // FileRecord — copy raw data
          const file = node as unknown as FileRecord;
          const fileContent = file.read();
          const newFree = nodeWritable.writeWithNewLengthExplicit(
            node.length,
            free,
          );
          // Write data to the new dataOffset position
          const fileLike = file as unknown as { dataLength: number };
          this.seek(file.offset + BigInt(file.length - fileLike.dataLength));
          this.writeBuffer(fileContent, 0, fileContent.length);
          if (newFree !== null && newFree !== free) {
            freeRecords.push(newFree);
            // Re-sort by offset
            freeRecords.sort(BaseRecord.offsetComparer);
          }
        } else {
          // DirectoryRecord
          const newFree = nodeWritable.writeWithNewLengthExplicit(
            node.length,
            free,
          );
          if (newFree !== null && newFree !== free) {
            freeRecords.push(newFree);
            freeRecords.sort(BaseRecord.offsetComparer);
          }
        }
      }

      freeIdx++;
    }

    progress?.(0);
    this.flush();
  }

  /**
   * Merge all adjacent FreeRecords into larger contiguous blocks.
   *
   * Walks the FreeRecord linked list sorted by offset, merging neighbours.
   * If the last FreeRecord reaches the physical end of the file, it is trimmed.
   */
  freeRecordConcat(): void {
    // Build a list sorted by offset
    const list = Array.from(this.freeRecords).sort(BaseRecord.offsetComparer);
    if (list.length <= 1) return;

    let changed = false;
    let current: FreeRecord | null = null;
    let i = 0;
    let proceed = true;

    while (proceed) {
      changed = false;
      current = list[i];
      while (
        (proceed = ++i < list.length) &&
        current.offset + BigInt(current.length) === list[i].offset
      ) {
        current.length += list[i].length;
        list[i].removeFromList();
        changed = true;
      }
      if (changed && current) {
        this.writeUInt32At(current.length, current.offset);
        current.updateLength(current.length);
      }
    }

    // Trim trailing free record if it reaches EOF
    if (
      current !== null &&
      current.offset + BigInt(current.length) >= this.length
    ) {
      this.setLength(current.offset);
      current.removeFromList();
    }

    this.flush();
    this.invalidateSortedFreeRecords();
  }

  // ── Hash management ─────────────────────────────────────────

  /**
   * Renew the SHA-256 hashes of all dirty directories after modification.
   *
   * @param forceRenewRoot - If `true`, also renew the root directory hash.
   *   (This will cause the game to start patching on startup and revert ggpk modifications.)
   *
   * @remarks Called automatically on {@link dispose}.
   */
  renewHashes(forceRenewRoot: boolean = false): void {
    this.dirtyHashes.delete(null!);

    let count = 0;
    let prevCount = -1;
    while (this.dirtyHashes.size !== prevCount) {
      prevCount = this.dirtyHashes.size;
      const snapshot = Array.from(this.dirtyHashes);

      for (const dr of snapshot) {
        if (
          forceRenewRoot ||
          (dr !== this.root && dr.parent !== this.root)
        ) {
          // Keep root + immediate children hashes to prevent game patching
          dr.renewHash();
          // Parent will be processed in next round
          if (dr.parent) {
            this.dirtyHashes.add(dr.parent);
          }
        }
      }
      this.dirtyHashes.delete(null!);
      count = snapshot.length;
    }
  }

  /**
   * Erase the hashes of the root directory and its immediate children.
   *
   * This will cause the game to start patching on startup
   * and revert all modifications to ggpk from this library.
   */
  eraseRootHash(): void {
    for (const child of this.root) {
      (child as unknown as { _hash: Buffer })._hash = Buffer.alloc(SHA256_LEN);
      (child as unknown as { writeWithNewLength: () => void }).writeWithNewLength();
    }

    (this.root as unknown as { _hash: Buffer })._hash = Buffer.alloc(SHA256_LEN);
    (this.root as unknown as { writeWithNewLength: () => void }).writeWithNewLength();
  }

  // ── Static: Extract ─────────────────────────────────────────

  /**
   * Extract files under a tree node recursively to a path on disk.
   *
   * @param record - Node to extract (DirectoryRecord or FileRecord).
   * @param dirPath - Destination directory on disk.
   * @param callback - Invoked after each file is extracted.
   *   Return `true` to cancel.
   * @returns Number of files extracted.
   */
  static extract(
    record: TreeNode,
    dirPath: string,
    callback?: ((file: FileRecord, fullPath: string) => boolean) | null,
  ): number {
    return GGPK.extractRecursive(record, dirPath, callback, 0).count;
  }

  private static extractRecursive(
    record: TreeNode,
    currentPath: string,
    callback: ((file: FileRecord, fullPath: string) => boolean) | undefined | null,
    depth: number,
  ): { count: number; cancelled: boolean } {
    const fullPath = depth === 0 ? currentPath : `${currentPath}/${record.name}`;

    // Check if it's a FileRecord (has dataLength)
    if ('dataLength' in record) {
      const fr = record as unknown as FileRecord;
      const data = fr.read();
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, data);
      if (callback?.(fr, fullPath)) {
        return { count: 1, cancelled: true };
      }
      return { count: 1, cancelled: false };
    }

    // DirectoryRecord — recurse
    if (!('entries' in record)) {
      return { count: 0, cancelled: false };
    }

    // Ensure directory exists
    fs.mkdirSync(fullPath, { recursive: true });

    let count = 0;
    const dir = record as unknown as DirectoryRecord;
    for (const child of dir) {
      const result = GGPK.extractRecursive(
        child as TreeNode,
        fullPath,
        callback,
        depth + 1,
      );
      count += result.count;
      if (result.cancelled) return { count, cancelled: true };
    }
    return { count, cancelled: false };
  }

  // ── Static: Replace from disk ───────────────────────────────

  /**
   * Replace files under a tree node recursively from a path on disk.
   *
   * @param record - Node to replace (scan for matching file names).
   * @param diskPath - Root directory on disk to read replacements from.
   * @param callback - Invoked after each file is replaced.
   *   Return `true` to cancel.
   * @returns Number of files replaced.
   */
  static replace(
    record: TreeNode,
    diskPath: string,
    callback?: ((file: FileRecord, fullPath: string) => boolean) | null,
  ): number {
    return GGPK.replaceRecursive(record, diskPath, callback, 0).count;
  }

  private static replaceRecursive(
    record: TreeNode,
    currentPath: string,
    callback: ((file: FileRecord, fullPath: string) => boolean) | undefined | null,
    depth: number,
  ): { count: number; cancelled: boolean } {
    const fullPath = depth === 0 ? currentPath : `${currentPath}/${record.name}`;

    if ('dataLength' in record) {
      // FileRecord — replace from disk if file exists
      const fr = record as unknown as FileRecord;
      if (!fs.existsSync(fullPath)) {
        return { count: 0, cancelled: false };
      }
      const data = fs.readFileSync(fullPath);
      fr.write(data);
      if (callback?.(fr, fullPath)) {
        return { count: 1, cancelled: true };
      }
      return { count: 1, cancelled: false };
    }

    // DirectoryRecord — recurse
    if (!('entries' in record) || !fs.existsSync(fullPath)) {
      return { count: 0, cancelled: false };
    }

    let count = 0;
    const dir = record as unknown as DirectoryRecord;
    for (const child of dir) {
      const result = GGPK.replaceRecursive(
        child as TreeNode,
        fullPath,
        callback,
        depth + 1,
      );
      count += result.count;
      if (result.cancelled) return { count, cancelled: true };
    }
    return { count, cancelled: false };
  }

  // ── Static: Replace from zip entries ────────────────────────

  /**
   * Replace files under a directory from zip-like entries.
   *
   * @param root - Root DirectoryRecord to search/replace within.
   * @param zipEntries - Iterable of { fullName, getData } entries.
   * @param callback - Invoked after each file is replaced.
   *   Provides the FileRecord, full path, and whether it was added.
   *   Return `true` to cancel.
   * @param allowAdd - If `true`, create missing files; otherwise throw.
   * @returns Number of files replaced.
   */
  static replaceFromZipEntries(
    root: DirectoryRecord,
    zipEntries: Iterable<{
      fullName: string;
      getData: () => Buffer;
    }>,
    callback?:
    | ((file: FileRecord, fullName: string, added: boolean) => boolean)
    | null,
    allowAdd: boolean = false,
  ): number {
    let count = 0;

    for (const entry of zipEntries) {
      if (entry.fullName.endsWith('/')) continue;

      const data = entry.getData();
      let file: FileRecord;
      let added = false;

      if (allowAdd) {
        const result = (root as DirectoryRecord & {
          findOrAddFile: (
            path: string,
          ) => { record: FileRecord; added: boolean };
        }).findOrAddFile(entry.fullName);
        file = result.record;
        added = result.added;
      } else {
        (root as DirectoryRecord & { tryFindNode: (path: string) => TreeNode | null })
          .tryFindNode(entry.fullName);
        const found = (
          root as unknown as { tryFindNode: (path: string) => TreeNode | null }
        ).tryFindNode?.(entry.fullName);
        if (!found || !('dataLength' in found)) {
          throw new Error(
            `Could not find file in ggpk: ${(root as unknown as TreeNode).getPath()}${entry.fullName}`,
          );
        }
        file = found as unknown as FileRecord;
      }

      file.write(data);
      count++;

      if (callback?.(file, entry.fullName, added)) break;
    }

    return count;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Ensure the instance has not been disposed.
   */
  ensureNotDisposed(): void {
    if (this._fd < 0) {
      throw new Error('GGPK has been disposed');
    }
  }

  /**
   * Flush pending changes then close the file descriptor.
   */
  dispose(): void {
    if (this._fd < 0) return;

    try {
      this.renewHashes();
      this.flush();
    } catch {
      // Best effort
    }

    if (!this._leaveOpen) {
      fs.closeSync(this._fd);
    }
    this._fd = -1;
  }
}
