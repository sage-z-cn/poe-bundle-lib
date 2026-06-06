import { TreeNode } from './TreeNode.js';
import { createHash } from 'node:crypto';
import type { GGPK } from '../GGPK.js';

/**
 * Record containing the data of a file.
 * Tag = "FILE" (0x454C4946 in little-endian).
 */
export class FileRecord extends TreeNode {
  /** "FILE" tag */
  static readonly Tag = 0x454C4946;

  /**
   * Offset in pack file where the raw data begins.
   */
  get dataOffset(): bigint {
    return this.offset + BigInt(this.length - this.dataLength);
  }

  /**
   * Length of the raw file data in bytes.
   */
  dataLength: number = 0;

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
    ggpk.readBytes(32).copy(this._hash);

    if (ggpk.version === 4) {
      // UTF-32LE: 4 bytes per character
      const rawBytes = ggpk.readBytes(nameLength * 4);
      this.name = this.readUtf32LE(rawBytes);
      ggpk.skip(4); // Null terminator (4 bytes in UTF-32)
    } else {
      // UTF-16LE: 2 bytes per character
      const rawBytes = ggpk.readBytes(nameLength * 2);
      this.name = this.readUtf16LE(rawBytes);
      ggpk.skip(2); // Null terminator (2 bytes in UTF-16)
    }

