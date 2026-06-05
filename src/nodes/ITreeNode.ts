import type { IDirectoryNode } from './IDirectoryNode.js';
import { IFileNode } from './IFileNode.js';

/**
 * Base tree node interface.
 * Do not implement this directly - use IDirectoryNode or IFileNode instead.
 */
export class ITreeNode {
  Parent: IDirectoryNode | null = null;
  Name: string = '';

  /**
   * Get the absolute path of a node in the tree.
   * Ends with '/' if the node is an IDirectoryNode.
   */
  static GetPath(node: ITreeNode): string {
    if (node instanceof IFileNode || ('Record' in node && node.Record !== undefined)) {
      return (node as IFileNode).Record.Path!;
    }
    const parts: string[] = [];
    let current: ITreeNode = node;
    while (current.Parent !== null) {
      parts.unshift(current.Name);
      current = current.Parent;
    }
    // DirectoryNode paths end with /
    return parts.join('/') + '/';
  }

  /**
   * Recurse all nodes under a node (include self).
   */
  static *RecurseTree(node: ITreeNode): Generator<ITreeNode> {
    yield node;
    if ('Children' in node && node.Children) {
      for (const child of (node as IDirectoryNode).Children) {
        yield* ITreeNode.RecurseTree(child);
      }
    }
  }
}
