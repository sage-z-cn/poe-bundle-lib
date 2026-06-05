# poe-bundle-lib

Path of Exile `*.bundle.bin` 文件操作库，[LibGGPK3/LibBundle3](https://github.com/aianlinb/LibGGPK3) 的 TypeScript 重写。

## 安装

```bash
npm install poe-bundle-lib
```

仅支持 Windows，需要 Node.js >= 20。需自行将 `oo2core.dll` 放到 `node_modules/poe-bundle-lib/libs/` 目录下。

## 用法

### 读取索引并提取文件

```ts
import { Index, ITreeNode } from 'poe-bundle-lib';

const index = new Index('path/to/Bundles2/_.index.bin');
const root = index.BuildTree();

// 提取整个目录到磁盘
Index.Extract(root, (file, data) => {
  if (data) console.log(file.Path, data.length);
  return false; // 返回 true 可取消
});
```

### 获取节点并替换文件

```ts
import { Index, ITreeNode } from 'poe-bundle-lib';

const index = new Index('path/to/Bundles2/_.index.bin');

// 按路径查找
Index.ReplaceFromDisk(index.Root, 'path/to/replacement/folder', (file, path) => {
  console.log('replaced:', file.Path, '<-', path);
  return false;
});

// 按条目替换（如 zip）
Index.ReplaceFromEntries(index, entries, (file, fullName) => {
  console.log('replaced:', file.Path);
  return false;
});
```

### 直接操作 Bundle

```ts
import { Bundle, BundleRecord } from 'poe-bundle-lib';

// 读取
const bundle = new Bundle('path/to/some.bundle.bin');
const data = bundle.Read();

// 修改并保存
const modified = Buffer.from('...');
bundle.Save(modified);
bundle.Dispose();
```

### 按路径哈希查找

```ts
const file = index.TryGetFile('Art/Textures/example.dds');
if (file) {
  const data = file.Read(); // Buffer
}
```

## 导出

| 子路径 | 内容 |
|--------|------|
| `poe-bundle-lib` | Index, Bundle, 节点, 记录 |
| `poe-bundle-lib/oodle` | Oodle 压缩/解压 API |
| `poe-bundle-lib/bundle` | Bundle 类 |
| `poe-bundle-lib/index` | Index 类 |
| `poe-bundle-lib/records` | BundleRecord, FileRecord |
| `poe-bundle-lib/nodes` | 树节点接口和实现 |

## License

MIT
