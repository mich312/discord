// Milestone test: two real browser tabs exchange MLS-encrypted messages
// through the real relay (Phase 2). Run with `node e2e.mjs` after
// `npm install`, a WASM build (../crypto-core/build-wasm.sh), and
// `cargo build -p relay`. Set DATABASE_URL to exercise the postgres store;
// without it the relay uses its in-memory store.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HTTP = 9600;
const RELAY = 9601;
const dir = fileURLToPath(new URL('.', import.meta.url));

const relayBin = fileURLToPath(new URL('../target/debug/relay', import.meta.url));
if (!existsSync(relayBin)) {
  console.error(`relay binary not found at ${relayBin} — run: cargo build -p relay`);
  process.exit(1);
}
const procs = [
  // OPEN_REGISTRATION: both tabs register directly; the invite-only
  // registration gate has its own relay-level tests.
  spawn(relayBin, [], { stdio: 'inherit', env: { ...process.env, RELAY_PORT: RELAY, OPEN_REGISTRATION: '1' } }),
  spawn('node', ['serve.mjs'], { cwd: dir, stdio: 'inherit', env: { ...process.env, HTTP_PORT: HTTP } }),
];
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

const waitFor = async (fn, what, timeout = 15000) => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

let failed = false;
try {
  await new Promise((r) => setTimeout(r, 500)); // let servers bind

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = async (name, role) => {
    const p = await browser.newPage();
    p.on('pageerror', (e) => console.error(`[${name} pageerror]`, e.message));
    p.on('console', (m) => m.type() === 'error' && console.error(`[${name} console]`, m.text()));
    await p.goto(`http://127.0.0.1:${HTTP}/?name=${name}&role=${role}`);
    return p;
  };

  console.log('tab 1: alice creates the group');
  const alice = await page('alice', 'create');
  await waitFor(() => alice.evaluate(() => window.__state?.epoch === 0), 'alice group created');

  console.log('tab 2: bob joins via KeyPackage → Welcome');
  const bob = await page('bob', 'join');
  await waitFor(() => bob.evaluate(() => window.__state?.members?.length === 2), 'bob joined');

  const [aliceState, bobState] = await Promise.all([
    alice.evaluate(() => window.__state),
    bob.evaluate(() => window.__state),
  ]);
  console.log('alice:', JSON.stringify(aliceState), '\nbob:  ', JSON.stringify(bobState));
  if (aliceState.epoch !== 1 || bobState.epoch !== 1) throw new Error('epochs did not converge at 1');
  if (bobState.members.join() !== 'alice,bob') throw new Error(`unexpected members: ${bobState.members}`);

  console.log('alice → bob: encrypted message');
  await alice.fill('#input', 'hello bob, this is E2EE');
  await alice.press('#input', 'Enter');
  await waitFor(
    () => bob.evaluate(() => window.__log.some((l) => l.text === 'alice: hello bob, this is E2EE')),
    'bob decrypts alice’s message'
  );

  console.log('bob → alice: encrypted reply');
  await bob.fill('#input', 'hi alice, received loud and clear');
  await bob.press('#input', 'Enter');
  await waitFor(
    () => alice.evaluate(() => window.__log.some((l) => l.text === 'bob: hi alice, received loud and clear')),
    'alice decrypts bob’s reply'
  );

  console.log('\nPASS: two tabs exchanged MLS-encrypted messages via the relay');
  await browser.close();
} catch (e) {
  console.error('\nFAIL:', e.message);
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
