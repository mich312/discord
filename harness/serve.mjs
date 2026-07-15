// Minimal static server for the harness page and the WASM pkg.
// No frameworks — Phase 1 has no UI, just a test surface.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(harnessDir, '..');
const port = Number(process.env.HTTP_PORT ?? 9600);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  // /pkg/* maps to the wasm-pack output; everything else to harness/
  const base = path.startsWith('/pkg/') ? join(repoRoot, 'crypto-core') : harnessDir;
  const file = normalize(join(base, path));
  if (!file.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
