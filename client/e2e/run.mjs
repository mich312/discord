// Client e2e: the full user journey in two real browsers.
//   1. alice onboards (identity + forced recovery-key export), creates a
//      server and a channel
//   2. bob onboards; alice adds him by handle; encrypted chat both ways in
//      two channels
//   3. bob reloads — MLS state comes back from IndexedDB: history is intact
//      AND live ratchets still work (can send/receive after reload)
//   4. bob's recovery file + code restore his identity in a fresh browser
//      profile (account survives; group state intentionally does not)
// Run after: npm run build, cargo build -p relay.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const HTTP = 9700;
const RELAY = 9701;
const dir = new URL('.', import.meta.url).pathname;
const base = `http://127.0.0.1:${HTTP}/?relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY}/ws`)}`;

const relayBin = new URL('../../target/debug/relay', import.meta.url).pathname;
if (!existsSync(relayBin)) {
  console.error('relay binary missing — run: cargo build -p relay');
  process.exit(1);
}
const procs = [
  spawn(relayBin, [], { stdio: 'inherit', env: { ...process.env, RELAY_PORT: RELAY } }),
  spawn('node', ['serve.mjs'], { cwd: dir, stdio: 'inherit', env: { ...process.env, HTTP_PORT: HTTP } }),
];
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

async function onboard(page, handle) {
  await page.goto(base);
  await page.fill('[data-testid=handle-input]', handle);
  await page.click('[data-testid=create-identity]');
  await page.waitForSelector('[data-testid=recovery-step]');
  const code = (await page.textContent('[data-testid=recovery-code]')).trim();
  const downloadP = page.waitForEvent('download');
  await page.click('[data-testid=download-recovery]');
  const download = await downloadP;
  const file = await download.path();
  await page.check('[data-testid=confirm-saved]');
  await page.click('[data-testid=enter-app]');
  await page.waitForSelector(`[data-testid=self-name], .empty-state`);
  return { code, file };
}

let failed = false;
try {
  await new Promise((r) => setTimeout(r, 600)); // let servers bind

  const browser = await chromium.launch(launchOpts);
  // Separate storage per user — two devices, not two tabs of one profile.
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  for (const [name, page] of [['alice', alice], ['bob', bob]]) {
    page.on('pageerror', (e) => console.error(`[${name} pageerror]`, e.message));
    page.on('console', (m) => m.type() === 'error' && console.error(`[${name} console]`, m.text()));
  }

  console.log('1. alice onboards (identity + recovery gate)');
  await onboard(alice, 'alice');

  console.log('2. alice creates server "Race Team"');
  await alice.click('[data-testid=new-server]');
  await alice.fill('[data-testid=new-server-name]', 'Race Team');
  await alice.press('[data-testid=new-server-name]', 'Enter');
  await alice.waitForSelector('[data-testid=server-name]');
  await alice.waitForSelector('[data-testid=channel-general]');
  await alice.fill('[data-testid=composer]', 'first message — should be invisible to bob later');
  await alice.press('[data-testid=composer]', 'Enter');

  console.log('3. bob onboards');
  const bobRecovery = await onboard(bob, 'bob');
  // bob publishes KeyPackages just after coming online; wait for that.
  await bob.waitForFunction(
    () => document.querySelector('[data-testid=conn-dot]')?.classList.contains('online'),
    { timeout: 15000 }
  );
  await new Promise((r) => setTimeout(r, 800));

  console.log('4. alice adds bob by handle');
  await alice.fill('[data-testid=add-member-input]', 'bob');
  await alice.press('[data-testid=add-member-input]', 'Enter');
  await bob.waitForSelector('[data-testid=channel-general]', { timeout: 15000 });
  // Server name reaches bob via the encrypted meta rebroadcast.
  await bob.waitForFunction(
    () => document.querySelector('[data-testid=server-name]')?.textContent === 'Race Team',
    { timeout: 15000 }
  );
  const bobMembers = await bob.textContent('[data-testid=member-list]');
  if (!bobMembers.includes('alice') || !bobMembers.includes('bob')) {
    throw new Error(`bob's member list wrong: ${bobMembers}`);
  }

  console.log('5. encrypted chat, both directions');
  await alice.fill('[data-testid=composer]', 'welcome to the team, bob');
  await alice.press('[data-testid=composer]', 'Enter');
  await bob.waitForSelector('text=welcome to the team, bob', { timeout: 10000 });
  await bob.fill('[data-testid=composer]', 'glad to be here');
  await bob.press('[data-testid=composer]', 'Enter');
  await alice.waitForSelector('text=glad to be here', { timeout: 10000 });

  // The pre-join message must NOT be visible to bob (no scrollback).
  if (await bob.locator('text=should be invisible to bob').count()) {
    throw new Error('bob can see pre-join history — E2EE scrollback violation!');
  }

  console.log('6. second channel propagates encrypted');
  await alice.click('[data-testid=new-channel]');
  await alice.fill('[data-testid=new-channel-name]', 'logistics');
  await alice.press('[data-testid=new-channel-name]', 'Enter');
  await bob.waitForSelector('[data-testid=channel-logistics]', { timeout: 10000 });
  await alice.click('[data-testid=channel-logistics]');
  await alice.fill('[data-testid=composer]', 'trailer leaves at 6am');
  await alice.press('[data-testid=composer]', 'Enter');
  await bob.click('[data-testid=channel-logistics]');
  await bob.waitForSelector('text=trailer leaves at 6am', { timeout: 10000 });

  console.log('7. bob reloads — state must come back from IndexedDB');
  await bob.reload();
  await bob.waitForSelector('[data-testid=channel-general]', { timeout: 15000 });
  await bob.waitForFunction(
    () => document.querySelector('[data-testid=conn-dot]')?.classList.contains('online'),
    { timeout: 15000 }
  );
  // History survived:
  await bob.waitForSelector('text=welcome to the team, bob', { timeout: 10000 });
  // Ratchets survived — live traffic still decrypts, both directions:
  await alice.click('[data-testid=channel-general]');
  await alice.fill('[data-testid=composer]', 'post-reload ping');
  await alice.press('[data-testid=composer]', 'Enter');
  await bob.waitForSelector('text=post-reload ping', { timeout: 10000 });
  await bob.fill('[data-testid=composer]', 'post-reload pong');
  await bob.press('[data-testid=composer]', 'Enter');
  await alice.waitForSelector('text=post-reload pong', { timeout: 10000 });

  console.log('8. recovery: bob restores identity in a fresh profile');
  const freshCtx = await browser.newContext();
  const fresh = await freshCtx.newPage();
  fresh.on('pageerror', (e) => console.error('[fresh pageerror]', e.message));
  await fresh.goto(base);
  await fresh.click('text=restore');
  await fresh.setInputFiles('[data-testid=restore-file]', bobRecovery.file);
  await fresh.fill('[data-testid=restore-code]', bobRecovery.code);
  await fresh.click('[data-testid=restore-identity]');
  // Identity is back (same pinned key -> relay accepts as bob)…
  await fresh.waitForSelector('text=bob', { timeout: 15000 });
  // …but groups are intentionally gone (their keys died with the "device").
  await fresh.waitForSelector('.empty-state', { timeout: 5000 });

  console.log('\nPASS: full client journey — onboarding, E2EE chat, channels,');
  console.log('      IndexedDB persistence through reload, identity recovery');
  await browser.close();
} catch (e) {
  failed = true;
  console.error('\nFAIL:', e.message);
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
