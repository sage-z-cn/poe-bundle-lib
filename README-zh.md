# poe-bundle-lib

[English](https://github.com/sage-z-cn/poe-bundle-lib/blob/master/README.md)

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

### DDS 贴图编辑

直接编辑 DDS 贴图，例如给地图图标添加文字。未压缩 `R8G8B8A8` 格式的编辑是无损的（其余 mip 级由编辑后的 mip0 经 2x2 box 下采样重建）：

```ts
import { AddText } from 'poe-bundle-lib/dds';
import { readFileSync, writeFileSync } from 'node:fs';

// 编辑磁盘上的 DDS 文件
const dds = readFileSync('map1.dds');
const edited = AddText(dds, {
  text: '测试',          // 支持 CJK，'\n' 多行
  // 定位（全部支持像素数字或 'N%' 百分比字符串）：
  right: '5%',          // CSS 式锚定：文字块右边缘 = 宽度 - 5%
  bottom: '5%',         // 文字块下边缘 = 高度 - 5%
  // left / top 同理（文字块左/上边缘锚定），如左上角：left: 8, top: 8
  // x: 8, y: 8,        // 绝对定位：文字绘制起点（与 left/top 等价）
  fontSize: '20%',      // 像素数字、图像高度百分比，或 'auto'
                        // （'auto' = 自动选取不超出图片的最大字号）
  // center: 'both',     // 可选：文字块居中（'horizontal'/'vertical' 可与
  //                     // 另一轴的边距锚定组合，如 center 'horizontal' + bottom '5%'）
  // 同轴优先级：left > right > x（默认 0），top > bottom > y（默认 0）
  font: 'Microsoft YaHei',  // 可选，默认字体
  color: 0xFF0000FF,    // 0xRRGGBBAA，默认不透明白色
  bold: false,          // 可选
  regenerateMips: true, // 可选，编辑后重建 mip 1..n
});
writeFileSync('map1-out.dds', edited);
```

也可以一次传入多组文字（数组）——按顺序绘制在同一画布上（后画的覆盖先画的，
允许重叠；每组的定位与 'auto' 预算各自相对全图独立解算）：

```ts
const edited = AddText(dds, [
  { text: '左上', left: 5, top: 5, fontSize: 16, color: 0xFF0000FF },
  { text: '右下', right: '5%', bottom: '5%', fontSize: '16%', color: 0x00FF00FF },
  { text: '居中', center: 'both', fontSize: 'auto', color: 0xFFFF00FF },
]);
```

也可以直接写回游戏 bundle：

```ts
import { AddText } from 'poe-bundle-lib/dds';

const file = index.TryGetFile('Art/Textures/map1.dds');
if (file) {
  // x/y（像素起点）与 left/right/top/bottom（百分比）可互换使用
  file.Write(AddText(file.Read(), { text: '测试', x: 8, y: 8, fontSize: 16, color: 0xFF0000FF }));
}
index.Save();  // 持久化修改
```

同时也导出底层模块：`DdsImage`（解析 DDS/DX10 头、解码 mip 为 RGBA）、`RgbaSurface`（像素访问 + `toPng()` 预览导出）、`applyText`、`downsample2x2`。

命令行示例：

```bash
# 查看 DDS 格式 / mip 布局，可选导出某级 mip 为 PNG
node examples/dds-inspect.mjs map1.dds --png 0

# 添加文字并输出新 DDS，--png 另存预览图
node examples/dds-add-text.mjs map1.dds out.dds "测试" 8 8 16 --color 0xFF0000FF --png

# CSS 式锚定（右下角，20% 字号）
node examples/dds-add-text.mjs map1.dds out.dds "测试" --right 5% --bottom 5% --fontSize 20% --png
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
| `poe-bundle-lib/dds` | AddText, applyText, AddTextOptions, AddTextInput, resolveTextLayout, DdsImage, DdsFormat, RgbaSurface, downsample2x2, BC1/BC2/BC3 解码器 |

## 注意事项

- **大小写**：Index 的 `FileRecord` 使用 `Read()` / `Write()`（大写），GGPK 的 `FileRecord` 使用 `read()` / `write()`（小写）
- **保存**：Index 模式必须显式调用 `Save()`，GGPK 模式写入即时生效，`dispose()` 自动 `renewHashes()`
- **BundledGGPK**：`Dispose()` 自动将修改写回 GGPK 内的 `_.index.bin`
- **GGPK 空闲空间**：`firstFreeRecordOffset` 损坏时自动重置为空链表，新数据追加到文件末尾
- **哈希保护**：`renewHashes()` 默认不更新 root 及直接子目录的哈希，避免游戏检测到修改后回滚
- **DDS 编辑**：仅支持编辑未压缩 `R8G8B8A8` 的 DDS（BC1/BC2/BC3 仅可解码/查看，BC4-BC7 不支持）；cubemap、3D 纹理和纹理数组会被解析器拒绝。canvas 预乘 alpha 会使半透明像素产生 ±1 舍入（完全不透明像素无损）。依赖 `@napi-rs/canvas`（已作为依赖安装，含 Windows 二进制）

## License

MIT
