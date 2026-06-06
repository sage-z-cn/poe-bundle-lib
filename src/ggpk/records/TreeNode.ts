import { BaseRecord } from './BaseRecord.js';
import { FreeRecord } from './FreeRecord.js';
import type { DirectoryRecord } from './DirectoryRecord.js';
import type { FileRecord } from './FileRecord.js';
import type { GGPK } from '../GGPK.js';

/**
 * Base class of {@link FileRecord} and {@link DirectoryRecord},
 * represents nodes of the file system tree in ggpk file.
 *
 * @remarks Do not extend this class directly, use {@link FileRecord} or {@link DirectoryRecord} instead.
 */
export abstract class TreeNode extends BaseRecord {
  /** Size of SHA256 hash in bytes (== 32) */
  static readonly SIZE_OF_HASH = 32;

  /**
   * File/Directory name.
   */
  name: string = '';

  /**
   * SHA256 hash of the file content or directory children (32 bytes).
   */
  _hash: Buffer = Buffer.alloc(32);

  /**
   * SHA256 hash (32 bytes).
   */
  get hash(): Buffer {
    return this._hash;
  }

  /**
   * Parent directory node.
   */
  parent: DirectoryRecord | null = null;

  /**
   * Cached MurmurHash2 of lowercase name.
   * @internal Accessible outside the class for lazy-loading in DirectoryRecord.
   */
  _nameHash: number | undefined;

  /**
   * Get the murmur hash of name of this File/Directory.
   */
  get nameHash(): number {
    if (this._nameHash === undefined) {
      this._nameHash = TreeNode.getNameHash(this.name);
    }
    return this._nameHash;
  }

  constructor(length: number, ggpk: GGPK) {
    super(length, ggpk);
  }

  /**
   * Calculate the length of the record should be in ggpk file.
   */
  abstract calculateRecordLength(): number;

  /**
   * Write the modified record data to ggpk file.
   * This version calculates the new length automatically.
   *
   * @internal Called from DirectoryRecord and FileRecord.
   */
  writeWithNewLength(specify?: FreeRecord | null): FreeRecord | null {
    return this.writeWithNewLengthExplicit(this.calculateRecordLength(), specify);
  }

  /**
   * Write the modified record data to ggpk file.
   *
   * @param newLength - New length of the record after modification
   * @param specify - The specified FreeRecord to be written, null for finding a best one automatically
   * @returns The FreeRecord created at the original position if the record is moved, or null if replaced in place.
   *   It may also return an existing one if it was expanded to cover the original position.
   * @remarks Don't set {@link length} before calling this method, the method will update it.
   * @internal Called from DirectoryRecord and FileRecord.
   */
  writeWithNewLengthExplicit(newLength: number, specify?: FreeRecord | null): FreeRecord | null {
    const ggpk = this.ggpk;

    if (this.offset !== 0n && newLength === this.length && specify === undefined) {
      ggpk.seek(this.offset);
      this.writeRecordData();
      return null;
    }

    if (specify !== undefined && specify !== null) {
      if (specify.isInvalid)
        throw new Error('The specified FreeRecord is invalid, it may have already been removed from the ggpk');
      if (specify.length < newLength + 16 && specify.length !== newLength)
        throw new Error(`The length of specified FreeRecord must equal to newLength or larger than newLength + 16. specify: ${specify.length}, newLength: ${newLength}`);
    }

    let newFree: FreeRecord | null = this.offset === 0n ? null : this.markAsFree();

    if (specify !== undefined && specify !== null) {
      // If the specified FreeRecord became invalid after MarkAsFree (merged into newFree),
      // use newFree instead
      if (specify.isInvalid)
        specify = newFree;
    } else {
      specify = ggpk.findBestFreeRecord(newLength);
    }

    this.length = newLength;
    if (specify === null || specify === undefined) {
      // Write to the end of GGPK
      ggpk.seek(ggpk.length);
      this.writeRecordData();
    } else {
      ggpk.seek(specify.offset);
      this.writeRecordData();
      const newSpecifyLength = specify.length - newLength;
      if (newSpecifyLength >= 16) {
        // Update the remaining FreeRecord
        specify.updateLength(newSpecifyLength);
        ggpk.seek(specify.offset + BigInt(newLength));
        specify.writeRecordData();
        specify.updateOffset();
      } else {
        if (newSpecifyLength !== 0)
          throw new Error(`Unexpected remaining length: ${newSpecifyLength}`);
        specify.removeFromList();
      }
    }

    this.updateOffset();
    return newFree;
  }

