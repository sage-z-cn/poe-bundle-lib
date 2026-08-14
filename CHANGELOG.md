# Changelog

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本管理遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

### 修复

- DDS DX10 扩展头的未压缩格式沿用 legacy 空 mask 导致解码死循环的问题（现回退到标准 R8G8B8A8 mask 布局）

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