    // Calculate data length: remaining after header
    this.dataLength = length - (Number(ggpk.position - this.offset));
    // Seek past the data
    ggpk.seek(this.offset + BigInt(this.length));
  }

  /**
   * Create a new FileRecord from a name (not from stream).
   * Used by DirectoryRecord.AddFile.
   *
   * @param name - File name
   * @param ggpk - GGPK instance
   * @param dataLength - Pre-allocated data length
   */
  static createNew(name: string, ggpk: GGPK, dataLength: number = 0): FileRecord {
    const record = Object.create(FileRecord.prototype) as FileRecord;
    // 手动初始化 BaseRecord 和 TreeNode 的属性
    record.length = 0;
    record.ggpk = ggpk;
    record.offset = 0n;
    record.parent = null;
    record.name = name;
    record.throwIfNameEmptyOrContainsSlash();
    record.dataLength = dataLength;
    record._hash = Buffer.alloc(32);
    record._nameHash = undefined;
    record.length = record.calculateRecordLength();
    return record;
  }

  /**
   * Calculate the length of the record should be in ggpk file.
   */
  calculateRecordLength(): number {
    const version = this.ggpk.version;
    const charSize = version === 4 ? 4 : 2;
    const nameBytes = charSize * (this.name.length + 1);

    return (
      12 +                           // Length(4) + Tag(4) + NameLength(4)
      TreeNode.SIZE_OF_HASH +        // SHA256 hash (32)
      nameBytes +                    // Name with null terminator
      this.dataLength                // File data
    );
  }

  /**
   * Write the record header to ggpk file to its current position.
   * Actual file content writing is done by {@link write} methods.
   */
  writeRecordData(): void {
    const ggpk = this.ggpk;
    this.offset = ggpk.position;

    ggpk.writeUInt32(this.length);
    ggpk.writeInt32(FileRecord.Tag);
    ggpk.writeInt32(this.name.length + 1);
    ggpk.writeBytes(this._hash);

    if (ggpk.version === 4) {
      // UTF-32LE
      const nameBytes = this.writeUtf32LE(this.name);
      ggpk.writeBytes(nameBytes);
      ggpk.writeInt32(0); // Null terminator
    } else {
      // UTF-16LE
      const nameBytes = this.writeUtf16LE(this.name);
      ggpk.writeBytes(nameBytes);
      ggpk.writeUInt16LE(0); // Null terminator
    }
    // Note: actual file content is NOT written here - see write() methods
  }

  /**
   * Read the entire file content.
   * @returns Buffer containing the file data.
   */
  read(): Buffer {
    const buffer = Buffer.alloc(this.dataLength);
    this.readInto(buffer, 0);
    return buffer;
  }

  /**
   * Read a slice of the file content.
   * @param offset - Byte offset within the file content
   * @param length - Number of bytes to read
   * @returns Buffer containing the requested data.
   */
  readSlice(offset: number, length: number): Buffer {
    if (offset < 0 || offset > this.dataLength)
      throw new RangeError(`offset ${offset} out of range [0, ${this.dataLength}]`);
    const actualLen = Math.min(length, this.dataLength - offset);
    const buffer = Buffer.alloc(actualLen);
    this.readInto(buffer, 0);
    return buffer;
  }

  /**
   * Read file content into a provided buffer.
   * @param buffer - Target buffer
   * @param offset - Byte offset within the file content (default 0)
   * @remarks If the buffer is smaller than the remaining data, the result will be truncated.
   */
  readInto(buffer: Buffer, offset: number = 0): void {
    if (offset < 0 || offset > this.dataLength)
      throw new RangeError(`offset ${offset} out of range [0, ${this.dataLength}]`);

    const len = Math.min(buffer.length, this.dataLength - offset);
    if (len <= 0) return;

    const ggpk = this.ggpk;
    ggpk.copyBytesFrom(buffer, 0, Number(this.dataOffset) + offset, Number(this.dataOffset) + offset + len);
  }

  /**
   * Replace the entire file content. Moves this record to a FreeRecord with
   * the most suitable size, or end of file if not found. Also recalculates
   * the SHA-256 hash of the new content.
   *
   * @param newContent - New file content
   * @param hash - Optional pre-computed SHA-256 hash (computed if not provided)
   */
  write(newContent: Buffer, hash?: Buffer): void {
    if (hash) {
      hash.copy(this._hash);
    } else {
      this._hash = createHash('sha256').update(newContent).digest();
    }

    const ggpk = this.ggpk;
    if (newContent.length !== this.dataLength) {
      const diff = newContent.length - this.dataLength;
      this.dataLength = newContent.length;
      this.writeWithNewLengthExplicit(this.length + diff);
      // offset and dataOffset will be set by writeRecordData() called above
    } else {
      // Same length, just update hash in place
      ggpk.seek(this.offset + 12n); // Skip Length(4)+Tag(4)+NameLength(4)
      ggpk.writeBytes(this._hash);
    }

    ggpk.seek(this.dataOffset);
    ggpk.writeBytes(newContent);
    if (this.parent) {
      ggpk.dirtyHashes.add(this.parent);
    }
  }

  /**
   * Write data at a specific offset within the file content.
   * offset + data.length must be <= dataLength.
   *
   * @param data - Data to write
   * @param offset - Offset within file content
   * @param hash - Optional pre-computed SHA-256 hash of final content (computed if not provided)
   */
  writeAt(data: Buffer, offset: number, hash?: Buffer): void {
    if (offset < 0) throw new RangeError('offset must be non-negative');
    const end = offset + data.length;
    if (end > this.dataLength)
      throw new RangeError(`offset + data.length (${end}) exceeds dataLength (${this.dataLength})`);

    const ggpk = this.ggpk;

    if (hash) {
      hash.copy(this._hash);
    } else {
      // Recompute hash by reading the full content
      const content = this.read();
      data.copy(content, offset);
      this._hash = createHash('sha256').update(content).digest();
    }

    // Write hash at record offset + 12 (after Length, Tag, NameLength)
    ggpk.seek(this.offset + 12n);
    ggpk.writeBytes(this._hash);

    // Write data at dataOffset + offset
    ggpk.seek(this.dataOffset + BigInt(offset));
    ggpk.writeBytes(data);

    if (this.parent) {
      ggpk.dirtyHashes.add(this.parent);
    }
  }

  // --- UTF string helpers ---

  /**
   * Read UTF-16LE null-terminated string from bytes.
   */
  private readUtf16LE(bytes: Buffer): string {
    return bytes.toString('utf16le').replace(/\0+$/, '');
  }

  /**
   * Read UTF-32LE null-terminated string from bytes.
   */
  private readUtf32LE(bytes: Buffer): string {
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
  private writeUtf16LE(str: string): Buffer {
    return Buffer.from(str, 'utf16le');
  }

  /**
   * Encode string as UTF-32LE bytes without null terminator.
   */
  private writeUtf32LE(str: string): Buffer {
    const buf = Buffer.alloc(str.length * 4);
    for (let i = 0; i < str.length; i++) {
      buf.writeUInt32LE(str.codePointAt(i) ?? 0, i * 4);
    }
    return buf;
  }
}
