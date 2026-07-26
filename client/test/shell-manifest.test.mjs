// The service worker handled push and nothing else, so opening the app
// without a network showed a blank page — while every message you had ever
// read sat in IndexedDB on the same device. These cover which files make up
// the offline shell and how its cache version is derived. Both only run
// during a build that needs wasm-pack, which is the slowest place to find a
// mistake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectShell, shellVersion } from '../scripts/shell-manifest.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

const DIST = [
  '/index.html',
  '/assets/index-a1b2c3.js',
  '/assets/index-d4e5f6.css',
  '/worker.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/crypto_core_bg.wasm',
  '/sw.js',
  '/blob/abc123',
  '/games/chess/index.html',
];

/* ---------------------------------------------------------- selectShell -- */

test('the shell holds what the app needs to boot with no network', () => {
  const shell = selectShell(DIST);
  for (const need of [
    '/index.html',
    '/assets/index-a1b2c3.js',
    '/assets/index-d4e5f6.css',
    '/worker.js',
    '/crypto_core_bg.wasm',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
  ]) {
    assert.ok(shell.includes(need), `${need} must be cached`);
  }
});

test('the worker itself is never cached', () => {
  // A cached sw.js can never replace itself, which is how a service worker
  // becomes permanent.
  assert.equal(selectShell(DIST).includes('/sw.js'), false);
});

test('attachments are never cached', () => {
  // Large, and the origin quota is already contested — on iOS this app has
  // to fight for it against the message store.
  assert.equal(selectShell(DIST).includes('/blob/abc123'), false);
  assert.equal(selectShell(['/blob/x', '/blob/y/z']).length, 0);
});

test('unrelated files are left alone rather than swept in', () => {
  // A shell that grows to the whole dist is not a shell.
  assert.equal(selectShell(DIST).includes('/games/chess/index.html'), false);
});

test('the list is sorted and deduplicated', () => {
  // The version is derived from this list; churn here would evict a working
  // cache on a build that changed nothing.
  const a = selectShell(['/assets/b.js', '/assets/a.js', '/assets/a.js']);
  assert.deepEqual(a, ['/assets/a.js', '/assets/b.js']);
});

test('garbage entries are ignored, not crashed on', () => {
  assert.deepEqual(selectShell([null, 42, 'assets/no-slash.js', undefined]), []);
  assert.deepEqual(selectShell(undefined), []);
});

test('a dist with no index.html yields no entry point', () => {
  // The injector treats this as fatal; selectShell just reports the truth.
  assert.equal(selectShell(['/assets/a.js']).includes('/index.html'), false);
});

/* --------------------------------------------------------- shellVersion -- */

test('the same content gives the same version', () => {
  // A redeploy of unchanged code must not evict a working cache, which is
  // why this is a content hash and not a timestamp.
  const entries = [['/a.js', 'hash-a'], ['/b.js', 'hash-b']];
  assert.equal(shellVersion(entries, sha), shellVersion(entries, sha));
});

test('changed content gives a different version', () => {
  const before = shellVersion([['/a.js', 'hash-a']], sha);
  const after = shellVersion([['/a.js', 'hash-a2']], sha);
  assert.notEqual(before, after);
});

test('renaming a file changes the version even when the bytes do not', () => {
  const before = shellVersion([['/a.js', 'same']], sha);
  const after = shellVersion([['/b.js', 'same']], sha);
  assert.notEqual(before, after);
});

test('input order does not affect the version', () => {
  const a = shellVersion([['/a.js', '1'], ['/b.js', '2']], sha);
  const b = shellVersion([['/b.js', '2'], ['/a.js', '1']], sha);
  assert.equal(a, b);
});

test('the version is short enough to read in a cache name', () => {
  const v = shellVersion([['/a.js', '1']], sha);
  assert.equal(v.length, 16);
  assert.match(v, /^[0-9a-f]+$/);
});

/* --------------------------------------------- the worker that uses them -- */

const sw = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

test('the worker still carries the placeholder the build replaces', () => {
  // Renaming it in one file and not the other fails the build; this fails
  // faster and says why.
  assert.ok(sw.includes('__SHELL_MANIFEST__'), 'inject-precache.mjs looks for this exact token');
});

test('an unbuilt worker degrades to push-only instead of throwing', () => {
  // public/sw.js is served verbatim in dev. JSON.parse on the raw
  // placeholder would throw during evaluation and kill push with it.
  assert.match(sw, /startsWith\('__'\)/);
});

test('the worker deletes older shell caches on activate', () => {
  // Without this every deploy leaves its cache behind forever.
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /quorum-shell-/);
});
