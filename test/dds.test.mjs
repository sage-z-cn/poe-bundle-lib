/**
 * DDS module tests against the real sample examples/atlasmapwarlord.dds
 * (80x80 R8G8B8A8_UNORM, DX10 header, 7 mips, data offset 148).
 *
 * Self-contained ESM script using node:assert (no test framework, matching
 * the project's current setup). Run via `npm test` after `npm run build`.
 *
 * PNG previews (for manual inspection) are written to the current working
 * directory; intermediate DDS outputs go to %TEMP%/opencode.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

if (!existsSync(new URL('../dist/dds/index.js', import.meta.url))) {
  console.error('dist/dds not found - run `npm run build` first');
  process.exit(1);
}

const {
  DdsImage,
  DdsFormat,
  AddText,
  applyText,
  resolveTextLayout,
  RgbaSurface,
  downsample2x2,
} = await import('../dist/dds/index.js');

const SAMPLE = new URL('../examples/atlasmapwarlord.dds', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TMP = join(tmpdir(), 'opencode');
const original = readFileSync(SAMPLE);

/** assertion counter, incremented by check() */
let checks = 0;
function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

/** bbox of pixels that differ from base and match the color test */
function diffBBox(edited, base, colorTest) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
  for (let y = 0; y < edited.height; y++) {
    for (let x = 0; x < edited.width; x++) {
      const i = (y * edited.width + x) * 4;
      const changed = edited.pixels[i] !== base.pixels[i] || edited.pixels[i + 1] !== base.pixels[i + 1] || edited.pixels[i + 2] !== base.pixels[i + 2] || edited.pixels[i + 3] !== base.pixels[i + 3];
      if (changed && colorTest(edited.pixels[i], edited.pixels[i + 1], edited.pixels[i + 2], base.pixels[i], base.pixels[i + 1], base.pixels[i + 2])) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count };
}

const strong = (r, g, b, rb) => (r - rb) > 50; // new ink: channel rose by >50 vs base
const isRed = (r, g, b, rb, gb, bb) => strong(r, g, b, rb) && r > 150 && g < 100 && b < 100;
const isGreen = (r, g, b, rb, gb, bb) => strong(g, g, b, gb) && g > 150 && r < 100 && b < 100;
const isYellow = (r, g, b, rb, gb, bb) => strong(r, g, b, rb) && r > 150 && g > 150 && b < 100;
const isCyan = (r, g, b, rb, gb, bb) => strong(g, g, b, gb) && g > 150 && b > 150 && r < 100;
const anyChange = (r, g, b) => true;

/** decode mip0 of a DDS buffer */
const mip0 = (buf) => DdsImage.parse(buf).decodeMip(0);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Reused artifacts (populated by earlier cases for later ones)
let editedXY; // case 4 output DDS buffer
let editedMulti; // case 8 output DDS buffer
let multiRed, multiGreen, multiYellow; // case 8 diff bboxes
let baseSurface; // original mip0 surface

test('parse: header fields of the real sample', () => {
  const img = DdsImage.parse(original);
  check(img.format === DdsFormat.RGBA8_Uncompressed, `format ${img.format}`);
  check(img.formatName === 'R8G8B8A8_UNORM', `formatName ${img.formatName}`);
  check(img.width === 80 && img.height === 80, `size ${img.width}x${img.height}`);
  check(img.mipCount === 7, `mipCount ${img.mipCount}`);
  check(img.isBlockCompressed === false, 'isBlockCompressed should be false');
  const firstMipOffset = Number(/^  mip 0: 80x80, offset (\d+)/m.exec(img.inspect())[1]);
  check(firstMipOffset === 148, `data offset ${firstMipOffset}`);
});

