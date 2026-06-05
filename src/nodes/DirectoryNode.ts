import { IDirectoryNode } from './IDirectoryNode.js';
import type { IFileNode } from './IFileNode.js';
import type { ITreeNode } from './ITreeNode.js';

/**
 * Directory tree node implementation.
 */
export class DirectoryNode extends IDirectoryNode {
  declare Name: string;
  declare Parent: DirectoryNode | null;
  declare Children: ITreeNode[];

  constructor(name: string, parent: DirectoryNode | null) {
    super();
    this.Name = name;
    this.Parent = parent;
    this.Children = [];
  }

  /**
   * Get child by name (binary search, case-insensitive).
   */
  getChild(name: string): ITreeNode | null {
    let lo = 0;
    let hi = this.Children.length - 1;
    while (lo <= hi) {
      const i = (lo + hi) >>> 1;
      const node = this.Children[i];
      const c = name.localeCompare(node.Name, undefined, { sensitivity: 'base' });
      if (c === 0) return node;
      else if (c > 0) lo = i + 1;
      else hi = i - 1;
    }
    return null;
  }

  /**
   * Factory method for Index.BuildTree.
   */
  static CreateInstance(name: string, parent: IDirectoryNode | null): IDirectoryNode {
    return new DirectoryNode(name, parent instanceof DirectoryNode ? parent : null);
  }
}
