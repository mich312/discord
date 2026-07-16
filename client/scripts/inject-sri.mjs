// Subresource Integrity for the built page (plan §5.1): stamp sha384
// hashes onto the entry <script>/<link> tags so a tampered asset fails
// closed instead of executing. Runs after `vite build`.
//
// Honest scope: SRI covers what index.html references. The worker
// (/worker.js) and the wasm it loads have no tag to carry an integrity
// attribute — for those, the CSP (relay-served) and reproducible builds
// are the mitigation.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not URL.pathname) so a space in the project path — e.g.
// "Mobile Documents" under iCloud — decodes instead of staying %20.
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const htmlPath = join(dist, 'index.html');
let html = readFileSync(htmlPath, 'utf8');

const sri = (assetPath) => {
  const bytes = readFileSync(join(dist, assetPath));
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
};

let stamped = 0;
html = html.replace(
  /<(script|link)([^>]*?)\s(src|href)="(\/assets\/[^"]+)"([^>]*)>/g,
  (tag, el, pre, attr, asset, post) => {
    if (tag.includes('integrity=')) return tag;
    stamped += 1;
    return `<${el}${pre} ${attr}="${asset}"${post} integrity="${sri(asset)}">`;
  }
);

if (stamped === 0) {
  console.error('inject-sri: no /assets/ tags found in dist/index.html — build layout changed?');
  process.exit(1);
}
writeFileSync(htmlPath, html);
console.log(`inject-sri: stamped ${stamped} asset tag(s) in dist/index.html`);