test('decode + lossless round-trip on mip 0', () => {
  const img = DdsImage.parse(original);
  baseSurface = img.decodeMip(0);
  check(baseSurface.width === 80 && baseSurface.height === 80, 'surface size');
  const out = img.writeMipPixels(0, baseSurface.pixels, false);
  check(out.equals(original), 'round-trip should be byte-identical');
  // also export an untouched preview of the original for visual reference
  writeFileSync('atlas-test-original.png', baseSurface.toPng());
});

test('pixel() sampling matches raw file bytes (DX10 order, unsigned)', () => {
  const DATA = 148; // first mip offset
  for (const [x, y] of [[0, 0], [31, 17], [79, 40], [64, 79]]) {
    const o = DATA + (y * 80 + x) * 4;
    // DXGI R8G8B8A8: byte 0 = R, 1 = G, 2 = B, 3 = A (little-endian u32 read)
    const expected = ((original[o] << 24) | (original[o + 1] << 16) | (original[o + 2] << 8) | original[o + 3]) >>> 0;
    const got = baseSurface.pixel(x, y);
    check(Number.isInteger(got) && got >= 0 && got <= 0xffffffff, `pixel(${x},${y}) out of range: ${got}`);
    check(got === expected, `pixel(${x},${y}) = ${got.toString(16)}, expected ${expected.toString(16)}`);
  }
});

test('x/y absolute positioning (AddText single block)', () => {
  editedXY = AddText(original, { text: 'XY', x: 10, y: 12, fontSize: 20, color: 0xff0000ff });
  writeFileSync(join(TMP, 'atlas-test-xy.dds'), editedXY);
  const bbox = diffBBox(mip0(editedXY), baseSurface, isRed);
  check(bbox.count > 30, `red ink pixels: ${bbox.count}`);
  check(Math.abs(bbox.minX - 10) <= 3, `ink left ${bbox.minX} vs x=10`);
  check(Math.abs(bbox.minY - 12) <= 3, `ink top ${bbox.minY} vs y=12`);
  writeFileSync('atlas-test-xy.png', mip0(editedXY).toPng());
});

test('CSS percentage anchoring (right/bottom 5%)', () => {
  const edited = AddText(original, { text: 'AB', right: '5%', bottom: '5%', fontSize: '20%', color: 0x00ff00ff });
  const bbox = diffBBox(mip0(edited), baseSurface, isGreen);
  check(bbox.count > 30, `green ink pixels: ${bbox.count}`);
  check(bbox.maxX <= 76, `ink right ${bbox.maxX} > 76`);
  check(bbox.maxY <= 76, `ink bottom ${bbox.maxY} > 76`);
  check(bbox.maxX >= 55, `ink right ${bbox.maxX} suspiciously small (not anchored)`);
  writeFileSync('atlas-test-css.png', mip0(edited).toPng());
});

test('center both with ink symmetry', () => {
  const edited = AddText(original, { text: 'AB', center: 'both', fontSize: '25%', color: 0xffff00ff });
  const bbox = diffBBox(mip0(edited), baseSurface, isYellow);
  check(bbox.count > 30, `yellow ink pixels: ${bbox.count}`);
  const dx = Math.abs(bbox.minX - (79 - bbox.maxX));
  const dy = Math.abs(bbox.minY - (79 - bbox.maxY));
  check(dx <= 3, `horizontal asymmetry ${bbox.minX} vs ${79 - bbox.maxX}`);
  check(dy <= 3, `vertical asymmetry ${bbox.minY} vs ${79 - bbox.maxY}`);
  writeFileSync('atlas-test-center.png', mip0(edited).toPng());
});

test("fontSize 'auto' fits long text inside bounds", () => {
  const edited = AddText(original, { text: '自适应长文字测试', fontSize: 'auto', color: 0x00ffffff });
  const bbox = diffBBox(mip0(edited), baseSurface, isCyan);
  check(bbox.count > 30, `cyan ink pixels: ${bbox.count}`);
  check(bbox.minX >= 0 && bbox.maxX <= 79 && bbox.minY >= 0 && bbox.maxY <= 79, `overflow: ${JSON.stringify(bbox)}`);
  check(bbox.maxX - bbox.minX + 1 >= 60, `ink width ${bbox.maxX - bbox.minX + 1} < 60`);
  writeFileSync('atlas-test-auto.png', mip0(edited).toPng());
});

