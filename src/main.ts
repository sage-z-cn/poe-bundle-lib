// Main entry point for lib-bundle3

// Oodle compression
export {
  Compress,
  Decompress,
  Initialize,
  Release,
  GetCompressedBufferSize,
  Settings as OodleSettings,
  Compressor,
  CompressionLevel,
} from './Oodle.js';

// Bundle
export { Bundle } from './Bundle.js';

// Records
export { BundleRecord } from './records/BundleRecord.js';
export { FileRecord } from './records/FileRecord.js';

// Index
export { Index } from './Index.js';

// Bundle factory
export type { IBundleFactory } from './IBundleFactory.js';
export { DriveBundleFactory } from './DriveBundleFactory.js';

// Nodes
export { ITreeNode } from './nodes/ITreeNode.js';
export { IDirectoryNode } from './nodes/IDirectoryNode.js';
export { IFileNode } from './nodes/IFileNode.js';
export { DirectoryNode } from './nodes/DirectoryNode.js';
export { FileNode } from './nodes/FileNode.js';

// GGPK
export { GGPK } from './ggpk/GGPK.js';
export { GGPKBrokenError } from './ggpk/GGPKBrokenError.js';
export { GGPKRecord } from './ggpk/records/GGPKRecord.js';
export { FreeRecord } from './ggpk/records/FreeRecord.js';
export { TreeNode } from './ggpk/records/TreeNode.js';
export { BaseRecord } from './ggpk/records/BaseRecord.js';

// Bundled GGPK
export { BundledGGPK } from './bundled/BundledGGPK.js';
export type { BundledGGPKOptions } from './bundled/BundledGGPK.js';
export { GGPKBundleFactory } from './bundled/GGPKBundleFactory.js';
