import { TreeNode } from './TreeNode.js';
import { FileRecord } from './FileRecord.js';
import { createHash } from 'node:crypto';
import type { GGPK } from '../GGPK.js';

/**
 * Entry in a directory's child list.
 * Stored in ggpk as: uint32 NameHash + int64 Offset (12 bytes total).
 * Sorted by NameHash for binary search.
 */
export interface DirectoryEntry {
  /** Murmur2 hash of lowercase entry name */
  nameHash: number;
  /** Offset in pack file where the record begins */
  offset: bigint;
}

/**
 * Record representing a directory in the ggpk file tree.
 * Tag = "PDIR" (0x52494450 in little-endian).
 */
export class DirectoryRecord extends TreeNode {
  /** "PDIR" tag */
  static readonly Tag = 0x52494450;

  /**
   * Entries of this directory recorded in ggpk.
   * @remarks They must be in order of {@link DirectoryEntry.nameHash}.
   */
  entries: DirectoryEntry[];

  /**
   * Children of this directory (parallel to entries). Null entries are lazy-loaded.
   */
  children: (TreeNode | null)[];

  /**
   * Number of child entries.
   */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Get a child by index, lazy-loading if needed.
   */
  private getChild(index: number): TreeNode {
    const cached = this.children[index];
    if (cached !== null) return cached;

    const entry = this.entries[index];
    const node = this.ggpk.readRecord(entry.offset) as TreeNode;
    node.parent = this;
    node._nameHash = entry.nameHash;
    this.children[index] = node;
    return node;
  }

  /**
   * Constructor: reads from GGPK stream.
   * The 8-byte (length + tag) header has already been consumed by GGPK.ReadRecord.
   *
   * @param length - Length of the record (already read)
   * @param ggpk - GGPK which contains this record
   */
  constructor(length: number, ggpk: GGPK) {
    super(length, ggpk);
    this.offset = ggpk.position - 8n;

    const nameLength = ggpk.readInt32() - 1; // Minus null terminator
    const totalEntries = ggpk.readInt32();
    ggpk.readBytes(32).copy(this._hash);

    if (ggpk.record.ggpkVersion === 4) {
      // UTF-32LE: 4 bytes per character
      const rawBytes = ggpk.readBytes(nameLength * 4);
      this.name = DirectoryRecord.readUtf32LE(rawBytes);
      ggpk.skip(4); // Null terminator (4 bytes in UTF-32)
    } else {
      // UTF-16LE: 2 bytes per character
      const rawBytes = ggpk.readBytes(nameLength * 2);
      this.name = DirectoryRecord.readUtf16LE(rawBytes);
      ggpk.skip(2); // Null terminator (2 bytes in UTF-16)
    }

    // Read entries
    this.entries = new Array(totalEntries);
    this.children = new Array(totalEntries).fill(null);
    for (let i = 0; i < totalEntries; i++) {
      this.entries[i] = {
        nameHash: ggpk.readUInt32(),
        offset: ggpk.readBigInt64(),
      };
    }
  }

  /**
   * Create a new DirectoryRecord from a name (not from stream).
   * Used internally by AddDirectory.
   */
  static createNew(name: string, ggpk: GGPK): DirectoryRecord {
    const record = Object.create(DirectoryRecord.prototype) as DirectoryRecord;
    // 手动初始化 BaseRecord 和 TreeNode 的属性，避免 ES6 class constructor 不能用 .call() 调用
    record.length = 0;
    record.ggpk = ggpk;
    record.offset = 0n;
    record.parent = null;
    record.name = name;
    record.throwIfNameEmptyOrContainsSlash();
    record.entries = [];
    record.children = [];
    record._hash = Buffer.alloc(32);
    record._nameHash = undefined;
    record.length = record.calculateRecordLength();
    return record;
  }

  /**
   * Iterator support.
   */
  [Symbol.iterator](): Iterator<TreeNode> {
    let index = 0;
    const self = this;
    return {
      next(): IteratorResult<TreeNode> {
        if (index < self.count) {
          return { value: self.getChild(index++), done: false };
        }
        return { value: undefined as unknown as TreeNode, done: true };
      },
    };
  }

  /**
   * Find child by NameHash.
   * @returns The child node, or null if not found.
   */
  findByHash(nameHash: number): TreeNode | null {
    const i = TreeNode.binarySearchEntries(this.entries, nameHash);
    if (i < 0) return null;
    return this.getChild(i);
  }

  /**
   * Find child by name.
   * @returns The child node, or null if not found.
   */
  findByName(name: string): TreeNode | null {
    return this.findByHash(TreeNode.getNameHash(name));
  }

