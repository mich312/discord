// The integrity manifest: which artifacts it covers and how hashes are
// spelled. `inject-sri.mjs` already stamps index.html's asset tags and
// honestly documented that the worker and the wasm had no tag to carry one —
// this is the gap it named (plan §2.6).
//
// Only exercised during a build that needs wasm-pack, which is the slowest
// place in the repo to find a mistake, so the rules live apart from the I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { manifestFiles, sriHash, wasmPath } from '../scripts/integrity.mjs';

const DIST = [
  '/index.html',
  '/assets/index-a1b2c3.js',
  '/assets/index-d4e5f6.css',
  '/worker.js',
  '/sw.js',
  '/pkg/crypto_core.js',
  '/pkg/crypto_core_bg.wasm',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/integrity.json',
];

/* ------------------------------------------------------------ spelling -- */

test('a hash is spelled the way subresource integrity spells it', () => {
  // So a value from the manifest can be pasted into an `integrity=`
  // attribute, or compared with the ones inject-sri.mjs already emits.
  const digest = createHash('sha384').update('hello').digest();
  const got = sriHash(digest);
  assert.match(got, /^sha384-[A-Za-z0-9+/]+=*$/);
  assert.equal(got, `sha384-${digest.toString('base64')}`);
});

test('hashing is deterministic and content-sensitive', () => {
  const a = sriHash(createHash('sha384').update('one').digest());
  const b = sriHash(createHash('sha384').update('one').digest());
  const c = sriHash(createHash('sha384').update('two').digest());
  assert.equal(a, b);
  assert.notEqual(a, c);
});

/* ------------------------------------------------------------- what is -- */

test('every executable artifact is covered', () => {
  const files = manifestFiles(DIST);
  for (const need of [
    '/index.html',
    '/assets/index-a1b2c3.js',
    '/assets/index-d4e5f6.css',
    '/worker.js',
    '/pkg/crypto_core.js',
    '/pkg/crypto_core_bg.wasm',
  ]) {
    assert.ok(files.includes(need), `${need} must be in the manifest`);
  }
});

test('the service worker is covered even though nothing can enforce it', () => {
  // Nothing checks sw.js's hash at load time — but the manifest exists for
  // third-party verification, and the service worker is code. Leaving it out
  // would make the manifest quietly incomplete.
  assert.ok(manifestFiles(DIST).includes('/sw.js'));
});

test('non-executable files are left out', () => {
  // Padding the list with icons would make a real change harder to spot when
  // comparing two builds, which is the manifest's whole purpose.
  const files = manifestFiles(DIST);
  assert.equal(files.includes('/icons/icon-192.png'), false);
  assert.equal(files.includes('/manifest.webmanifest'), false);
});

test('the manifest does not list itself', () => {
  // It cannot contain its own hash, and listing it would invite someone to
  // check a value that can never match.
  assert.equal(manifestFiles(DIST).includes('/integrity.json'), false);
});

test('the list is sorted and deduplicated', () => {
  // Two builds of the same source must produce a diffable manifest.
  assert.deepEqual(manifestFiles(['/worker.js', '/index.html', '/worker.js']), [
    '/index.html',
    '/worker.js',
  ]);
});

test('garbage entries are ignored rather than crashed on', () => {
  assert.deepEqual(manifestFiles([null, 42, undefined, 'no-slash.js']), []);
  assert.deepEqual(manifestFiles(undefined), []);
});

/* ------------------------------------------------------------ the wasm -- */

test('the wasm the worker pins is identified unambiguously', () => {
  assert.equal(wasmPath(DIST), '/pkg/crypto_core_bg.wasm');
});

test('a build with no wasm is a hard failure, not a silent skip', () => {
  // Skipping would ship a worker whose integrity check never runs, which
  // looks exactly like one that passes.
  assert.throws(() => wasmPath(['/index.html']), /found 0/);
});

test('a build with two wasm files is a hard failure too', () => {
  // Ambiguity here means pinning the wrong one, which fails closed at load
  // time on every user's device.
  assert.throws(
    () => wasmPath(['/pkg/a_bg.wasm', '/pkg/b_bg.wasm']),
    /found 2/
  );
});

/* ------------------------------------------- the worker that consumes it -- */

const worker = readFileSync(fileURLToPath(new URL('../public/worker.js', import.meta.url)), 'utf8');

test('the worker still carries the placeholder the build replaces', () => {
  // Renaming it in one file and not the other fails the build; this fails
  // faster and says which two files disagree.
  assert.ok(
    worker.includes('__WASM_INTEGRITY__'),
    'inject-integrity.mjs looks for this exact token'
  );
});

test('an unbuilt worker skips the check instead of refusing to start', () => {
  // In dev the artifact changes on every rebuild, so there is nothing stable
  // to pin — and a dev worker that refused to boot would be worse than no
  // check at all.
  assert.match(worker, /startsWith\('__'\)/);
});

test('a failed check refuses to instantiate rather than warning', () => {
  // Running a crypto core that is not the one this build was tested with is
  // worse than not running. The failure must be a throw, not a console line.
  const guard = worker.slice(worker.indexOf('if (got !== WASM_INTEGRITY)'));
  assert.match(guard.slice(0, 400), /throw new Error/);
});

test('the worker checks before it instantiates, not after', () => {
  // Verifying a module that has already been instantiated proves nothing.
  const verify = worker.indexOf('got !== WASM_INTEGRITY');
  const instantiate = worker.indexOf('return init(bytes)');
  assert.ok(verify > 0 && instantiate > 0);
  assert.ok(verify < instantiate, 'the comparison must precede init()');
});
