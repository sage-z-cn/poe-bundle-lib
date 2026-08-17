/**
 * Index write-back regression tests (review follow-up).
 *
 * Covers the critical regression reported against 1.3.1:
 *   Bundle.createEmpty() left `filePath` undefined, so HasFilePath mistook
 *   fresh custom bundles for disk-backed ones and FlushBundleToWrite()
 *   skipped persisting their data — first writes and MaxBundleSize splits
 *   produced 60-byte empty bundles that failed to re-open.
 *
 * Also covers customBundleBasePath reuse (TinyBundle compatibility).
 *
 * The fixture is built from scratch (no game client needed):
 *   - a minimal Bundles2/_.index.bin (1 data bundle, 2 files, 2 directories)
 *   - a minimal Bundles2/_.bundle.bin holding the initial file contents
 *
 * Run via `npm test` after `npm run build`. Fixtures are created under
 * %TEMP%/opencode and removed afterwards — nothing is written to the repo.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

if (!existsSync(new URL('../dist/index.js', import.meta.url))) {
  console.error('dist/index.js not found - run `npm run build` first');
  process.exit(1);
}

const { Index } = await import('../dist/index.js');
const { Initialize, Settings, Compress, Compressor } = await import('../dist/Oodle.js');

const TMP = join(tmpdir(), 'opencode');
mkdirSync(TMP, { recursive: true });

// --- fixture helpers -------------------------------------------------------

/**
 * MurmurHash64A, identical to the implementation inside src/Index.ts.
 * Inlined here so the fixture builder is independent of Index internals.
 */
function murmur64(data, seed = 0x1337b33fn) {
  if (data.length === 0) return 0xf42a94e69cff42fen;
  let len = data.length;
  if (data[len - 1] === 0x2f) len--;
  const m = 0xc6a4a7935bd1e995n;
  const r = 47n;
  let h = seed ^ (BigInt(len) * m);
  const numChunks = Math.floor(len / 8);
  for (let i = 0; i < numChunks; i++) {
    let k = data.readBigUInt64LE(i * 8);
    k = (k * m) & 0xffffffffffffffffn;
    k = k ^ (k >> r);
    k = (k * m) & 0xffffffffffffffffn;
    h = (h ^ k) & 0xffffffffffffffffn;
    h = (h * m) & 0xffffffffffffffffn;
  }
  const remaining = len % 8;
  if (remaining !== 0) {
    let tail = 0n;
    for (let i = 0; i < remaining; i++) {
      tail |= BigInt(data[numChunks * 8 + i]) << BigInt(i * 8);
    }
    h = (h ^ tail) & 0xffffffffffffffffn;
    h = (h * m) & 0xffffffffffffffffn;
  }
  h = (h ^ (h >> r)) & 0xffffffffffffffffn;
  h = (h * m) & 0xffffffffffffffffn;
  h = (h ^ (h >> r)) & 0xffffffffffffffffn;
  return h;
}

/** Compress a payload into a single-chunk bundle file image (60-byte header + sizes + data). */
function makeBundleBytes(payload) {
  Initialize(new Settings({ chunkSize: 256 * 1024, compressor: Compressor.Leviathan }));
  const { compressedSize, output } = Compress(payload);
  const headSize = 48 + 4; // one chunk
  const buf = Buffer.alloc(12 + headSize + compressedSize);
  buf.writeInt32LE(payload.length, 0);
  buf.writeInt32LE(compressedSize, 4);
  buf.writeInt32LE(headSize, 8);
  buf.writeInt32LE(Compressor.Leviathan, 12);
  buf.writeInt32LE(1, 16); // unknown
  buf.writeBigInt64LE(BigInt(payload.length), 20);
  buf.writeBigInt64LE(BigInt(compressedSize), 28);
  buf.writeInt32LE(1, 36); // chunkCount
  buf.writeInt32LE(256 * 1024, 40); // chunkSize
  buf.writeInt32LE(compressedSize, 60); // compressed size of chunk 0
  output.copy(buf, 12 + headSize, 0, compressedSize);
  return buf;
}

