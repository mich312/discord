// Drive a short two-user session and screenshot the client. Dev tooling,
// not a test — useful for docs and eyeballing the visual register.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HTTP = 9700;
const RELAY = 9701;
const dir = new URL('.', import.meta.url).pathname;
const base = `http://127.0.0.1:${HTTP}/?relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY}/ws`)}`;
const out = process.env.SHOT_PATH ?? '/tmp/client.png';

const relayBin = new URL('../../target/debug/relay', import.meta.url).pathname;
const procs = [
  spawn(relayBin, [], { stdio: 'ignore', env: { ...process.env, RELAY_PORT: RELAY } }),
  spawn('node', ['serve.mjs'], { cwd: dir, stdio: 'ignore', env: { ...process.env, HTTP_PORT: HTTP } }),
];
process.on('exit', () => procs.forEach((p) => p.kill()));

async function onboard(page, handle) {
  await page.goto(base);
  await page.fill('[data-testid=handle-input]', handle);
  await page.click('[data-testid=create-identity]');
  await page.waitForSelector('[data-testid=recovery-step]');
  const downloadP = page.waitForEvent('download');
  await page.click('[data-testid=download-recovery]');
  await downloadP;
  await page.check('[data-testid=confirm-saved]');
  await page.click('[data-testid=enter-app]');
  await page.waitForSelector('.empty-state, [data-testid=self-name]');
}

await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const alice = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const bob = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

await onboard(alice, 'alice');
await alice.click('[data-testid=new-server]');
await alice.fill('[data-testid=new-server-name]', 'Race Team');
await alice.press('[data-testid=new-server-name]', 'Enter');
await alice.waitForSelector('[data-testid=composer]');

await onboard(bob, 'bob');
await bob.waitForFunction(() =>
  document.querySelector('[data-testid=conn-dot]')?.classList.contains('online')
);
await new Promise((r) => setTimeout(r, 800));

await alice.fill('[data-testid=add-member-input]', 'bob');
await alice.press('[data-testid=add-member-input]', 'Enter');
await bob.waitForSelector('[data-testid=channel-general]');

const script = [
  [alice, 'scrutineering passed, we are P4 on the grid'],
  [bob, 'nice. tyre pressures from this morning still good?'],
  [alice, 'dropped 0.2 up front, track temp is way up'],
];
for (const [page, text] of script) {
  await page.fill('[data-testid=composer]', text);
  await page.press('[data-testid=composer]', 'Enter');
  await new Promise((r) => setTimeout(r, 400));
}
await alice.click('[data-testid=new-channel]');
await alice.fill('[data-testid=new-channel-name]', 'logistics');
await alice.press('[data-testid=new-channel-name]', 'Enter');
await new Promise((r) => setTimeout(r, 600));

// An encrypted attachment (2x2 PNG) and a verified member for the shot.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC',
  'base64'
);
await alice.setInputFiles('[data-testid=attach-input]', {
  name: 'tyre-temps.png',
  mimeType: 'image/png',
  buffer: png,
});
await bob.waitForSelector('[data-testid=attachment-img]', { timeout: 15000 });
await bob.click('[data-testid=member-alice]');
await bob.waitForSelector('[data-testid=mark-verified]');
await bob.click('[data-testid=mark-verified]');
await new Promise((r) => setTimeout(r, 400));

await bob.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
process.exit(0);
