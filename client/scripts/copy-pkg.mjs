// Copy the wasm-pack output into public/ so the worker can load it at
// runtime (/pkg/crypto_core.js) in both dev and built modes.
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../crypto-core/pkg', import.meta.url));
const dst = fileURLToPath(new URL('../public/pkg', import.meta.url));
if (!existsSync(src)) {
  console.error('crypto-core/pkg missing — run ../crypto-core/build-wasm.sh first');
  process.exit(1);
}
cpSync(src, dst, { recursive: true });
console.log('copied crypto-core/pkg -> public/pkg');
