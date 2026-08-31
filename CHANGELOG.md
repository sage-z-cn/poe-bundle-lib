# Changelog

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本管理遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

#### 1.4.0
**Bug Fixes**

- **Oodle**: skip asar paths when locating `oo2core.dll` and fall through to the next candidate when a DLL load fails, so compression still works when packaged inside an asar archive
- **GGPK**: write free-list pointers to the correct offset and tolerate broken free-list links instead of failing on damaged files
- **Index**: fix custom bundle writeback being skipped during index flush, preventing custom-prefixed bundles from losing persisted data

**Improvements**

- **DDS**: `@napi-rs/canvas` is now an optional, lazily loaded dependency — it is only required when using PNG preview/overlay features, reducing install size and startup cost for library consumers

## [1.3.2] - 2026-08-17

### 修复

- `Bundle.createEmpty()` 未初始化 `filePath`（`undefined`），`HasFilePath` 用 `!== null` 判断时误将新建 custom bundle 当作磁盘已有文件，`FlushBundleToWrite()` 因此跳过真正的数据持久化——首次写入与 `MaxBundleSize` 切分都会生成仅 60 字节空头的损坏 bundle，重新打开读取失败（1.3.1 的致命写回回归）。现补上 `filePath = null` 初始化，并将 `HasFilePath` 判断改为 `!= null` 双重防御 `undefined`

### 新增

- `BundledGGPK` 构造器新增第三参数 `options`（类型 `BundledGGPKOptions`，已从主入口导出），将 `customBundleBasePath` 透传给内部 `Index`——GGPK 内已有的 `TinyBundle/` 等自定义前缀 bundle 现在能被正确识别与复用（原有两参调用完全兼容）
- 写回回归测试 `test/index-writeback.test.mjs`：从零构造最小 Bundles2 夹具，覆盖首次写入持久化、`MaxBundleSize` 强制切分、`customBundleBasePath` 复用 TinyBundle 三个场景（纳入 `npm test`）
- 真实客户端测试 `test/real-client.test.mjs`（`npm run test:real`）：对国服客户端 `_.index.bin` 副本执行写入 / 切分 / 重开校验（119 万文件全路径解析、1993 条未改动记录逐字段比对），并三重校验（size + mtime + SHA-256）原始文件未被改动；客户端不存在时 SKIP

### 变更

- `test/dds.test.mjs`：自动创建 `%TEMP%\opencode` 输出目录（干净环境不再失败），PNG 预览全部改写入该目录，不再污染仓库根目录

## [1.3.1] - 2026-08-14

### 修复

- `FileRecord.Write` 累计待写数据超过 `MaxBundleSize`（默认 200MB）自动切分 Bundle 时只压缩了内存 Bundle、未持久化，导致最终 `Index.Save()` 写出的索引引用从未落盘的数据，生成损坏补丁。现将该逻辑抽为 `Index.FlushBundleToWrite()`（压缩 + 通过工厂持久化到磁盘 / GGPK），切分路径与 `Save()` 路径复用同一实现
- `BundledGGPK.Dispose()` 即使只读会话也会把整个 `_.index.bin` 写回 GGPK。新增 `Index.Dirty` / `Index.MarkClean()` 脏标记（由 `FileRecord.Write` / `Redirect` 置位），`saveIndex()` 仅在索引被修改时写回；`Index.Save()` 清理空 custom bundle 后同样置位，保证清理结果不丢失
- 复用磁盘上已有 custom bundle 切分时，`Bundle.Save()` 内部已写文件、工厂分支再写一次相同内容，200MB 级数据双写。新增 `Bundle.HasFilePath`，有文件背书时跳过工厂写入

### 新增

- 自定义 Bundle 路径前缀可配置：模块常量改为实例属性 `Index.CustomBundleBasePath`（默认 `LibGGPK3/`，与 C# 原版 LibBundle3 一致），支持构造选项 `customBundleBasePath`；setter 自动补尾部 `/`，空值重置为默认。构造后修改仅影响后续匹配与新 bundle 命名，不重扫已有记录

## [1.3.0] - 2026-08-14

### 新增

- DDS 贴图编辑子模块 `poe-bundle-lib/dds`
  - `AddText` 高层 API：为未压缩 `R8G8B8A8` DDS 添加文字（起始位置、字号、字体、颜色 0xRRGGBBAA、加粗、多行 `\n` 支持）
  - CSS 式定位：`left`/`right`/`top`/`bottom` 锚定文字块边缘（优先级 left > right > x、top > bottom > y）；定位值与 `fontSize` 支持像素数字或 `'N%'` 百分比（相对图像宽/高），无需关心图片尺寸；`resolveTextLayout` 纯函数可独立测试
  - `fontSize: 'auto'` 自适应字号：二分求解让文字块（最长行 x 行数）恰好落入定位边距所留可用区域的最大字号（>= 1px，0.5px 精度），文字再长也不会超出图片
  - `center: 'both' | 'horizontal' | 'vertical'` 居中：覆盖对应轴的锚定值（可与另一轴组合，如水平居中 + 底部锚定）；与 `'auto'` 字号组合时居中轴预算取全长
  - 多组文字：`applyText` / `AddText` 的 options 支持 `AddTextOptions[]` 数组（导出 `AddTextInput` 联合类型），按顺序绘制在同一画布上，后画覆盖先画、允许重叠，每组定位/居中/'auto' 字号独立解算；CLI 用可重复的 `--text` 分组
  - 真多行渲染：按 `\n` 拆行逐行绘制，行高取 `fontBoundingBoxAscent + Descent`，`right`/`bottom` 锚定时先测量文字块整体宽高再定位
  - `DdsImage`：DDS/DX10 头解析与格式识别（fourCC / DXGI / bit mask 三种路径）、mip 布局计算、`inspect()` 摘要、`decodeMip()` 解码
  - BC1 (DXT1) / BC2 (DXT3) / BC3 (DXT5) 纯 TS 块解码器（含 punchthrough 透明、显式 alpha、BC4 式 alpha 插值）
  - `RgbaSurface` 像素面：像素访问、`toPng()` 预览导出、`downsample2x2` 盒式下采样
  - `writeMipPixels`：RGBA→BGRA 无损写回 + 由编辑后 mip0 重建整条 mip 链
  - 命令行示例：`examples/dds-inspect.mjs`（格式侦察/预览导出）、`examples/dds-add-text.mjs`（加文字）
- 新增依赖 `@napi-rs/canvas`（文字栅格化与 PNG 导出，含 Windows 预编译二进制）

### 说明

- BC1/BC2/BC3 仅支持解码与查看，编辑回写暂不支持（抛出 'not supported yet'）；BC4-BC7 暂不支持
- cubemap、3D 纹理、纹理数组会被解析器拒绝
- canvas 预乘 alpha 对半透明像素有 ±1 舍入（完全不透明像素无损）

## [1.2.0]

- `_.index.bin` 读取与写入、分块 Oodle 压缩 bundle 读写
- `DriveBundleFactory` 磁盘文件系统实现
- 文件树节点（`nodes/`）与哈希算法自动检测（MurmurHash64A / FNV1a64Hash）
- `Index.ReplaceFromEntries` / `Index.ReplaceFromDisk` 批量替换

## [1.0.x]

- 初始版本：`Bundle`、`Index`、Oodle FFI 封装（koffi + oo2core.dll）
