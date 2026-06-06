import { BaseRecord } from './BaseRecord.js';
import type { GGPK } from '../GGPK.js';

/**
 * A free record represents space in the pack file that has been marked as deleted.
 * It's much cheaper to just mark areas as free and append data to a suitable location
 * than it is to rebuild the entire pack file just to remove a piece of data.
 *
 * Tag = "FREE" (0x45455246 in little-endian).
 */
export class FreeRecord extends BaseRecord {
  /** "FREE" tag */
  static readonly Tag = 0x45455246;

  /**
   * Offset of next FreeRecord in the linked-list.
   */
  nextFreeOffset: bigint;

  /**
   * Previous FreeRecord in the linked-list.
   */
  previous: FreeRecord | null = null;

  /**
   * Next FreeRecord in the linked-list (lazy-loaded).
   */
  protected _next: FreeRecord | null | undefined;

  /**
   * Next FreeRecord in the linked-list, lazy-loaded from ggpk.
   */
  get next(): FreeRecord | null {
    if (this._next === undefined && this.nextFreeOffset !== 0n) {
      this._next = this.ggpk.readRecord(this.nextFreeOffset) as FreeRecord;
      this._next.previous = this;
    }
    return this._next ?? null;
  }

  set next(value: FreeRecord | null) {
    if (value !== null && value.isInvalid)
      throw new Error('Cannot link to an invalid FreeRecord');

    if (this._next != null)
      this._next.previous = null;

    if (value === null) {
      this.nextFreeOffset = 0n;
    } else {
      this.nextFreeOffset = value.offset;
      if (value.previous !== null)
        value.previous.next = null;
      value.previous = this;
    }
    this._next = value;
  }

  /**
   * Whether this FreeRecord is removed from the ggpk and should not be used anymore.
   */
  get isInvalid(): boolean {
    return this.length === 0;
  }

  /**
   * Standard constructor: reads from GGPK stream.
   * The 8-byte (length + tag) header has already been consumed by GGPK.ReadRecord.
   *
   * @param length - Length of the record (already read)
   * @param ggpk - GGPK which contains this record
   */
  constructor(length: number, ggpk: GGPK) {
    super(length, ggpk);
    this.offset = ggpk.position - 8n;
    this.nextFreeOffset = ggpk.readBigInt64();
    // Skip to end of record
    ggpk.seek(this.offset + BigInt(this.length));
  }

  /**
   * Create a FreeRecord at a known offset (without reading from stream).
   * The length must be set later via {@link updateLength}.
   *
   * @param offset - Offset of this FreeRecord
   * @param nextFreeOffset - Offset of next FreeRecord
   * @param ggpk - GGPK which contains this record
   */
  static createAt(offset: bigint, nextFreeOffset: bigint, ggpk: GGPK): FreeRecord {
    const record = Object.create(FreeRecord.prototype) as FreeRecord;
    // 手动初始化 BaseRecord 属性
    record.length = 0;
    record.ggpk = ggpk;
    record.offset = offset;
    record.nextFreeOffset = nextFreeOffset;
    record._next = undefined;
    record.previous = null;
    return record;
  }

  /**
   * Write the record data to the current position of GGPK.
   */
  writeRecordData(): void {
    if (this.length < 16)
      throw new RangeError(`FreeRecord length must be >= 16, got ${this.length}`);

    const ggpk = this.ggpk;
    this.offset = ggpk.position;
    ggpk.writeUInt32(this.length);
    ggpk.writeInt32(FreeRecord.Tag);
    ggpk.writeBigInt64(this.nextFreeOffset);
    // Seek to end of record (4+4+8 = 16 bytes written, skip the rest)
    ggpk.seek(this.offset + BigInt(this.length));
  }

  /**
   * Find index of this FreeRecord in the sorted list.
   * Returns -1 if invalid.
   */
  private getSortedIndex(): number {
    if (this.length === 0) return -1;

    const list = this.ggpk.sortedFreeRecords;
    if (!list) return -1;

    // Binary search by length
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = this.length - list[mid].length;
      if (cmp < 0) hi = mid - 1;
      else if (cmp > 0) lo = mid + 1;
      else {
        // Found equal length - find exact match
        // Search forward
        for (let i = mid; i < list.length && list[i].length === this.length; i++) {
          if (list[i] === this) return i;
        }
        // Search backward
        for (let i = mid - 1; i >= 0 && list[i].length === this.length; i--) {
          if (list[i] === this) return i;
        }
        return ~lo;
      }
    }
    return ~lo;
  }

  /**
   * Remove this FreeRecord from the linked FreeRecord list of ggpk.
   */
  removeFromList(): void {
    if (this.isInvalid) return;

    const ggpk = this.ggpk;
    const list = ggpk.sortedFreeRecords;

    // Remove from sorted list
    if (list) {
      const i = this.getSortedIndex();
      if (i >= 0) list.splice(i, 1);
    }

    // Fix linked list
    if (this.next === null) {
      if (this.previous === null) {
        if (ggpk.firstFreeRecord === this) {
          ggpk.writeBigInt64At(0n, ggpk.record.offset + 20n);
          ggpk.firstFreeRecord = null;
        }
      } else {
        ggpk.writeBigInt64At(0n, this.previous.offset + 4n);
        this.previous.next = null;
      }
    } else if (this.previous === null) {
      if (ggpk.record.firstFreeRecordOffset === this.offset) {
        ggpk.writeBigInt64At(this.next.offset, ggpk.record.offset + 20n);
        ggpk.firstFreeRecord = this.next;
      }
    } else {
      ggpk.writeBigInt64At(this.next.offset, this.previous.offset + 4n);
      this.previous.next = this.next;
    }

    // Mark as invalid
    this.length = 0;
  }

  /**
   * Update the link after the offset of this FreeRecord is changed.
   */
  updateOffset(): void {
    const ggpk = this.ggpk;
    if (this.isInvalid)
      throw new Error('The FreeRecord is invalid, it may have already been removed from the ggpk');

    if (this.previous === null) {
      // First in list
      const old = ggpk.firstFreeRecord;
      ggpk.writeBigInt64At(this.offset, ggpk.record.offset + 20n);
      ggpk.firstFreeRecord = this;
      if (old === this || old === null) return;

      // New inserted - link to old chain
      let last: FreeRecord = this;
      while (last.next !== null)
        last = last.next;
      ggpk.writeBigInt64At(old.offset, last.offset + 4n);
      last.next = old;
    } else {
      // Not first
      ggpk.writeBigInt64At(this.offset, this.previous.offset + 4n);
      this.previous.next = this;
    }
  }

  /**
   * Update the length of this FreeRecord and maintain sorted position.
   */
  updateLength(newLength: number): void {
    if (this.length === newLength) return;

    const list = this.ggpk.sortedFreeRecords;
    if (list) {
      // Find insertion point with new length
      let i = 0;
      while (i < list.length && list[i].length < newLength) i++;

      if (this.length !== 0) {
        const oi = this.getSortedIndex();
        if (oi >= 0) {
          if (newLength === 0) {
            // Becomes invalid
            list.splice(oi, 1);
          } else if (oi !== i) {
            // Move element
            const item = list.splice(oi, 1)[0];
            if (oi < i) i--;
            list.splice(i, 0, item);
          }
          this.length = newLength;
          return;
        }
      }
      list.splice(i, 0, this);
    }

    this.length = newLength;
  }
}