/** i32 token + null-terminated string, the directory-list entry encoding. */
function token(index, str) {
  return Buffer.concat([i32(index), Buffer.from(str, 'utf8'), Buffer.from([0])]);
}

const HELLO = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(4));
const SECOND = Buffer.from('0123456789abcdef'.repeat(8));

/**
 * Build a minimal Bundles2 fixture with two files:
 *   test/hello.txt (HELLO) and test/second.txt (SECOND), both in bundle "".
 * With customPrefix, an extra empty-ish custom bundle record is added under
 * that prefix (e.g. TinyBundle/0) backed by a real 500-byte bundle file.
 */
function makeFixture(customPrefix) {
  const dir = mkdtempSync(join(TMP, 'index-writeback-'));
  const bundles2 = join(dir, 'Bundles2');
  mkdirSync(bundles2);

  // directory-list payload: [0][1,"test/"][0][1,"hello.txt"][1,"second.txt"]
  const dirPayload = Buffer.concat([
    i32(0),
    token(1, 'test/'),
    i32(0),
    token(1, 'hello.txt'),
    token(1, 'second.txt'),
  ]);
  const dirBundleData = makeBundleBytes(dirPayload);

  // data bundle ("") holds both files' initial contents
  writeFileSync(join(bundles2, '_.bundle.bin'), makeBundleBytes(Buffer.concat([HELLO, SECOND])));

  const bundles = [
    { path: '_', size: HELLO.length + SECOND.length }, // bundle 0 -> _.bundle.bin
  ];
  if (customPrefix) {
    const initData = Buffer.alloc(500, 0xab);
    const rel = `${customPrefix}0`;
    mkdirSync(join(bundles2, customPrefix), { recursive: true });
    writeFileSync(join(bundles2, rel + '.bundle.bin'), makeBundleBytes(initData));
    bundles.push({ path: rel, size: initData.length });
  }

  const files = [
    { hash: murmur64(Buffer.from('test/hello.txt')), bundleIndex: 0, offset: 0, size: HELLO.length },
    { hash: murmur64(Buffer.from('test/second.txt')), bundleIndex: 0, offset: HELLO.length, size: SECOND.length },
  ];
  const dirs = [
    { hash: 0xf42a94e69cff42fen, offset: 0, size: dirPayload.length, rec: 0 }, // root ""
    { hash: murmur64(Buffer.from('test/')), offset: 0, size: dirPayload.length, rec: HELLO.length + SECOND.length },
  ];

  const parts = [];
  parts.push(u32(bundles.length));
  for (const b of bundles) {
    const p = Buffer.from(b.path, 'utf8');
    parts.push(u32(p.length), p, u32(b.size));
  }
  parts.push(u32(files.length));
  for (const f of files) {
    const r = Buffer.alloc(20);
    r.writeBigUInt64LE(f.hash, 0);
    r.writeInt32LE(f.bundleIndex, 8);
    r.writeInt32LE(f.offset, 12);
    r.writeInt32LE(f.size, 16);
    parts.push(r);
  }
  parts.push(u32(dirs.length));
  for (const d of dirs) {
    const r = Buffer.alloc(20);
    r.writeBigUInt64LE(d.hash, 0);
    r.writeInt32LE(d.offset, 8);
    r.writeInt32LE(d.size, 12);
    r.writeInt32LE(d.rec, 16);
    parts.push(r);
  }
  parts.push(dirBundleData);

  writeFileSync(join(bundles2, '_.index.bin'), makeBundleBytes(Buffer.concat(parts)));
  return { dir, indexPath: join(bundles2, '_.index.bin'), bundles2 };
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function i32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
}

