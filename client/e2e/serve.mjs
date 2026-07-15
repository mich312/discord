// Static server for the built client (dist/).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const dist = new URL('../dist', import.meta.url).pathname;
const port = Number(process.env.HTTP_PORT ?? 9700);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist)) {
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
}).listen(port, () => console.log(`client on http://127.0.0.1:${port}`));
