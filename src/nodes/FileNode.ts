import { IFileNode } from './IFileNode.js';
import type { IDirectoryNode } from './IDirectoryNode.js';
import type { DirectoryNode } from './DirectoryNode.js';
import type { FileRecord } from '../records/FileRecord.js';
import path from 'node:path';

/**
 * File tree node implementation - wraps FileRecord.
 */
export class FileNode extends IFileNode {
  declare Name: string;
  declare Parent: DirectoryNode;
  declare Record: FileRecord;

  constructor(record: FileRecord, parent: IDirectoryNode) {
    super();
    this.Name = path.posix.basename(record.Path!);
    this.Parent = parent as DirectoryNode;
    this.Record = record;
  }

  /**
   * Factory method for Index.BuildTree.
   */
  static CreateInstance(record: FileRecord, parent: IDirectoryNode): IFileNode {
    return new FileNode(record, parent);
  }
}
