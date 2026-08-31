# AGENTS.md

TypeScript 重写的 Path of Exile `*.bundle.bin` / `Content.ggpk` 文件操作库。

## 平台与运行

- **仅 Windows**（`package.json` `"os": ["win32"]`），Node.js >= 20
- `oo2core.dll`（Oodle 压缩库）**必须存在**。搜索逻辑（`Oodle.ts` `loadLibrary`）：
  - 候选目录依次为：包根 `libs/` → `cwd/libs/` → `cwd` → Electron `resourcesPath`（含其 `libs/`） → Node/Electron exe 目录，最后按裸名走 OS 搜索路径
  - **asar 内路径自动跳过**：`fs.existsSync` 在 Electron patched fs 下对 asar 虚拟文件返回 true，但系统 LoadLibrary 读不了 asar——含 `app.asar` 的候选会自动映射到 `app.asar.unpacked`，映射不存在则跳过
  - 单个候选 `koffi.load` 失败（损坏/架构不符）时**继续尝试下一候选**，不会中断
- 构建：`npm run build`（仅 `tsc`），输出到 `dist/`
- 测试：`npm test`（合成 index 写回 + dds 往返两组用例）；`npm run test:real` 需真实客户端文件

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
├── dds/                  # DDS 纹理解码/文字叠加（@napi-rs/canvas 可选依赖，惰性加载）
└── main.ts               # 统一导出入口（不含 dds，经 "poe-bundle-lib/dds" 子路径导出）
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
- **FreeRecord 磁盘布局**：`[length:4][tag:4][nextFreeOffset:8]`——next 指针位于 **offset+8**（不是 +4）。曾因移植笔误写到 +4（tag 字段），导致当次会话正常、下次打开报 `Invalid record tag`
- **链表损坏容错**：头节点或后续节点懒加载失败（第三方补丁工具写坏的 GGPK 常见）时，视链表到此结束并把修复持久化写回磁盘，不抛错；丢失的尾部空闲空间只是无法复用的空洞，不影响文件树
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

### dds 与 @napi-rs/canvas（可选依赖）

`@napi-rs/canvas`（~37MB 多平台二进制）仅 dds 功能需要，已从 `dependencies` 移到 `devDependencies`（保留编译期类型）：`dds/RgbaSurface.ts`、`dds/TextLayer.ts` 通过 `createRequire` **惰性加载**，未安装时首次调用抛出带安装指引的错误。不使用 dds 的消费者（如 POE Bench 打包）不会把它带进产物。

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
