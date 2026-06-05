import fs from 'node:fs';
import path from 'node:path';
import { IBundleFactory } from './IBundleFactory.js';
import { Bundle } from './Bundle.js';
import type { BundleRecord } from './records/BundleRecord.js';

/**
 * File system-based bundle factory.
 */
export class DriveBundleFactory extends IBundleFactory {
  BaseDirectory: string;

  /**
   * @param baseDirectory - Path to "Bundles2" directory
   */
  constructor(baseDirectory: string) {
    super();
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
    // Create empty file and return buffer
    fs.writeFileSync(fullPath, Buffer.alloc(0));
    return Buffer.alloc(60); // Empty header-sized buffer
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