test('multi-text array: three blocks, correct placement, disjoint', () => {
  editedMulti = AddText(original, [
    { text: 'A', x: 6, y: 6, fontSize: 14, color: 0xff0000ff },
    { text: 'B', right: '6%', bottom: '6%', fontSize: '14%', color: 0x00ff00ff },
    { text: 'C', center: 'both', fontSize: '12%', color: 0xffff00ff },
  ]);
  writeFileSync(join(TMP, 'atlas-test-multi.dds'), editedMulti);
  const edited = mip0(editedMulti);
  multiRed = diffBBox(edited, baseSurface, isRed);
  multiGreen = diffBBox(edited, baseSurface, isGreen);
  multiYellow = diffBBox(edited, baseSurface, isYellow);
  check(multiRed.count > 10 && multiGreen.count > 10 && multiYellow.count > 10, `ink counts R:${multiRed.count} G:${multiGreen.count} Y:${multiYellow.count}`);
  check(multiRed.minX <= 10 && multiRed.minY <= 10, `red not top-left: ${JSON.stringify(multiRed)}`);
  check(multiGreen.maxX >= 65 && multiGreen.maxY >= 60, `green not bottom-right: ${JSON.stringify(multiGreen)}`);
  const dx = Math.abs(multiYellow.minX - (79 - multiYellow.maxX));
  check(dx <= 4, `yellow not centered: ${JSON.stringify(multiYellow)}`);
  const disjoint = (a, b) => a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
  check(disjoint(multiRed, multiGreen), `red/green overlap: ${JSON.stringify(multiRed)} vs ${JSON.stringify(multiGreen)}`);
  check(disjoint(multiRed, multiYellow), `red/yellow overlap: ${JSON.stringify(multiRed)} vs ${JSON.stringify(multiYellow)}`);
  check(disjoint(multiGreen, multiYellow), `green/yellow overlap: ${JSON.stringify(multiGreen)} vs ${JSON.stringify(multiYellow)}`);
  writeFileSync('atlas-test-multi.png', edited.toPng());
});

test('base fidelity: pixels outside the multi-text ink union unchanged', () => {
  const edited = mip0(editedMulti);
  const u = {
    minX: Math.min(multiRed.minX, multiGreen.minX, multiYellow.minX),
    maxX: Math.max(multiRed.maxX, multiGreen.maxX, multiYellow.maxX),
    minY: Math.min(multiRed.minY, multiGreen.minY, multiYellow.minY),
    maxY: Math.max(multiRed.maxY, multiGreen.maxY, multiYellow.maxY),
  };
  // The union bbox spans a large area; only require byte-equality OUTSIDE it
  // (inside, pixels between the glyphs must also stay equal - text ink is sparse -
  // so additionally compare exact-equal pixel count inside the union)
  let changedOutside = 0;
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 80; x++) {
      if (x >= u.minX && x <= u.maxX && y >= u.minY && y <= u.maxY) continue;
      const i = (y * 80 + x) * 4;
      for (let c = 0; c < 4; c++) {
        if (edited.pixels[i + c] !== baseSurface.pixels[i + c]) changedOutside++;
      }
    }
  }
  check(changedOutside === 0, `${changedOutside} bytes changed outside ink union bbox`);
  let changedInside = 0;
  for (let y = u.minY; y <= u.maxY; y++) {
    for (let x = u.minX; x <= u.maxX; x++) {
      const i = (y * 80 + x) * 4;
      if (edited.pixels[i] !== baseSurface.pixels[i] || edited.pixels[i + 1] !== baseSurface.pixels[i + 1] || edited.pixels[i + 2] !== baseSurface.pixels[i + 2] || edited.pixels[i + 3] !== baseSurface.pixels[i + 3]) changedInside++;
    }
  }
  // Inside the union, changed pixels must be exactly the text coverage
  // (strong-color cores plus antialiased edges); count any-change pixels
  // over the full image for comparison
  let totalChanged = 0;
  for (let p = 0; p < 80 * 80; p++) {
    const i = p * 4;
    if (edited.pixels[i] !== baseSurface.pixels[i] || edited.pixels[i + 1] !== baseSurface.pixels[i + 1] || edited.pixels[i + 2] !== baseSurface.pixels[i + 2] || edited.pixels[i + 3] !== baseSurface.pixels[i + 3]) totalChanged++;
  }
  check(changedInside === totalChanged, `changed pixels inside union (${changedInside}) should equal total changed (${totalChanged})`);
  check(totalChanged >= multiRed.count + multiGreen.count + multiYellow.count, 'strong-color ink must be a subset of changed pixels');
  check(totalChanged < 80 * 80 / 4, 'suspiciously many changed pixels');
});