  /**
   * Set this record to a {@link FreeRecord}, merging with adjacent FreeRecords.
   * @returns The FreeRecord covering this space, or null if trimmed from end of file.
   */
  protected markAsFree(): FreeRecord | null {
    const ggpk = this.ggpk;
    let previous: FreeRecord | null = null;
    let recordOffset = this.offset;
    let recordLength = this.length;
    let rightMerged = false;

    for (let f = ggpk.firstFreeRecord; recordLength < 0x7FFFFFFF && f !== null; f = f.next) {
      if (f.isInvalid) continue;

      if (f.offset === recordOffset + BigInt(recordLength)) {
        rightMerged = true;
        const newLen = recordLength + f.length;
        if (newLen < recordLength || newLen >= 0x7FFFFFFF) continue;
        recordLength = newLen;
        const tmp = f.next;
        f.removeFromList();
        if (tmp === null) break;
        // Check if previous merged with the removed free's previous
        const prevFree = tmp.previous;
        if (prevFree === null) {
          // retry from beginning
          f = ggpk.firstFreeRecord!;
          rightMerged = false;
          continue;
        }
        f = prevFree;
      } else if (f.offset + BigInt(f.length) === recordOffset) {
        const newLen = recordLength + f.length;
        if (newLen < recordLength || newLen >= 0x7FFFFFFF) continue;
        recordLength = newLen;
        previous = f;
        recordOffset = f.offset;
      }

      if (rightMerged && previous !== null) break;
    }

    if (recordLength < 16)
      throw new Error(`MarkAsFree: resulting length ${recordLength} is less than 16`);

    if (previous !== null) {
      if (previous.offset + BigInt(recordLength) >= ggpk.length) {
        // Trim if the record is at the end of the ggpk file
        previous.removeFromList();
        ggpk.setLength(previous.offset);
        return null;
      }
      if (previous.isInvalid)
        throw new Error('Previous FreeRecord became invalid');

      // Update record length
      previous.updateLength(recordLength);
      ggpk.seek(previous.offset);
      ggpk.writeUInt32(recordLength);
      return previous;
    } else if (recordOffset + BigInt(recordLength) >= ggpk.length) {
      // Trim if the record is at the end of the ggpk file
      ggpk.setLength(recordOffset);
      return null;
    }

    // Write new FreeRecord
    const free = FreeRecord.createAt(this.offset, 0n, ggpk);
    free.updateLength(recordLength);
    ggpk.seek(this.offset);
    free.writeRecordData();
    free.updateOffset();
    return free;
  }

  /**
   * Update the offset of this record in {@link parent}.{@link DirectoryRecord.entries}.
   */
  protected updateOffset(): void {
    const ggpk = this.ggpk;
    if (this.parent !== null) {
      const dr = this.parent;
      const i = TreeNode.binarySearchEntries(dr.entries, this.nameHash);
      if (i < 0) {
        throw new Error(`${this.getPath()} update offset failed: nameHash=${this.nameHash}, offset=${this.offset}`);
      }
      dr.entries[i].offset = this.offset;
      // Write the new offset back to ggpk
      // Offset of the entry in the record: dr.offset + dr.length - (entries.length - i) * 12 + 4
      ggpk.writeBigInt64At(
        this.offset,
        dr.offset + BigInt(dr.length - (dr.entries.length - i) * 12 + 4)
      );
    } else if ((this as unknown) === ggpk.root) {
      ggpk.record.rootDirectoryOffset = this.offset;
      ggpk.writeBigInt64At(this.offset, ggpk.record.offset + 12n);
    } else {
      throw new Error('Parent is null');
    }
  }

  /**
   * Get the full path in GGPK of this File/Directory.
   * Directories end with '/'.
   */
  getPath(): string {
    const parts: string[] = [];
    let node: TreeNode = this;
    while (node.parent !== null) {
      parts.unshift(node.name);
      node = node.parent;
    }
    // Check if this is a DirectoryRecord by duck-typing
    if ('entries' in this) {
      return parts.join('/') + '/';
    }
    return parts.join('/');
  }

  /**
   * Move the node from {@link parent} to the given directory (which can't be {@link GGPK.root}).
   *
   * @param directory - The new parent node to move to (which can't be the root)
   * @remarks GGPK.Root can't be moved.
   * Note that modifications made to children of the root directory will be restored
   * immediately when the game starts.
   */
  moveTo(directory: DirectoryRecord): void {
    if ((this as unknown) === this.ggpk.root)
      throw new Error("You can't move the root directory");
    const i = directory.insertNode(this);
    if (i < 0)
      directory.throwExist(this.name);
    this.parent!.removeEntry(this.nameHash);
    this.parent = directory;
  }

  /**
   * Remove this record and all children permanently from ggpk.
   *
   * @remarks GGPK.Root can't be removed.
   * Do not use any record instance of the removed nodes or its children after calling this,
   * otherwise it may break the ggpk.
   */
  remove(): void {
    if ((this as unknown) === this.ggpk.root)
      throw new Error("You can't remove the root directory");
    this.markAsFreeRecursively();
    this.parent!.removeEntry(this.nameHash);
  }

