/**
 * Real-client regression tests (review follow-up) against the actual game
 * index at D:/WeGameApps/rail_apps/流放之路(511)/Bundles2/_.index.bin.
 *
 * READ-ONLY GUARANTEE for the client directory:
 *   - only _.index.bin is copied into a %TEMP%/opencode workspace;
 *   - every write (custom bundles, index rewrite) happens inside that copy;
 *   - the original file's size, mtime and SHA-256 are asserted unchanged
 *     at the end of the run.
 *
 * The write path never touches original bundles: new contents go to freshly
 * created custom bundles (LibGGPK3/N) inside the copied Bundles2 directory,
 * so no other bundle.bin needs to be copied.
 *
 * Run manually (machine-specific path, not part of `npm test`):
 *   npm run test:real        (after `npm run build`)
 * Skips with exit 0 when the client index is not present.
 */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

const CLIENT_INDEX = 'D:/WeGameApps/rail_apps/流放之路(511)/Bundles2/_.index.bin';

if (!existsSync(new URL('../dist/index.js', import.meta.url))) {
  console.error('dist/index.js not found - run `npm run build` first');
  process.exit(1);
}

if (!existsSync(CLIENT_INDEX)) {
  console.log(`SKIP client index not found: ${CLIENT_INDEX}`);
  process.exit(0);
}

const { Index } = await import('../dist/index.js');

const TMP = join(tmpdir(), 'opencode');
mkdirSync(TMP, { recursive: true });

const originalStat = statSync(CLIENT_INDEX);
const originalHash = createHash('sha256').update(readFileSync(CLIENT_INDEX)).digest('hex');

/** Make a fresh copy of the client index and return its path. */
function makeCopy(tag) {
  const dir = mkdtempSync(join(TMP, `real-index-${tag}-`));
  const bundles2 = join(dir, 'Bundles2');
  mkdirSync(bundles2);
  const indexPath = join(bundles2, '_.index.bin');
  copyFileSync(CLIENT_INDEX, indexPath);
  return { dir, bundles2, indexPath };
}

// --- shared state across the sequential tests ------------------------------

let copyA;          // main copy used by T1..T3
let targetPath;     // path of the file we overwrite
let writtenData;    // what T2 writes
let fileCount;      // Files.size before save
let snapshot;       // sample of untouched records, for fidelity check in T3

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('T1 open real index: all paths parse (0 failed, ~1.19M files)', () => {
  copyA = makeCopy('a');
  const index = new Index(copyA.indexPath); // parsePaths: true, throws when failed !== 0
  fileCount = index.Files.size;
  console.log(`     files: ${fileCount}, bundles: ${index.Bundles.length}`);
  assert.ok(fileCount > 1_000_000, `unexpected file count ${fileCount}`);

  targetPath = index.TryGetFile('Metadata/StatDescriptions.dat')?.Path;
  if (!targetPath) {
    for (const f of index.Files.values()) {
      if (f.Path) { targetPath = f.Path; break; }
    }
  }
  assert.ok(targetPath, 'no writable target file found');

  // sample every 597th untouched record for the post-save fidelity check
  snapshot = [];
  let i = 0;
  for (const f of index.Files.values()) {
    if (i++ % 597 === 0 && f.Path && f.Path !== targetPath) {
      snapshot.push({ path: f.Path, size: f.Size, offset: f.Offset, bundle: f.BundleRecord._Path });
    }
  }
  console.log(`     target: ${targetPath}, fidelity samples: ${snapshot.length}`);
  index.Dispose();
});

test('T2 first write + Save: custom bundle is real data, not a 60-byte header', () => {
  const index = new Index(copyA.indexPath);
  writtenData = Buffer.alloc(2048, 0x5a);
  index.TryGetFile(targetPath).Write(writtenData);
  index.Save();
  index.Dispose();

  const customPath = join(copyA.bundles2, 'LibGGPK3', '0.bundle.bin');
  assert.ok(existsSync(customPath), 'custom bundle LibGGPK3/0.bundle.bin missing');
  const size = statSync(customPath).size;
  console.log(`     LibGGPK3/0.bundle.bin: ${size} bytes`);
  assert.ok(size > 60, `custom bundle is an empty 60-byte header (size=${size})`);
});

