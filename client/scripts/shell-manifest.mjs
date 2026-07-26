// Which files make up the offline shell, and what version they are.
//
// Separated from the script that writes them so the rules can be tested
// without a `dist/` — the build is the one place a mistake here surfaces,
// and the build needs wasm-pack, so it is the slowest possible feedback loop.

/** Runtime data, not shell. Caching these would pin state or burn quota. */
const NEVER = [
  /^\/sw\.js$/, // the worker must always be fetched fresh, or it can never update itself
  /^\/blob\//, // attachments: large, and the origin quota is contested
  /^\/games\/.*\/state/, // per-game runtime state, if any
];

/** Files worth having offline even though nothing in index.html links them
 *  with a hash: the crypto worker, the wasm it loads, the manifest and the
 *  icons an installed PWA needs to render itself. */
const EXTRA = [/^\/worker\.js$/, /^\/manifest\.webmanifest$/, /^\/icons\//, /\.wasm$/];

/** Content-hashed by Vite, so safe to serve cache-first within a version. */
const HASHED = /^\/assets\//;

/**
 * Pick the shell from a flat list of paths relative to the dist root
 * (each starting with '/'). Order is stable so the manifest — and the
 * version derived from it — does not churn between otherwise identical
 * builds.
 */
export function selectShell(paths) {
  const keep = (p) =>
    !NEVER.some((re) => re.test(p)) && (HASHED.test(p) || EXTRA.some((re) => re.test(p)));
  const chosen = (paths ?? []).filter((p) => typeof p === 'string' && p.startsWith('/')).filter(keep);
  // index.html is the shell's entry point and is fetched by navigation
  // fallback rather than by path, but it still has to be *in* the cache.
  if ((paths ?? []).includes('/index.html')) chosen.push('/index.html');
  return [...new Set(chosen)].sort();
}

/**
 * The cache version. Derived from the content of every shell file, not from
 * a timestamp: two builds of the same source produce the same version, so a
 * redeploy of unchanged code does not evict a working cache — and any change
 * to any shell file does.
 *
 * `digest` is injected so this stays pure and testable.
 */
export function shellVersion(entries, digest) {
  // Path and hash both, so moving a file between names changes the version
  // even when the bytes do not.
  const lines = [...(entries ?? [])]
    .map(([path, hash]) => `${path} ${hash}`)
    .sort()
    .join('\n');
  return digest(lines).slice(0, 16);
}
