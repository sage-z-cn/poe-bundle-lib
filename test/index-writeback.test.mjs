/**
 * Index write-back regression tests (drive-backed Bundles2 directory).
 *
 * Reproduces the review findings programmatically, without a real game
 * client: a minimal _.index.bin (one directory record, Murmur hashing,
 * files stored in bundle Data/0) is synthesized from scratch, written back,
 * and re-opened.
 *
 * Covered:
 *  1. baseline read of the original file
 *  2. first Write() into a newly created custom bundle 鈥?regression:
 *     Bundle.createEmpty() used to leave filePath undefined, so
 *     HasFilePath misjudged it as disk-backed and FlushBundleToWrite
 *     skipped persisting, leaving an empty 60-byte LibGGPK3/0.bundle.bin
 *  3. multi-bundle split via a small MaxBundleSize 鈥?regression: data loss
 *     when the pending bundle was flushed at the threshold
 *  4. customBundleBasePath option: an existing custom bundle with a
 *     non-default prefix is recognized and reused (BundledGGPK forwards
 *     the same option to Index)
 *
 * All artifacts go to %TEMP%/opencode (created on demand).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

if (!existsSync(new URL('../dist/Index.js', import.meta.url))) {
  console.error('dist/Index.js not found - run `npm run build` first');
  process.exit(1);
}

const { Index } = await import('../dist/Index.js');
const { Bundle } = await import('../dist/Bundle.js');

const TMP = join(tmpdir(), 'opencode');
mkdirSync(TMP, { recursive: true });

const MURMUR_SENTINEL = 0xF42A94E69CFF42FEn;
const DEFAULT_CUSTOM_PATH = (n) => join(TMP, 'index-writeback', n);

let checks = 0;
function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

// ---------- minimal index synthesis ----------

/** compress raw payload into a full bundle.bin buffer (in memory) */
function packBundle(raw) {
  const b = Bundle.createEmpty(null);
  b.Save(raw);
  return b.getFileBuffer();
}

function bundleRecord(path, uncompressedSize) {
  const p = Buffer.from(path, 'utf8');
  const buf = Buffer.alloc(4 + p.length + 4);
  buf.writeUInt32LE(p.length, 0);
  p.copy(buf, 4);
  buf.writeUInt32LE(uncompressedSize, 4 + p.length);
  return buf;
}

function fileRecord(hash, bundleIndex, offset, size) {
  const buf = Buffer.alloc(20);
  buf.writeBigUInt64LE(hash, 0);
  buf.writeInt32LE(bundleIndex, 8);
  buf.writeInt32LE(offset, 12);
  buf.writeInt32LE(size, 16);
  return buf;
}

function directoryRecord(offset, size) {
  const buf = Buffer.alloc(20);
  buf.writeBigUInt64LE(MURMUR_SENTINEL, 0);
  buf.writeInt32LE(offset, 8);
  buf.writeInt32LE(size, 12);
  buf.writeInt32LE(size, 16);
  return buf;
}

/**
 * Directory payload: root file names in the index's prefix-compressed
 * format. Each entry is int32(1) + null-terminated name; with an empty
 * prefix stack ParsePaths resolves each token directly to a file hash.
 */
