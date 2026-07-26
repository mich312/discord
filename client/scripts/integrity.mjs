// What goes in the published integrity manifest, and how it is expressed.
//
// Separate from the script that writes it so the rules are testable without a
// `dist/` — the only place a mistake here would otherwise surface is a build
// that needs wasm-pack, which is the slowest feedback loop in the repo.

/** The subresource-integrity spelling, so a hash from this manifest can be
 *  pasted straight into an `integrity=` attribute or compared with the ones
 *  `inject-sri.mjs` already stamps onto index.html. */
export function sriHash(digestBytes) {
  let binary = '';
  for (const b of new Uint8Array(digestBytes)) binary += String.fromCharCode(b);
  return `sha384-${Buffer.from(binary, 'binary').toString('base64')}`;
}

/**
 * Which shipped files the manifest covers.
 *
 * Everything executable, plus the wasm. Deliberately *not* everything in
 * `dist`: icons and the web manifest cannot execute, and padding the list
 * with them would make a real change harder to spot in a diff of two builds.
 *
 * `sw.js` is included even though nothing can enforce its hash at load time.
 * The point of the manifest is third-party verification — someone comparing a
 * deployment against the hashes CI printed — and the service worker is code,
 * so leaving it out would make the manifest quietly incomplete.
 */
export function manifestFiles(paths) {
  const keep = (p) =>
    /^\/assets\/.+\.(js|css)$/.test(p) ||
    p === '/worker.js' ||
    p === '/sw.js' ||
    p === '/index.html' ||
    /^\/pkg\/.+\.(js|wasm)$/.test(p);
  return [...new Set((paths ?? []).filter((p) => typeof p === 'string' && keep(p)))].sort();
}

/** The wasm the worker pins. Exactly one, or the build is not what we think. */
export function wasmPath(paths) {
  const found = (paths ?? []).filter((p) => /^\/pkg\/.+_bg\.wasm$/.test(p));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one crypto-core wasm in the build, found ${found.length}: ${found.join(', ')}`
    );
  }
  return found[0];
}