  /**
   * Find a TreeNode with a path relative to this directory.
   *
   * @param path - Relative path (with forward slashes, no leading/trailing slash)
   * @returns The node found, or null when not found. Returns this if path is empty.
   */
  tryFindNode(path: string): TreeNode | null {
    if (path.length === 0) return this;

    const parts = path.split('/');
    let current: DirectoryRecord = this;

    for (let i = 0; i < parts.length; i++) {
      const next = current.findByName(parts[i]);
      if (next === null) return null;

      if (i === parts.length - 1) {
        // Last part
        return next;
      }

      if (!(next instanceof DirectoryRecord)) {
        // Not a directory but there are more path parts
        return null;
      }
      current = next;
    }

    return current;
  }

  /**
   * Find or create directories along a path.
   *
   * @param path - Relative path (with forward slashes, no leading slash)
   * @returns Object with added (true if any directory was created) and record (the final directory).
   */
  findOrAddDirectory(path: string): { added: boolean; record: DirectoryRecord } {
    const trimmed = path.replace(/\/+$/, '');
    if (trimmed.length === 0) return { added: false, record: this };

    let dir: DirectoryRecord = this;
    let added = false;

    for (const name of trimmed.split('/')) {
      const result = dir.addDirectory(name);
      dir = result.record;
      if (result.added) added = true;
    }

    return { added, record: dir };
  }

  /**
   * Find or create a file by path.
   *
   * @param path - Relative path (with forward slashes, no leading/trailing slash)
   * @param preallocatedSize - Content size in bytes of the new file (ignored if file already exists)
   * @returns Object with added and record.
   */
  findOrAddFile(path: string, preallocatedSize: number = 0): { added: boolean; record: FileRecord } {
    if (path.length === 0 || path.endsWith('/'))
      throw new Error('File name cannot be empty');

    if (preallocatedSize < 0)
      throw new RangeError('preallocatedSize must be non-negative');

    let dir: DirectoryRecord = this;
    const lastSlash = path.lastIndexOf('/');
    let name = path;

    if (lastSlash >= 0) {
      dir = dir.findOrAddDirectory(path.substring(0, lastSlash)).record;
      name = path.substring(lastSlash + 1);
    }

    return dir.addFile(name, preallocatedSize);
  }

  /**
   * Add a directory to this directory, or return the existing one with the same name.
   *
   * @param name - Name of the directory
   * @returns Object with added (true if created) and record.
   * @throws If a node with the same name exists but is not a DirectoryRecord.
   */
  addDirectory(name: string): { added: boolean; record: DirectoryRecord } {
    const record = DirectoryRecord.createNew(name, this.ggpk);
    record.parent = this;
    const i = this.insertNode(record);

    if (i < 0) {
      // Already exists
      const existing = this.getChild(~i);
      if (!(existing instanceof DirectoryRecord)) {
        this.throwExist(name);
      }
      return { added: false, record: existing };
    }

    record.writeWithNewLengthExplicit(record.length);
    return { added: true, record };
  }

  /**
   * Add a file to this directory, or return the existing one with the same name.
   *
   * @param name - Name of the file
   * @param preallocatedSize - Content size in bytes of the new file (ignored if file already exists)
   * @returns Object with added and record.
   * @throws If a node with the same name exists but is not a FileRecord.
   */
  addFile(name: string, preallocatedSize: number = 0): { added: boolean; record: FileRecord } {
    if (preallocatedSize < 0)
      throw new RangeError('preallocatedSize must be non-negative');

    const record = FileRecord.createNew(name, this.ggpk, preallocatedSize);
    record.parent = this;

    const i = this.insertNode(record);

    if (i < 0) {
      // Already exists
      const existing = this.getChild(~i);
      if (!(existing instanceof FileRecord)) {
        this.throwExist(name);
      }
      return { added: false, record: existing };
    }

    record.writeWithNewLengthExplicit(record.length);
    return { added: true, record };
  }

  /**
   * Throw a duplicate name error.
   * @internal Public for access from TreeNode.moveTo.
   */
  throwExist(name: string): never {
    throw new Error(`A file/directory with the same name already exists: ${this.getPath()}${name}`);
  }

  /**
   * Insert a TreeNode into this directory's entries.
   *
   * @param node - The node to insert
   * @returns Index of the inserted entry, or ~index if duplicate NameHash.
   */
  insertNode(node: TreeNode): number {
    const entry: DirectoryEntry = { nameHash: node.nameHash, offset: node.offset };
    const i = this.insertEntry(entry);
    if (i >= 0) {
      this.children[i] = node;
    }
    return i;
  }