test('T3 re-open: written data survives, untouched records byte-identical', () => {
  const index = new Index(copyA.indexPath); // throws if any path fails to parse
  assert.equal(index.Files.size, fileCount, 'file count changed after save');

  const data = index.TryGetFile(targetPath).Read();
  assert.ok(data.equals(writtenData), `written data lost after re-open (got ${data.length} bytes)`);

  let checked = 0;
  for (const s of snapshot) {
    const fr = index.TryGetFile(s.path);
    assert.ok(fr, `sample path missing after re-open: ${s.path}`);
    assert.equal(fr.Size, s.size, `Size changed for ${s.path}`);
    assert.equal(fr.Offset, s.offset, `Offset changed for ${s.path}`);
    assert.equal(fr.BundleRecord._Path, s.bundle, `Bundle changed for ${s.path}`);
    checked++;
  }
  console.log(`     verified ${checked} untouched records (size/offset/bundle unchanged)`);
  index.Dispose();
});

test('T4 MaxBundleSize split on a fresh copy: multiple valid bundles, no loss', () => {
  const copy = makeCopy('b');
  try {
    const index = new Index(copy.indexPath);

    // pick three distinct target files
    const targets = [index.TryGetFile('Metadata/StatDescriptions.dat')?.Path, null, null]
      .filter(Boolean);
    for (const f of index.Files.values()) {
      if (targets.length >= 3) break;
      if (f.Path && !targets.includes(f.Path)) targets.push(f.Path);
    }
    assert.ok(targets.length === 3, `need 3 distinct targets, got ${targets.length}`);
    console.log(`     targets: ${targets.join(' | ')}`);

    const A = Buffer.alloc(800 * 1024, 0x61);
    const B = Buffer.alloc(800 * 1024, 0x62);
    const C = Buffer.alloc(10 * 1024, 0x63);

    index.MaxBundleSize = 1024 * 1024; // force a flush after A+B
    index.TryGetFile(targets[0]).Write(A);
    index.TryGetFile(targets[1]).Write(B); // 1.6MB >= 1MB -> flush bundle 0
    index.TryGetFile(targets[2]).Write(C); // goes to bundle 1
    index.Save();
    index.Dispose();

    const customDir = join(copy.bundles2, 'LibGGPK3');
    const bundles = readdirSync(customDir).sort();
    console.log(`     custom bundles: ${bundles.map(b => `${b}=${statSync(join(customDir, b)).size}B`).join(', ')}`);
    assert.ok(bundles.length >= 2, `expected >= 2 bundles after split, got ${bundles.length}`);
    for (const b of bundles) {
      const size = statSync(join(customDir, b)).size;
      assert.ok(size > 60, `${b} is an empty 60-byte header (size=${size})`);
    }

    const index2 = new Index(copy.indexPath);
    assert.ok(index2.TryGetFile(targets[0]).Read().equals(A), 'A lost after split');
    assert.ok(index2.TryGetFile(targets[1]).Read().equals(B), 'B lost after split');
    assert.ok(index2.TryGetFile(targets[2]).Read().equals(C), 'C lost after split');
    index2.Dispose();
  } finally {
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

test('T5 client directory untouched (size + mtime + SHA-256)', () => {
  const after = statSync(CLIENT_INDEX);
  const afterHash = createHash('sha256').update(readFileSync(CLIENT_INDEX)).digest('hex');
  assert.equal(after.size, originalStat.size, 'original index size changed');
  assert.equal(after.mtimeMs, originalStat.mtimeMs, 'original index mtime changed');
  assert.equal(afterHash, originalHash, 'original index content changed');
});

// --- runner -----------------------------------------------------------------

let failed = 0;
const t0 = performance.now();
try {
  for (const t of tests) {
    const start = performance.now();
    try {
      t.fn();
      console.log(`ok   ${t.name} (${(performance.now() - start).toFixed(0)}ms)`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${t.name} (${(performance.now() - start).toFixed(0)}ms)`);
      console.error(`     ${err.message.split('\n')[0]}`);
    }
  }
} finally {
  if (copyA?.dir) rmSync(copyA.dir, { recursive: true, force: true });
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed, ${(performance.now() - t0).toFixed(0)}ms`);
process.exit(failed === 0 ? 0 : 1);
