# poe-bundle-lib

Path of Exile `*.bundle.bin` / `Content.ggpk` 文件操作库，[LibGGPK3/LibBundle3](https://github.com/aianlinb/LibGGPK3) 的 TypeScript 重写。

## 安装

```bash
npm install poe-bundle-lib
```

仅支持 Windows，需要 Node.js >= 20。

额外需要`oo2core.dll`，本项目中不提供，需要手动放在以下任一位置，会自动加载：

- `<你的项目>/libs/oo2core.dll`
- `项目根目录/oo2core.dll`

## 用法

### _.index.bin 模式

适用于 `Bundles2/_.index.bin` + `*.bundle.bin` 文件结构。

```ts
import { Index, FileRecord } from 'poe-bundle-lib';

const index = new Index('path/to/Bundles2/_.index.bin', { parsePaths: false });

// 解析文件路径（hash → 实际路径）
index.ParsePaths();

// 遍历所有文件
for (const [, fileRecord] of index.Files) {
  if (fileRecord.Path === 'metadata/ui/uisettings.xml') {
    const data = fileRecord.Read();  // Buffer
    const modified = Buffer.from('...');
    fileRecord.Write(modified);
  }
}

// 持久化修改
index.Save();
index.Dispose();
```

### Content.ggpk 模式

根据 GGPK 内部是否含 `Bundles2/` 目录，选择不同入口。

#### Bundled GGPK（内含 Bundles2/_.index.bin）

```ts
import { BundledGGPK, FileRecord } from 'poe-bundle-lib';

const ggpk = new BundledGGPK('path/to/Content.ggpk', false);

// 通过 Index 操作文件
const file = ggpk.Index.TryGetFile('metadata/ui/uisettings.xml');
if (file) {
  const data = file.Read();
  file.Write(Buffer.from('...'));
}

// 保存并释放
ggpk.Index.Save();
ggpk.Dispose();  // 自动 write index back to GGPK + renewHashes
```

#### 纯 GGPK（不含 Bundles2）

```ts
import { GGPK, TreeNode } from 'poe-bundle-lib';

const ggpk = new GGPK('path/to/Content.ggpk');

// 遍历 GGPK 文件树
for (const [file, relPath] of TreeNode.recurseFiles(ggpk.root)) {
  if (relPath === 'metadata/ui/uisettings.xml') {
    const data = file.read();    // 小写
    file.write(Buffer.from('...'));
  }
}

// 释放（自动 renewHashes + flush）
ggpk.dispose();
```

### 安装补丁

```ts
import { Index } from 'poe-bundle-lib';
import AdmZip from 'adm-zip';

const index = new Index('Bundles2/_.index.bin', { parsePaths: false });
const zip = new AdmZip('patch.zip');

const entries = zip.getEntries().map(e => ({
  fullName: e.entryName,
  getData: () => e.getData(),
}));

// 从 zip 条目替换文件，默认自动 Save
Index.ReplaceFromEntries(index, entries, (file, name) => {
  console.log('replaced:', name);
  return false;
});
```

对于 GGPK 格式：

```ts
import { GGPK } from 'poe-bundle-lib';

const ggpk = new GGPK('Content.ggpk');
const entries = zip.getEntries().map(e => ({
  fullName: e.entryName,
  getData: () => e.getData(),
}));

GGPK.replaceFromZipEntries(ggpk.root, entries, (file, name, added) => {
  console.log(added ? 'added:' : 'replaced:', name);
  return false;
}, true); // allowAdd
```

### Oodle 压缩

```ts
import { Initialize, Settings, Compressor, Compress, Decompress, Release } from 'poe-bundle-lib/oodle';

Initialize(new Settings({
  chunkSize: 256 * 1024,
  compressor: Compressor.Mermaid,
}));

const { compressedSize, output } = Compress(inputBuffer);
const decompressed = Decompress(output, Buffer.alloc(uncompressedSize));
```

## 导出

| 子路径 | 内容 |
|--------|------|
| `poe-bundle-lib` | Index, Bundle, BundledGGPK, GGPK, GGPKRecord, TreeNode, FileRecord, BundleRecord, DriveBundleFactory, 节点类 |
| `poe-bundle-lib/oodle` | Initialize, Compress, Decompress, Release, Settings, Compressor, CompressionLevel |
| `poe-bundle-lib/bundle` | Bundle 类 |
| `poe-bundle-lib/index` | Index 类 |
| `poe-bundle-lib/records` | BundleRecord, FileRecord（Index 用） |
| `poe-bundle-lib/nodes` | ITreeNode, IDirectoryNode, IFileNode, DirectoryNode, FileNode |
| `poe-bundle-lib/ggpk` | GGPK 类 |
| `poe-bundle-lib/ggpk/records` | GGPKRecord, DirectoryRecord, FileRecord, FreeRecord, TreeNode, BaseRecord |
| `poe-bundle-lib/bundled` | BundledGGPK, GGPKBundleFactory |

## 注意事项

- **大小写**：Index 的 `FileRecord` 使用 `Read()` / `Write()`（大写），GGPK 的 `FileRecord` 使用 `read()` / `write()`（小写）
- **保存**：Index 模式必须显式调用 `Save()`，GGPK 模式写入即时生效，`dispose()` 自动 `renewHashes()`
- **BundledGGPK**：`Dispose()` 自动将修改写回 GGPK 内的 `_.index.bin`
- **GGPK 空闲空间**：`firstFreeRecordOffset` 损坏时自动重置为空链表，新数据追加到文件末尾
- **哈希保护**：`renewHashes()` 默认不更新 root 及直接子目录的哈希，避免游戏检测到修改后回滚

## License

MIT