  /**
   * Internal implementation of {@link remove}.
   */
  protected markAsFreeRecursively(): void {
    if ('entries' in this && 'children' in this) {
      // This is a DirectoryRecord, recurse into children
      const dr = this as unknown as Iterable<TreeNode>;
      for (const child of dr) {
        (child as TreeNode).markAsFreeRecursively();
      }
    }
    this.markAsFree();
  }

  /**
   * Throw if name is empty or contains '/' (used by DirectoryRecord and FileRecord constructors).
   */
  protected throwIfNameEmptyOrContainsSlash(): void {
    if (!this.name || this.name.length === 0)
      throw new Error('Name cannot be null or empty');
    if (this.name.includes('/'))
      throw new Error("Name cannot contain '/'");
  }

  // --- Static helpers ---

  /**
   * Binary search in entries array sorted by nameHash.
   * @param entries - Array of { nameHash, offset } sorted by nameHash
   * @param nameHash - Name hash to search for
   * @returns Index of the entry, or ~insertionPoint if not found.
   */
  static binarySearchEntries(
    entries: readonly { nameHash: number; offset: bigint }[],
    nameHash: number
  ): number {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = nameHash - entries[mid].nameHash;
      if (cmp < 0) hi = mid - 1;
      else if (cmp > 0) lo = mid + 1;
      else return mid;
    }
    return ~lo;
  }

  /**
   * Get the MurmurHash2 of a lowercase name string (hashed as UTF-16LE bytes).
   */
  static getNameHash(name: string): number {
    const lower = name.toLowerCase();
    const buf = Buffer.from(lower, 'utf16le');
    return TreeNode.murmurHash2(buf, 0);
  }

  /**
   * MurmurHash2 (32-bit) implementation.
   * @param data - Input bytes
   * @param seed - Hash seed (default: 0xC58F1A7B)
   * @returns 32-bit hash as unsigned number.
   */
  static murmurHash2(data: Buffer, seed: number = 0xC58F1A7B): number {
    const m = 0x5BD1E995;
    const r = 24;

    let h = (seed ^ data.length) >>> 0;

    // Process 4-byte chunks
    const numChunks = data.length >>> 2;
    for (let i = 0; i < numChunks; i++) {
      let k = data.readUInt32LE(i * 4);
      k = Math.imul(k, m) >>> 0;
      k = (k ^ (k >>> r)) >>> 0;
      k = Math.imul(k, m) >>> 0;
      h = Math.imul(h, m) >>> 0;
      h = (h ^ k) >>> 0;
    }

    // Remaining bytes
    const remainingBytes = data.length & 3;
    if (remainingBytes !== 0) {
      const remainingStart = numChunks * 4;
      let remaining = 0;
      for (let i = 0; i < remainingBytes; i++) {
        remaining |= data[remainingStart + i] << (i * 8);
      }
      h = (h ^ remaining) >>> 0;
      h = Math.imul(h, m) >>> 0;
    }

    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h >>> 0;
  }

  /**
   * Recurse all nodes under a node (including self).
   */
  static *recurseTree(node: TreeNode): Generator<TreeNode> {
    yield node;
    if ('entries' in node && 'children' in node) {
      const dr = node as unknown as Iterable<TreeNode>;
      for (const child of dr) {
        yield* TreeNode.recurseTree(child as TreeNode);
      }
    }
  }

  /**
   * Recurse all {@link FileRecord} under a node.
   * @returns Generator yielding tuples of [FileRecord, relativePath].
   */
  static *recurseFiles(node: TreeNode): Generator<[FileRecord, string]> {
    yield* TreeNode.recurseFilesImpl(node, '');
  }

  private static *recurseFilesImpl(
    node: TreeNode,
    prefix: string
  ): Generator<[FileRecord, string]> {
    if ('dataLength' in node) {
      // It's a FileRecord
      yield [node as unknown as FileRecord, prefix + node.name];
    } else if ('entries' in node && 'children' in node) {
      const dr = node as unknown as { name: string; [Symbol.iterator](): Iterator<TreeNode> };
      const subPrefix = prefix + dr.name + '/';
      for (const child of dr) {
        yield* TreeNode.recurseFilesImpl(child as TreeNode, subPrefix);
      }
    }
  }

  /**
   * Node comparer: directories before files, then alphabetical.
   */
  static nodeComparer(a: TreeNode, b: TreeNode): number {
    const aIsDir = 'entries' in a;
    const bIsDir = 'entries' in b;
    if (aIsDir !== bIsDir) {
      return aIsDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  }
}
