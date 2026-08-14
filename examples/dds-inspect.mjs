#!/usr/bin/env node
/**
 * Print a summary of DDS texture files, optionally exporting a mip as PNG.
 *
 * Usage: node examples/dds-inspect.mjs <file1.dds> [file2.dds ...] [--png <mip>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DdsImage } from '../dist/dds/index.js';

const args = process.argv.slice(2);
const files = [];
let pngMip = -1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--png') {
    pngMip = Number.parseInt(args[++i] ?? '', 10);
    if (!Number.isInteger(pngMip) || pngMip < 0) {
      console.error(`Invalid --png mip level: ${args[i]}`);
      process.exit(1);
    }
  } else {
    files.push(args[i]);
  }
}

if (files.length === 0) {
  console.error('Usage: node examples/dds-inspect.mjs <file1.dds> [file2.dds ...] [--png <mip>]');
  process.exit(1);
}

for (const file of files) {
  const image = DdsImage.parse(readFileSync(file));
  console.log(`${file}:`);
  console.log(image.inspect());
  if (pngMip >= 0) {
    const surface = image.decodeMip(pngMip);
    const out = `preview-mip${pngMip}.png`;
    writeFileSync(out, surface.toPng());
    console.log(`  wrote ${out} (${surface.width}x${surface.height})`);
  }
}
