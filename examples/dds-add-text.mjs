#!/usr/bin/env node
/**
 * Draw text onto an uncompressed RGBA8 DDS texture.
 *
 * Usage: node examples/dds-add-text.mjs <in.dds> <out.dds> "text" [x y fontSize]
 *        [--left L] [--right R] [--top T] [--bottom B] [--fontSize S]
 *        [--center both|horizontal|vertical] [--color 0xRRGGBBAA] [--font name]
 *        [--text "more text" ...more flags...] [--png]
 *
 * Position values accept pixels (plain numbers) or percentages ('5%');
 * --fontSize additionally accepts 'auto' (largest size that fits).
 * --center centers the block on the given axes, overriding their anchors.
 * Priority otherwise: left > right > x and top > bottom > y.
 *
 * Multiple text blocks: each --text starts a new group; the positioning/style
 * flags after it belong to that group until the next --text (drawn in order,
 * later groups paint over earlier ones):
 *   node examples/dds-add-text.mjs in.dds out.dds "A" 8 8 16 --color 0xFF0000FF \
 *     --text "B" --right 5% --bottom 5% --fontSize 16% --color 0x00FF00FF
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AddText, DdsImage } from '../dist/dds/index.js';

const args = process.argv.slice(2);
const positional = [];
let png = false;
const groups = [{}];

// Plain numbers become Numbers, anything else (e.g. '5%') stays a string
const toLength = (s) => (/^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : s);

for (let i = 0; i < args.length; i++) {
  const group = groups[groups.length - 1];
  if (args[i] === '--text') {
    const value = args[++i];
    if (value === undefined) {
      console.error('--text requires a text value');
      process.exit(1);
    }
    // Each --text starts a new group
    groups.push({ text: value });
  } else if (args[i] === '--color') {
    const value = Number.parseInt(args[++i] ?? '', 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      console.error(`Invalid --color value: ${args[i]}`);
      process.exit(1);
    }
    group.color = value;
  } else if (args[i] === '--font') {
    const value = args[++i];
    if (!value) {
      console.error('--font requires a font name');
      process.exit(1);
    }
    group.font = value;
  } else if (args[i] === '--png') {
    png = true;
  } else if (args[i] === '--center') {
    const value = args[++i];
    if (!['both', 'horizontal', 'vertical'].includes(value)) {
      console.error(`Invalid --center value: ${value} (expected 'both', 'horizontal' or 'vertical')`);
      process.exit(1);
    }
    group.center = value;
  } else if (['--left', '--right', '--top', '--bottom', '--fontSize'].includes(args[i])) {
    const flag = args[i];
    const value = args[++i];
    if (value === undefined) {
      console.error(`${flag} requires a value (pixels, 'N%', or 'auto' for --fontSize)`);
      process.exit(1);
    }
    group[flag.slice(2)] = toLength(value);
  } else {
    positional.push(args[i]);
  }
}

if (positional.length < 2) {
  console.error('Usage: node examples/dds-add-text.mjs <in.dds> <out.dds> "text" [x y fontSize] [--left L] [--right R] [--top T] [--bottom B] [--fontSize S] [--center both|horizontal|vertical] [--color 0xRRGGBBAA] [--font name] [--text "more text" ...] [--png]');
  process.exit(1);
}

// The leading positional text / x / y / fontSize belong to the first group
// (they are only defaults; --flags already recorded on it take precedence)
const first = groups[0];
if (positional[2] !== undefined && first.text === undefined) first.text = positional[2];
if (positional[3] !== undefined && first.x === undefined) first.x = Number(positional[3]);
if (positional[4] !== undefined && first.y === undefined) first.y = Number(positional[4]);
if (positional[5] !== undefined && first.fontSize === undefined) first.fontSize = Number(positional[5]);

// Per-group defaults, then drop empty groups (no text at all)
const valid = groups.filter((g) => {
  if (g.text === undefined) return false;
  if (g.color === undefined) g.color = 0xffffffff;
  if (g.fontSize === undefined) g.fontSize = 16;
  return true;
});
if (valid.length === 0) {
  console.error('No text given: pass a positional "text" or use --text');
  process.exit(1);
}

const [input, output] = positional;
const options = valid.length === 1 ? valid[0] : valid;

const inBuffer = readFileSync(input);
const outBuffer = AddText(inBuffer, options);
writeFileSync(output, outBuffer);
console.log(`${input} -> ${output}: wrote ${outBuffer.length} bytes${valid.length > 1 ? ` (${valid.length} text blocks)` : ''}`);

if (png) {
  const preview = DdsImage.parse(outBuffer).decodeMip(0).toPng();
  const previewPath = output.replace(/\.dds$/i, '') + '-preview.png';
  writeFileSync(previewPath, preview);
  console.log(`wrote ${previewPath}`);
}