// --- tests -----------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('fixture parses: paths resolve and initial contents read back', () => {
  const fx = makeFixture();
  try {
    const index = new Index(fx.indexPath);
    const hello = index.TryGetFile('test/hello.txt');
    const second = index.TryGetFile('test/second.txt');
    assert.ok(hello, 'test/hello.txt not found');
    assert.ok(second, 'test/second.txt not found');
    assert.equal(hello.Path, 'test/hello.txt');
    assert.equal(second.Path, 'test/second.txt');
    assert.ok(hello.Read().equals(HELLO), 'hello initial content mismatch');
    assert.ok(second.Read().equals(SECOND), 'second initial content mismatch');
    index.Dispose();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('first write persists a non-empty custom bundle (1.3.1 regression)', () => {
  const fx = makeFixture();
  try {
    const newData = Buffer.from('X'.repeat(2048));
    let index = new Index(fx.indexPath);
    const hello = index.TryGetFile('test/hello.txt');
    hello.Write(newData);
    index.Save();
    index.Dispose();

    // The regression produced exactly a 60-byte empty header here.
    const customPath = join(fx.bundles2, 'LibGGPK3', '0.bundle.bin');
    assert.ok(existsSync(customPath), 'custom bundle LibGGPK3/0.bundle.bin missing');
    const size = statSync(customPath).size;
    assert.ok(size > 60, `custom bundle is an empty 60-byte header (size=${size})`);

    // Re-open and verify the written data survives.
    index = new Index(fx.indexPath);
    const hello2 = index.TryGetFile('test/hello.txt');
    assert.ok(hello2.Read().equals(newData), 'written data lost after re-open');
    assert.ok(index.TryGetFile('test/second.txt').Read().equals(SECOND), 'untouched file corrupted');
    index.Dispose();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('MaxBundleSize split writes multiple valid bundles (1.3.1 regression)', () => {
  const fx = makeFixture();
  try {
    const big1 = Buffer.alloc(1200, 0x11);
    const big2 = Buffer.alloc(500, 0x22);
    let index = new Index(fx.indexPath);
    index.MaxBundleSize = 1024; // force a flush after big1
    index.TryGetFile('test/hello.txt').Write(big1);
    index.TryGetFile('test/second.txt').Write(big2);
    index.Save();
    index.Dispose();

    for (const n of ['0', '1']) {
      const p = join(fx.bundles2, 'LibGGPK3', `${n}.bundle.bin`);
      assert.ok(existsSync(p), `custom bundle LibGGPK3/${n}.bundle.bin missing`);
      const size = statSync(p).size;
      assert.ok(size > 60, `custom bundle ${n} is an empty 60-byte header (size=${size})`);
    }

    index = new Index(fx.indexPath);
    assert.ok(index.TryGetFile('test/hello.txt').Read().equals(big1), 'big1 lost after split');
    assert.ok(index.TryGetFile('test/second.txt').Read().equals(big2), 'big2 lost after split');
    index.Dispose();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('customBundleBasePath reuses an existing TinyBundle (EasyFarm compatibility)', () => {
  const fx = makeFixture('TinyBundle/');
  try {
    const newData = Buffer.from('patched-content'.repeat(32));
    let index = new Index(fx.indexPath, { customBundleBasePath: 'TinyBundle/' });
    index.TryGetFile('test/hello.txt').Write(newData);
    index.Save();
    index.Dispose();

    // Must reuse TinyBundle/0, not create LibGGPK3/* or TinyBundle/1.
    assert.ok(!existsSync(join(fx.bundles2, 'LibGGPK3')), 'LibGGPK3/ must not be created with custom prefix');
    assert.ok(!existsSync(join(fx.bundles2, 'TinyBundle', '1.bundle.bin')), 'TinyBundle/1 must not be created');
    assert.ok(statSync(join(fx.bundles2, 'TinyBundle', '0.bundle.bin')).size > 60, 'TinyBundle/0 not rewritten');

    index = new Index(fx.indexPath, { customBundleBasePath: 'TinyBundle/' });
    assert.ok(index.TryGetFile('test/hello.txt').Read().equals(newData), 'TinyBundle write lost after re-open');
    assert.ok(index.TryGetFile('test/second.txt').Read().equals(SECOND), 'untouched file corrupted');
    index.Dispose();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// --- runner ----------------------------------------------------------------

let failed = 0;
const t0 = performance.now();
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
console.log(`\n${tests.length - failed}/${tests.length} tests passed, ${(performance.now() - t0).toFixed(0)}ms`);
process.exit(failed === 0 ? 0 : 1);