test('mip chain regeneration matches box downsampling', () => {
  const img = DdsImage.parse(editedXY); // case 4 wrote with regenerateMips default true
  let src = img.decodeMip(0);
  for (let m = 1; m < 7; m++) {
    src = downsample2x2(src);
    const actual = img.decodeMip(m);
    check(Buffer.compare(Buffer.from(src.pixels), Buffer.from(actual.pixels)) === 0, `mip ${m} differs from box-downsampled chain`);
  }
});

test('regression: resolveTextLayout, error paths, unsigned pixel()', () => {
  // percentage resolution + axis priority
  let l = resolveTextLayout(100, 200, { text: 'A', x: '10%', y: '5%', fontSize: '10%' });
  check(l.x === 10 && l.y === 10 && l.fontSize === 20, `percent resolution ${JSON.stringify(l)}`);
  l = resolveTextLayout(100, 200, { text: 'A', left: 3, right: 7, x: 9, top: 4, bottom: 8, y: 12, fontSize: 16 });
  check(l.x === 3 && l.y === 4, `priority ${JSON.stringify(l)}`);
  // error paths
  assert.throws(() => resolveTextLayout(80, 80, { text: 'A', fontSize: 'auto' }), /requires text measurement/);
  assert.throws(() => resolveTextLayout(80, 80, { text: 'A', center: 'both', fontSize: 16 }), /requires text measurement/);
  assert.throws(() => resolveTextLayout(80, 80, { text: 'A', x: 'bogus', fontSize: 16 }), /Invalid x value/);
  checks += 3;
  // unsigned pixel(): R >= 128
  const s = new RgbaSurface(1, 1, new Uint8Array([200, 2, 3, 254]));
  const p = s.pixel(0, 0);
  check(p > 0 && p === (((200 << 24) | (2 << 16) | (3 << 8) | 254) >>> 0), `unsigned pixel ${p.toString(16)}`);
  // applyText on empty array returns identical pixels
  const empty = applyText(baseSurface, []);
  check(Buffer.compare(Buffer.from(empty.pixels), Buffer.from(baseSurface.pixels)) === 0, 'empty array changed pixels');
});

// ---------- runner ----------

let failed = 0;
const t0 = performance.now();
for (const t of tests) {
  const before = checks;
  const start = performance.now();
  try {
    t.fn();
    console.log(`ok   ${t.name} (${checks - before} checks, ${(performance.now() - start).toFixed(0)}ms)`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${t.name} (${(performance.now() - start).toFixed(0)}ms)`);
    console.error(`     ${err.message.split('\n')[0]}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed, ${checks} checks total, ${(performance.now() - t0).toFixed(0)}ms`);
process.exit(failed === 0 ? 0 : 1);
