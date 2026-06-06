import { BaseRecord } from './BaseRecord.js';
import type { GGPK } from '../GGPK.js';

/**
 * GGPK record is the very first record and exists at the very beginning of the GGPK file.
 * Tag = "GGPK" (0x4B504747 in little-endian).
 */
export class GGPKRecord extends BaseRecord {
  /** "GGPK" tag */
  static readonly Tag = 0x4B504747;

  /**
   * 3 for PC, 4 for Mac, 2 for game-version before 3.11.2 which has no bundle in ggpk.
   */
  ggpkVersion: number;

  /**
   * Offset of the root DirectoryRecord.
   */
  rootDirectoryOffset: bigint;

  /**
   * Offset of the first FreeRecord in the linked-list.
   */
  firstFreeRecordOffset: bigint;

  /**
   * Read a GGPKRecord from the GGPK stream.
   * The 8-byte (length + tag) header has already been consumed by GGPK.ReadRecord.
   *
   * @param length - Length of the record (already read from the 8-byte header)
   * @param ggpk - GGPK which contains this record
   */
  constructor(length: number, ggpk: GGPK) {
    super(length, ggpk);
    const pos = ggpk.position;
    this.offset = pos - 8n;
    this.ggpkVersion = ggpk.readUInt32(); // 3 for PC, 4 for Mac
    this.rootDirectoryOffset = ggpk.readBigInt64();
    this.firstFreeRecordOffset = ggpk.readBigInt64();
  }

  /**
   * Write the record data to the current position of GGPK.
   */
  writeRecordData(): void {
    const ggpk = this.ggpk;
    this.offset = ggpk.position;
    ggpk.writeUInt32(this.length); // 28
    ggpk.writeInt32(GGPKRecord.Tag);
    ggpk.writeUInt32(this.ggpkVersion); // 3 for PC, 4 for Mac
    ggpk.writeBigInt64(this.rootDirectoryOffset);
    ggpk.writeBigInt64(this.firstFreeRecordOffset);
  }
}
