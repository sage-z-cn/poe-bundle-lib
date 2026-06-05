import fs from 'node:fs';
import path from 'node:path';
import { IBundleFactory } from './IBundleFactory.js';
import { Bundle } from './Bundle.js';
import type { BundleRecord } from './records/BundleRecord.js';

/**
 * File system-based bundle factory.
 */
export class DriveBundleFactory implements IBundleFactory {
  BaseDirectory: string;

  /**
   * @param baseDirectory - Path to "Bundles2" directory
   */
  constructor(baseDirectory: string) {
    this.BaseDirectory = path.resolve(baseDirectory);
    if (!this.BaseDirectory.endsWith(path.sep)) {
      this.BaseDirectory += path.sep;
    }
  }

  GetBundle(record: BundleRecord): Bundle {
    return new Bundle(this.BaseDirectory + record.Path, record);
  }

  CreateBundle(bundlePath: string): Buffer {
    const fullPath = this.BaseDirectory + bundlePath;
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Write a valid empty bundle header (60 bytes) with proper defaults
    const header = Buffer.alloc(60);
    header.writeInt32LE(48, 8);          // headSize
    header.writeInt32LE(13, 12);         // compressor = Leviathan
    header.writeInt32LE(1, 16);          // unknown
    header.writeInt32LE(256 * 1024, 40); // chunkSize = 256KB
    fs.writeFileSync(fullPath, header);
    return header;
  }

  DeleteBundle(bundlePath: string): boolean {
    const fullPath = this.BaseDirectory + bundlePath;
    if (!fs.existsSync(fullPath)) return false;
    fs.unlinkSync(fullPath);

    // Remove empty parent directories
    let dir = path.dirname(fullPath);
    while (dir !== this.BaseDirectory && dir.length > this.BaseDirectory.length) {
      try {
        const entries = fs.readdirSync(dir);
        if (entries.length === 0) {
          fs.rmdirSync(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    return true;
  }
}
