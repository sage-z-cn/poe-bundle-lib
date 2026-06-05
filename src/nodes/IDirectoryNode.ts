import { ITreeNode } from './ITreeNode.js';

/**
 * Directory node interface - extends ITreeNode with Children.
 */
export class IDirectoryNode extends ITreeNode {
  /**
   * Child nodes, ordered by Name.
   */
  Children: ITreeNode[] = [];

  /**
   * Get a child node by name using binary search.
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
}
