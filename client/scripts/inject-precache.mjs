// Stamp the offline shell's file list and version into dist/sw.js.
// Runs after `vite build` (and after inject-sri, so index.html is final).
//
// The selection and versioning rules live in shell-manifest.mjs so they can
// be unit-tested; this file is the I/O around them.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectShell, shellVersion } from './shell-manifest.mjs';

// fileURLToPath (not URL.pathname) so a space in the project path decodes
// instead of staying %20 — same reason as inject-sri.
const dist = fileURLToPath(new URL('../dist', import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(dist);
// POSIX separators: these become URL paths, and the build may run on Windows.
const paths = files.map((f) => `/${relative(dist, f).split(sep).join('/')}`);
const assets = selectShell(paths);

if (assets.length === 0) {
  console.error('inject-precache: nothing selected for the shell — build layout changed?');
  process.exit(1);
}
if (!assets.includes('/index.html')) {
  // Without it the navigation fallback has nothing to serve and the app
  // cannot boot offline at all, which is the entire point.
  console.error('inject-precache: /index.html missing from dist — cannot build an offline shell');
  process.exit(1);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const version = shellVersion(
  assets.map((p) => [p, createHash('sha256').update(readFileSync(join(dist, p.slice(1)))).digest('hex')]),
  sha
);

const swPath = join(dist, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
if (!sw.includes('__SHELL_MANIFEST__')) {
  console.error('inject-precache: no __SHELL_MANIFEST__ placeholder in dist/sw.js');
  process.exit(1);
}
// JSON inside a single-quoted JS string: escape the quote JSON cannot contain
// on its own, and the backslashes that would eat it.
const json = JSON.stringify({ version, assets }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
writeFileSync(swPath, sw.replace('__SHELL_MANIFEST__', json));
console.log(`inject-precache: shell ${version} — ${assets.length} file(s) cached for offline boot`);
