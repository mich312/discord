// Pin the wasm hash into the worker, and publish a manifest of every shipped
// executable artifact. Runs after `vite build` (and after inject-sri, so
// index.html is final).
//
// Two outputs:
//
//   dist/worker.js  — the __WASM_INTEGRITY__ placeholder replaced with the
//                     real SHA-384, so the worker refuses to instantiate a
//                     crypto core that is not the one this build shipped.
//
//   dist/integrity.json — every executable artifact and its hash. CI prints
//                     it, which is what makes the deployment checkable by
//                     someone who does not trust the server: fetch the files,
//                     hash them, compare against the build log.
//
// The honest limit, stated here and in docs/THREAT_MODEL.md §6.2: a hostile
// operator serves worker.js and this manifest too, so neither defends against
// one. What they catch is the wasm being wrong on its own — a partial deploy,
// a stale or poisoned cache, a CDN out of step with the page — and they give
// an outside party something specific to verify against.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestFiles, sriHash, wasmPath } from './integrity.mjs';

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

// POSIX separators: these are URL paths, and the build may run on Windows.
const paths = walk(dist).map((f) => `/${relative(dist, f).split(sep).join('/')}`);
const hashOf = (p) => sriHash(createHash('sha384').update(readFileSync(join(dist, p.slice(1)))).digest());

const wasm = wasmPath(paths);
const wasmHash = hashOf(wasm);

// --- pin it into the worker ------------------------------------------------
const workerPath = join(dist, 'worker.js');
const worker = readFileSync(workerPath, 'utf8');
if (!worker.includes('__WASM_INTEGRITY__')) {
  console.error('inject-integrity: no __WASM_INTEGRITY__ placeholder in dist/worker.js');
  process.exit(1);
}
writeFileSync(workerPath, worker.replace('__WASM_INTEGRITY__', wasmHash));

// --- publish the manifest --------------------------------------------------
// The worker is hashed AFTER the substitution above, so the manifest describes
// the bytes actually served rather than the template.
const files = manifestFiles(paths);
const manifest = {
  algorithm: 'sha384',
  wasm,
  files: Object.fromEntries(files.map((p) => [p, hashOf(p)])),
};
writeFileSync(join(dist, 'integrity.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`inject-integrity: pinned ${wasm} -> ${wasmHash}`);
console.log(`inject-integrity: ${files.length} artifact(s) in dist/integrity.json`);
for (const p of files) console.log(`  ${manifest.files[p]}  ${p}`);
