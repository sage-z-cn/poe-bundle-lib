# poe-bundle-lib

[中文文档](https://github.com/sage-z-cn/poe-bundle-lib/blob/master/README-zh.md)

A TypeScript library for manipulating Path of Exile `*.bundle.bin` / `Content.ggpk` files, rewritten from [LibGGPK3/LibBundle3](https://github.com/aianlinb/LibGGPK3).

## Installation

```bash
npm install poe-bundle-lib
```

Windows only, requires Node.js >= 20.

Additionally, `oo2core.dll` is required but not included in this package. Place it in one of the following locations and it will be loaded automatically:

- `<your-project>/libs/oo2core.dll`
- `<project-root>/oo2core.dll`

## Usage

### _.index.bin Mode

For `Bundles2/_.index.bin` + `*.bundle.bin` file structures.

```ts
import { Index, FileRecord } from 'poe-bundle-lib';

const index = new Index('path/to/Bundles2/_.index.bin', { parsePaths: false });

// Parse file paths (hash → actual path)
index.ParsePaths();

// Iterate all files
for (const [, fileRecord] of index.Files) {
  if (fileRecord.Path === 'metadata/ui/uisettings.xml') {
    const data = fileRecord.Read();  // Buffer
    const modified = Buffer.from('...');
    fileRecord.Write(modified);
  }
}

// Persist changes
index.Save();
index.Dispose();
```

### Content.ggpk Mode

Choose a different entry point depending on whether the GGPK contains a `Bundles2/` directory.

#### Bundled GGPK (contains Bundles2/_.index.bin)

```ts
import { BundledGGPK, FileRecord } from 'poe-bundle-lib';

const ggpk = new BundledGGPK('path/to/Content.ggpk', false);

// Operate on files via Index
const file = ggpk.Index.TryGetFile('metadata/ui/uisettings.xml');
if (file) {
  const data = file.Read();
  file.Write(Buffer.from('...'));
}

// Save and release
ggpk.Index.Save();
ggpk.Dispose();  // automatically writes index back to GGPK + renewHashes
```

#### Plain GGPK (without Bundles2)

```ts
import { GGPK, TreeNode } from 'poe-bundle-lib';

const ggpk = new GGPK('path/to/Content.ggpk');

// Traverse GGPK file tree
for (const [file, relPath] of TreeNode.recurseFiles(ggpk.root)) {
  if (relPath === 'metadata/ui/uisettings.xml') {
    const data = file.read();    // lowercase
    file.write(Buffer.from('...'));
  }
}

// Release (automatically renews hashes + flushes)
ggpk.dispose();
```

### Installing Patches

```ts
import { Index } from 'poe-bundle-lib';
import AdmZip from 'adm-zip';

const index = new Index('Bundles2/_.index.bin', { parsePaths: false });
const zip = new AdmZip('patch.zip');

const entries = zip.getEntries().map(e => ({
  fullName: e.entryName,
  getData: () => e.getData(),
}));

// Replace files from zip entries, auto-saves by default
Index.ReplaceFromEntries(index, entries, (file, name) => {
  console.log('replaced:', name);
  return false;
});
```

For GGPK format:

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

### Oodle Compression

```ts
import { Initialize, Settings, Compressor, Compress, Decompress, Release } from 'poe-bundle-lib/oodle';

Initialize(new Settings({
  chunkSize: 256 * 1024,
  compressor: Compressor.Mermaid,
}));

const { compressedSize, output } = Compress(inputBuffer);
const decompressed = Decompress(output, Buffer.alloc(uncompressedSize));
```

### DDS Texture Editing

Edit DDS textures in place — for example, adding text to a map icon. Editing is
lossless for uncompressed `R8G8B8A8` textures (all mips are rebuilt from the
edited base image via 2x2 box downsampling):

```ts
import { AddText } from 'poe-bundle-lib/dds';
import { readFileSync, writeFileSync } from 'node:fs';

// Edit a DDS file on disk
const dds = readFileSync('map1.dds');
const edited = AddText(dds, {
  text: 'Hello',        // supports CJK and '\n' multi-line
  // Positioning (all accept pixel numbers or 'N%' strings):
  right: '5%',          // CSS-like anchoring: block right edge = width - 5%
  bottom: '5%',         // block bottom edge = height - 5%
  // left / top work the same way, e.g. top-left corner: left: 8, top: 8
  // x: 8, y: 8,        // absolute positioning: draw origin of the text
  fontSize: '20%',      // pixels, percent of image height, or 'auto'
                        // ('auto' = largest size that fits without overflow)
  // center: 'both',     // optional: center the block ('horizontal'/'vertical'
  //                     // can be combined with anchoring on the other axis)
  // Per-axis priority: left > right > x (default 0), top > bottom > y (default 0)
  font: 'Microsoft YaHei',  // optional, default font
  color: 0xFF0000FF,    // 0xRRGGBBAA, default opaque white
  bold: false,          // optional
  regenerateMips: true, // optional, rebuild mip 1..n after editing
});
writeFileSync('map1-out.dds', edited);
```

Multiple text blocks can be drawn in one pass by passing an array — entries
are drawn in order on the same canvas (later ones paint over earlier ones,
overlaps are allowed; each entry's positioning and 'auto' budget is resolved
independently against the full image):

```ts
const edited = AddText(dds, [
  { text: 'TL', left: 5, top: 5, fontSize: 16, color: 0xFF0000FF },
  { text: 'BR', right: '5%', bottom: '5%', fontSize: '16%', color: 0x00FF00FF },
  { text: 'mid', center: 'both', fontSize: 'auto', color: 0xFFFF00FF },
]);
```

Or write it straight back into the game's bundle:

```ts
import { AddText } from 'poe-bundle-lib/dds';

const file = index.TryGetFile('Art/Textures/map1.dds');
if (file) {
  // x/y (pixel origin) and left/right/top/bottom (percentages) are interchangeable
  file.Write(AddText(file.Read(), { text: 'Hello', x: 8, y: 8, fontSize: 16, color: 0xFF0000FF }));
}
index.Save();  // persist the change
```

Lower-level building blocks are also exported: `DdsImage` (parse and inspect
DDS/DX10 headers, decode a mip to RGBA), `RgbaSurface` (pixel access + PNG
preview via `toPng()`), `applyText`, `downsample2x2`.

Command-line examples:

```bash
# Inspect format / mip layout of a DDS file, optionally export a mip as PNG
node examples/dds-inspect.mjs map1.dds --png 0

# Add text and write a new DDS, --png also saves a preview image
node examples/dds-add-text.mjs map1.dds out.dds "Hello" 8 8 16 --color 0xFF0000FF --png

# CSS-like anchoring (bottom-right corner, 20% font size)
node examples/dds-add-text.mjs map1.dds out.dds "Hello" --right 5% --bottom 5% --fontSize 20% --png
```

## Exports

| Subpath | Contents |
|---------|----------|
| `poe-bundle-lib` | Index, Bundle, BundledGGPK, GGPK, GGPKRecord, TreeNode, FileRecord, BundleRecord, DriveBundleFactory, node classes |
| `poe-bundle-lib/oodle` | Initialize, Compress, Decompress, Release, Settings, Compressor, CompressionLevel |
| `poe-bundle-lib/bundle` | Bundle class |
| `poe-bundle-lib/index` | Index class |
| `poe-bundle-lib/records` | BundleRecord, FileRecord (for Index) |
| `poe-bundle-lib/nodes` | ITreeNode, IDirectoryNode, IFileNode, DirectoryNode, FileNode |
| `poe-bundle-lib/ggpk` | GGPK class |
| `poe-bundle-lib/ggpk/records` | GGPKRecord, DirectoryRecord, FileRecord, FreeRecord, TreeNode, BaseRecord |
| `poe-bundle-lib/bundled` | BundledGGPK, GGPKBundleFactory |
| `poe-bundle-lib/dds` | AddText, applyText, AddTextOptions, AddTextInput, resolveTextLayout, DdsImage, DdsFormat, RgbaSurface, downsample2x2, BC1/BC2/BC3 decoders |

## Notes

- **Casing**: Index's `FileRecord` uses `Read()` / `Write()` (uppercase), GGPK's `FileRecord` uses `read()` / `write()` (lowercase)
- **Saving**: Index mode requires an explicit `Save()` call; GGPK mode writes take effect immediately, `dispose()` automatically calls `renewHashes()`
- **BundledGGPK**: `Dispose()` automatically writes changes back to `_.index.bin` inside the GGPK
- **GGPK free space**: If `firstFreeRecordOffset` is corrupted, it resets to an empty linked list and new data is appended to the end of the file
- **Hash protection**: `renewHashes()` does not update hashes for root and its direct children by default, to prevent the game from detecting modifications and rolling back
- **DDS editing**: only uncompressed `R8G8B8A8` DDS can be edited (BC1/BC2/BC3 are decode/inspect only, BC4-BC7 unsupported). Cubemaps, 3D textures and texture arrays are rejected by the parser. Text is composited manually over the untouched base pixels: everything outside the text ink stays byte-identical (including translucent pixels); antialiased text edges may carry ±1 rounding from the canvas un-premultiply. DX10 headers use the DXGI channel order (R in byte 0), legacy headers the D3DFMT DWORD layout (B,G,R,A). Requires `@napi-rs/canvas` (installed as a dependency, Windows binary included)

## License

MIT
