# AGENTS.md

TypeScript 重写的 Path of Exile `*.bundle.bin` / `Content.ggpk` 文件操作库。

## 平台与运行

- **仅 Windows**（`package.json` `"os": ["win32"]`），Node.js >= 20
- `oo2core.dll`（Oodle 压缩库）**必须存在**，搜索顺序：`libs/`（包根目录）→ `cwd/libs/` → `cwd` → 系统 PATH → Node.exe 目录
- 构建：`npm run build`（仅 `tsc`），输出到 `dist/`
- 无测试、无 linter、无 CI

## 架构

```
src/
├── Oodle.ts              # koffi FFI 封装原生 Oodle 压缩/解压
├── Bundle.ts             # *.bundle.bin 读写（60 字节头 + 分块 Oodle 压缩）
├── Index.ts              # _.index.bin 解析（BundleRecord/FileRecord/DirectoryRecord + 哈希函数）
├── records/
│   ├── BundleRecord.ts   # bundle 条目（Path, UncompressedSize, BundleIndex）
│   └── FileRecord.ts     # 文件条目（PathHash, BundleRecord, Offset, Size → Read/Write）
├── nodes/                # 文件树（ITreeNode, DirectoryNode, FileNode）
├── IBundleFactory.ts     # bundle 访问工厂接口
├── DriveBundleFactory.ts # 磁盘文件系统实现（读写 Bundles2/ 目录）
├── ggpk/                 # Content.ggpk 格式（GGPK → DirectoryRecord → FileRecord → FreeRecord）
├── bundled/              # BundledGGPK：GGPK + Index 一体化，bundle 数据直接存 GGPK 内部
└── main.ts               # 统一导出入口
```

## 关键细节

### ESM 与导入

`"type": "module"`，`moduleResolution: "NodeNext"`。源文件中导入必须带 `.js` 扩展名：

```ts
import { Bundle } from './Bundle.js';  // 正确，即使源文件是 .ts
import { Bundle } from './Bundle';     // 错误
```

### Oodle 生命周期

```ts
import { Initialize, Settings, Compress, Decompress, Release } from 'poe-bundle-lib/oodle';
Initialize(new Settings({ chunkSize: 256 * 1024, compressor: Compressor.Leviathan }));
// ... 使用 Compress/Decompress ...
Release();  // 释放预分配内存
```

`Initialize` 必须在使用任何压缩/解压函数前调用。`Bundle.readChunks()` 内部自动调用 `Initialize`。

### Index 生命周期

```ts
const index = new Index('Bundles2/_.index.bin');  // 自动 ParsePaths()
const file = index.TryGetFile('Art/Textures/example.dds');
// ... 修改文件 ...
index.Save();   // 必须调用，否则 Dispose 会 warn
index.Dispose();
```

- 构造函数默认 `parsePaths: true`，会立即解析文件路径
- `Save()` 序列化全部记录并写回 `_.index.bin`，同时删除空 custom bundle
- `Dispose()` 前未 `Save()` → 控制台警告

### Bundle 写入流程（FileRecord.Write）

FileRecord 写入是批量延迟的：
1. `Write()` 调用 `Index.GetBundleToWrite()` 获取或创建 `LibGGPK3/N` custom bundle
2. 数据追加到 `_BundleStreamToWrite`（内存缓冲区）
3. 缓冲区满（>= `MaxBundleSize`，默认 200MB）时自动 `Save()`
4. **最终必须调用 `Index.Save()`** 持久化所有变更

### GGPK（Content.ggpk）操作

```ts
const ggpk = new GGPK('Content.ggpk');       // fs.openSync('r+'), 解析 FD
const root = ggpk.root;                      // DirectoryRecord
ggpk.renewHashes();                          // 更新目录 SHA-256 哈希
ggpk.dispose();                              // 自动 renewHashes() + flush + close
```

- 基于**文件描述符**的随机访问 I/O（`fs.readSync`/`fs.writeSync`），不是 Stream
- `dispose()` 自动调用 `renewHashes()`（但**跳过 root 及其直接子目录**，避免触发游戏补丁检查）
- 空闲空间管理：FreeRecord 链表 + `findBestFreeRecord()` + `fastCompact()`
- 记录标签：GGPK (0x4B504747), PDIR (0x52494450), FILE (0x454C4946), FREE (0x45455246)

### BundledGGPK

继承 GGPK，构造时自动在 GGPK 内定位 `Bundles2/_.index.bin` 并创建 Index：

```ts
const ggpk = new BundledGGPK('Content.ggpk', false); // parsePaths 延迟
const file = ggpk.Index.TryGetFile('Metadata/StatDescriptions.dat');
ggpk.Dispose();  // 自动 saveIndex() + Index.Dispose() + GGPK.dispose()
```

### MurmurHash64A 与 FNV1a64Hash

Index 通过第一个目录的 `PathHash` 值自动检测哈希算法：
- `0xF42A94E69CFF42FEn` → MurmurHash64A（新版，**先转小写**）
- `0x07E47507B4A92E53n` → FNV1a64Hash（旧版）

### 命名约定

- 类/枚举：`PascalCase`；方法/属性：`camelCase`
- 内部字段前缀 `_`：`_Path`, `_Files`, `_Bundles`, `_BundleToWrite`, `_fd`
- Bundle.ts 使用 `private` 前缀命名：`privateHeader`
- 类型鸭子判断：代码中多处用 `'Record' in node`、`'dataLength' in record` 代替 `instanceof`

### 注意事项

- `FileRecord.Read()` 可能调用 `bundle.Dispose()`，生命周期由调用方管理
- Bundle header 保留多个 `unknown` 字段（`unknown`, `unknown3-6`），来自 C# 原版
- `Bundle.Save()` 传 `Compressor.Invalid` 保持现有压缩器不变
- `Index.ReplaceFromEntries` 和 `Index.ReplaceFromDisk` 在 `count > 0` 时默认自动 `saveIndex`
- GGPK `DirectoryRecord` 中的文件路径以 `/` 分隔，根节点没有 name
