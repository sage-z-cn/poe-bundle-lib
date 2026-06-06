import type { GGPK } from '../GGPK.js';

/**
 * Base type of all records in GGPK.
 */
export abstract class BaseRecord {
  /**
   * GGPK which contains this record.
   */
  ggpk: GGPK;

  /**
   * Offset in pack file where record begins (including the 8-byte length+tag header).
   */
  offset: bigint = 0n;

  /**
   * Length of the entire record in bytes.
   * @remarks If you're looking for the file length, {@link FileRecord.dataLength} may be what you want.
   */
  length: number;

  /**
   * @param length - Length of the entire record in bytes
   * @param ggpk - GGPK which contains this record
   */
  constructor(length: number, ggpk: GGPK) {
    this.length = length;
    this.ggpk = ggpk;
  }

  /**
   * Write the record data to the current position of GGPK stream,
   * this method must set {@link offset} to where the record begins.
   */
  abstract writeRecordData(): void;

  /**
   * For sorting FreeRecords by {@link length}.
   */
  static lengthComparer(a: BaseRecord, b: BaseRecord): number {
    return a.length - b.length;
  }

  /**
   * For sorting records by {@link offset}.
   */
  static offsetComparer(a: BaseRecord, b: BaseRecord): number {
    if (a.offset < b.offset) return -1;
    if (a.offset > b.offset) return 1;
    return 0;
  }
}