  /**
   * Insert an entry into the sorted entries array.
   *
   * @param entry - The entry to insert
   * @returns Index of the inserted entry, or ~index if duplicate NameHash.
   */
  insertEntry(entry: DirectoryEntry): number {
    const i = TreeNode.binarySearchEntries(this.entries, entry.nameHash);
    if (i >= 0) return ~i; // Duplicate found

    const insertIdx = ~i; // Convert from ~index to actual insert position
    this.entries.splice(insertIdx, 0, entry);
    this.children.splice(insertIdx, 0, null);
    this.writeWithNewLength();
    this.ggpk.dirtyHashes.add(this);
    return insertIdx;
  }

  /**
   * Remove a child entry by NameHash.
   *
   * @param nameHash - Hash of the name to remove
   * @returns Index of the removed entry, or ~index if not found.
   */
  removeEntry(nameHash: number): number {
    const i = TreeNode.binarySearchEntries(this.entries, nameHash);
    if (i < 0) return i;

    this.entries.splice(i, 1);
    this.children.splice(i, 1);
    this.writeWithNewLength();
    this.ggpk.dirtyHashes.add(this);
    return i;
  }

  /**
   * Calculate the length of the record should be in ggpk file.
   */
  calculateRecordLength(): number {
    const version = this.ggpk.record.ggpkVersion;
    const charSize = version === 4 ? 4 : 2;
    const nameBytes = charSize * (this.name.length + 1);

    return (
      16 +                           // Length(4) + Tag(4) + NameLength(4) + EntryCount(4)
      TreeNode.SIZE_OF_HASH +        // SHA256 hash (32)
      nameBytes +                    // Name with null terminator
      12 * this.entries.length       // Each entry: NameHash(4) + Offset(8)
    );
  }

  /**
   * Write the record to ggpk file to its current position.
   */
  writeRecordData(): void {
    const ggpk = this.ggpk;
    this.offset = ggpk.position;

    ggpk.writeUInt32(this.length);
    ggpk.writeInt32(DirectoryRecord.Tag);
    ggpk.writeInt32(this.name.length + 1);
    ggpk.writeInt32(this.entries.length);
    ggpk.writeBytes(this._hash);

    if (ggpk.record.ggpkVersion === 4) {
      // UTF-32LE
      const nameBytes = DirectoryRecord.writeUtf32LE(this.name);
      ggpk.writeBytes(nameBytes);
      ggpk.writeInt32(0); // Null terminator
    } else {
      // UTF-16LE
      const nameBytes = DirectoryRecord.writeUtf16LE(this.name);
      ggpk.writeBytes(nameBytes);
      ggpk.writeUInt16LE(0); // Null terminator
    }

    // Write entries
    for (const entry of this.entries) {
      ggpk.writeUInt32(entry.nameHash);
      ggpk.writeBigInt64(entry.offset);
    }
  }

  /**
   * Recalculate SHA256 hash of the directory from children's hashes.
   * If hash is provided, use it directly instead of recalculating.
   */
  renewHash(hash?: Buffer): void {
    if (hash) {
      hash.copy(this._hash);
    } else {
      // Combine all children's hashes
      const combBuf = Buffer.alloc(this.entries.length * TreeNode.SIZE_OF_HASH);
      let i = 0;
      for (const node of this) {
        (node as TreeNode).hash.copy(combBuf, i * TreeNode.SIZE_OF_HASH);
        i++;
      }
      this._hash = createHash('sha256').update(combBuf).digest();
    }

    const ggpk = this.ggpk;
    // Write hash back at offset + 16 (after Length, Tag, NameLength, EntryCount = 4*4 bytes)
    ggpk.seek(this.offset + 16n);
    ggpk.writeBytes(this._hash);
    ggpk.dirtyHashes.delete(this);
  }

  // --- UTF string helpers ---

  /**
   * Read UTF-16LE null-terminated string from bytes.
   */
  static readUtf16LE(bytes: Buffer): string {
    return bytes.toString('utf16le').replace(/\0+$/, '');
  }

  /**
   * Read UTF-32LE null-terminated string from bytes.
   */
  static readUtf32LE(bytes: Buffer): string {
    let result = '';
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      const codePoint = bytes.readUInt32LE(i);
      if (codePoint === 0) break;
      result += String.fromCodePoint(codePoint);
    }
    return result;
  }

  /**
   * Encode string as UTF-16LE bytes without null terminator.
   */
  static writeUtf16LE(str: string): Buffer {
    return Buffer.from(str, 'utf16le');
  }

  /**
   * Encode string as UTF-32LE bytes without null terminator.
   */
  static writeUtf32LE(str: string): Buffer {
    const buf = Buffer.alloc(str.length * 4);
    for (let i = 0; i < str.length; i++) {
      buf.writeUInt32LE(str.codePointAt(i) ?? 0, i * 4);
    }
    return buf;
  }
}