function directoryData(fileNames) {
  const parts = [];
  for (const name of fileNames) {
    const head = Buffer.alloc(4);
    head.writeInt32LE(1, 0);
    parts.push(head, Buffer.from(name, 'utf8'), Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

/** assemble the uncompressed index payload */
function buildIndexRaw(files, dirPayload, bundles) {
  const parts = [];
  const bc = Buffer.alloc(4);
  bc.writeUInt32LE(bundles.length);
  parts.push(bc);
  for (const b of bundles) parts.push(bundleRecord(b.path, b.uncompressedSize));

  const fc = Buffer.alloc(4);
  fc.writeUInt32LE(files.length);
  parts.push(fc);
  for (const f of files) parts.push(fileRecord(f.hash, f.bundleIndex, f.offset, f.size));

  const dc = Buffer.alloc(4);
  dc.writeUInt32LE(1); // a single directory record
  parts.push(dc, directoryRecord(0, dirPayload.length));

  parts.push(packBundle(dirPayload));
  return Buffer.concat(parts);
}

/** resolve real path hashes via a throwaway in-memory index */
function nameHashes(names) {
  const files = names.map((n) => ({ hash: 0n, bundleIndex: 0, offset: 0, size: 0 }));
  const probe = new Index(
    packBundle(buildIndexRaw(files, directoryData(names), [{ path: 'Data/0', uncompressedSize: 0 }])),
    { parsePaths: false },
  );
  try {
    return names.map((n) => probe.NameHash(n));
  } finally {
    probe.Dispose();
  }
}

/** build a Bundles2/ environment on disk and return the _.index.bin path */
function makeEnv(root, fileMap, extraBundles = []) {
  const names = Object.keys(fileMap);
  const hashes = nameHashes(names);

  let off = 0;
  const files = names.map((n, i) => {
    const rec = { hash: hashes[i], bundleIndex: 0, offset: off, size: fileMap[n].length };
    off += fileMap[n].length;
    return rec;
  });

  const content = Buffer.concat(names.map((n) => fileMap[n]));
  mkdirSync(join(root, 'Bundles2', 'Data'), { recursive: true });
  writeFileSync(join(root, 'Bundles2', 'Data', '0.bundle.bin'), packBundle(content));

  for (const eb of extraBundles) {
    const p = join(root, 'Bundles2', `${eb.path}.bundle.bin`);
    mkdirSync(dirname(p), { recursive: true });
    // 60-byte empty bundle header on disk
    const empty = Bundle.createEmpty(null);
    writeFileSync(p, empty.getFileBuffer());
  }

  const bundles = [{ path: 'Data/0', uncompressedSize: content.length }, ...extraBundles];
  const raw = buildIndexRaw(files, directoryData(names), bundles);
  const indexPath = join(root, 'Bundles2', '_.index.bin');
  writeFileSync(indexPath, packBundle(raw));
  return indexPath;
}

function freshDir(name) {
  const dir = DEFAULT_CUSTOM_PATH(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- tests ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('baseline: synthesized index opens and reads the original file', () => {
  const root = freshDir('baseline');
  const original = Buffer.from('hello writeback baseline');
  const idxPath = makeEnv(root, { 'test.txt': original });

  const index = new Index(idxPath);
  const f = index.TryGetFile('test.txt');
  check(f !== null, 'TryGetFile must find test.txt after ParsePaths');
  check(f.Read().equals(original), 'original content round-trip');
  index.Dispose();
});

test('first Write(): custom bundle is persisted with data (not a 60-byte stub)', () => {
  const root = freshDir('first-write');
  const original = Buffer.from('hello writeback');
  const idxPath = makeEnv(root, { 'test.txt': original });

  const index = new Index(idxPath);
  const replacement = Buffer.alloc(4096, 0x5A);
  index.TryGetFile('test.txt').Write(replacement);
  index.Save();
  index.Dispose();

  const customPath = join(root, 'Bundles2', 'LibGGPK3', '0.bundle.bin');
  check(existsSync(customPath), 'custom bundle file exists on disk');
  const size = statSync(customPath).size;
  check(size > 60, `custom bundle must contain compressed data, got ${size} bytes (60 = empty header only)`);

  const custom = new Bundle(customPath);
  check(custom.UncompressedSize === replacement.length, `custom bundle uncompressed size ${custom.UncompressedSize} != ${replacement.length}`);
  custom.Dispose();

  const reopened = new Index(idxPath);
  const f2 = reopened.TryGetFile('test.txt');
  check(f2.Read().equals(replacement), 're-opened index reads back the replacement');
  reopened.Dispose();
});

test('MaxBundleSize split: multiple custom bundles all persist their data', () => {
  const root = freshDir('split');
  const A = Buffer.alloc(3000, 0xAB);
  const B = Buffer.alloc(1500, 0xCD);
  const idxPath = makeEnv(root, { 'test.txt': Buffer.from('seed-a'), 'second.bin': Buffer.from('seed-b') });

  const index = new Index(idxPath);
  index.MaxBundleSize = 2048;
  index.TryGetFile('test.txt').Write(A); // >= threshold -> auto flush to LibGGPK3/0
  index.TryGetFile('second.bin').Write(B); // bundle 0 is full -> new LibGGPK3/1
  index.Save();
  index.Dispose();

  for (const n of ['0', '1']) {
    const p = join(root, 'Bundles2', 'LibGGPK3', `${n}.bundle.bin`);
    check(existsSync(p), `split bundle ${n} exists`);
    check(statSync(p).size > 60, `split bundle ${n} must contain data, got ${statSync(p).size} bytes`);
  }

  const reopened = new Index(idxPath);
  check(reopened.TryGetFile('test.txt').Read().equals(A), 'split: test.txt round-trip');
  check(reopened.TryGetFile('second.bin').Read().equals(B), 'split: second.bin round-trip');
  reopened.Dispose();
});

test('customBundleBasePath: prefixed custom bundle is reused, no LibGGPK3 created', () => {
  const root = freshDir('prefix');
  const idxPath = makeEnv(root, { 'test.txt': Buffer.from('seed') }, [{ path: 'MyBundle/0', uncompressedSize: 0 }]);

  const index = new Index(idxPath, { customBundleBasePath: 'MyBundle' });
  const data = Buffer.from('prefixed payload that must come back intact');
  index.TryGetFile('test.txt').Write(data);
  index.Save();
  index.Dispose();

  check(!existsSync(join(root, 'Bundles2', 'LibGGPK3')), 'default LibGGPK3/ prefix must not be used');
  const p = join(root, 'Bundles2', 'MyBundle', '0.bundle.bin');
  check(existsSync(p), 'prefixed bundle file exists');
  check(statSync(p).size > 60, `prefixed bundle must contain data, got ${statSync(p).size} bytes`);

  const reopened = new Index(idxPath, { customBundleBasePath: 'MyBundle' });
  check(reopened.TryGetFile('test.txt').Read().equals(data), 'prefix: round-trip after reopen');
  reopened.Dispose();
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
