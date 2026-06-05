import { ITreeNode } from './ITreeNode.js';
import type { FileRecord } from '../records/FileRecord.js';

/**
 * File node interface - extends ITreeNode with a Record reference.
 */
export class IFileNode extends ITreeNode {
  Record!: FileRecord;
}
