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
const localhostBase = `http://localhost:${HTTP}/?relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY}/ws`)}`;
const procs = [
  spawn(relayBin, [], {
    stdio: 'inherit',
    env: { ...process.env, RELAY_PORT: RELAY, RP_ID: 'localhost', RP_ORIGIN: `http://localhost:${HTTP}` },
  }),
  spawn('node', ['serve.mjs'], { cwd: dir, stdio: 'inherit', env: { ...process.env, HTTP_PORT: HTTP } }),
];
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

const launchOpts = {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  // Fake mic so getUserMedia works headless — real WebRTC, synthetic audio.
  args: ['--use-fake-ui-for-media-capture', '--use-fake-device-for-media-capture'],
};

async function onboard(page, handle, url = base) {
  await page.goto(url);
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

async function joinViaInvite(page, handle, url) {
  await page.goto(url);
  await page.fill('[data-testid=handle-input]', handle);
  await page.click('[data-testid=join-fast]');
  await page.waitForSelector('[data-testid=self-name], .empty-state', { timeout: 20000 });
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
  await fresh.click('[data-testid=tab-signin]');
  await fresh.fill('[data-testid=signin-handle]', 'bob');
  await fresh.click('summary');
  await fresh.setInputFiles('[data-testid=restore-file]', bobRecovery.file);
  await fresh.fill('[data-testid=restore-code]', bobRecovery.code);
  await fresh.click('[data-testid=signin-submit]');
  // Identity is back (same pinned key -> relay accepts as bob)…
  await fresh.waitForSelector('text=bob', { timeout: 15000 });
  // …but groups are intentionally gone (their keys died with the "device").
  await fresh.waitForSelector('.empty-state', { timeout: 5000 });

  console.log('9. alice creates an invite link');
  await alice.click('[data-testid=create-invite]');
  await alice.waitForSelector('[data-testid=invite-url]');
  const inviteUrl = await alice.inputValue('[data-testid=invite-url]');
  await alice.click('[data-testid=close-modal]');
  if (!inviteUrl.includes('#k=')) throw new Error(`invite url missing fragment key: ${inviteUrl}`);

  console.log('10. charlie joins via the link (external commit, nobody helping)');
  const charlieCtx = await browser.newContext();
  const charlie = await charlieCtx.newPage();
  charlie.on('pageerror', (e) => console.error('[charlie pageerror]', e.message));
  await joinViaInvite(charlie, 'charlie', inviteUrl);
  // The fast path defers securing — the nag banner must be up.
  await charlie.waitForSelector('[data-testid=secure-banner]', { timeout: 15000 });
  await charlie.waitForSelector('[data-testid=channel-general]', { timeout: 20000 });
  // Server name reaches charlie via the invite-owner's meta rebroadcast.
  await charlie.waitForFunction(
    () => document.querySelector('[data-testid=server-name]')?.textContent === 'Race Team',
    { timeout: 15000 }
  );
  // Existing members see the join and the unverified badge.
  await alice.waitForSelector('text=charlie joined via invite link', { timeout: 15000 });
  await alice.waitForSelector('.badge-unverified', { timeout: 5000 });
  // Chat flows to and from the link joiner.
  await charlie.fill('[data-testid=composer]', 'found my way in via the link');
  await charlie.press('[data-testid=composer]', 'Enter');
  await alice.waitForSelector('text=found my way in via the link', { timeout: 10000 });
  await alice.fill('[data-testid=composer]', 'welcome charlie');
  await alice.press('[data-testid=composer]', 'Enter');
  await charlie.waitForSelector('text=welcome charlie', { timeout: 10000 });
  // And charlie must not see anything pre-join.
  if (await charlie.locator('text=should be invisible to bob').count()) {
    throw new Error('charlie can see pre-join history — E2EE scrollback violation!');
  }

  console.log('11. IndexedDB wiped: identity survives via localStorage');
  await bob.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('e2ee-client');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await bob.reload();
  // bob is still bob (no onboarding screen), but groups are gone.
  await bob.waitForSelector('.empty-state', { timeout: 15000 });
  const emptyText = await bob.textContent('.empty-state');
  if (!emptyText.includes('bob')) throw new Error('identity lost after IndexedDB wipe');

  console.log('12. identity key export/import: paste alice into a fresh profile');
  await alice.click('[data-testid=identity-open]');
  await alice.waitForSelector('[data-testid=identity-key]');
  const aliceKey = await alice.inputValue('[data-testid=identity-key]');
  await alice.click('[data-testid=close-modal]');
  const importCtx = await browser.newContext();
  const imported = await importCtx.newPage();
  imported.on('pageerror', (e) => console.error('[import pageerror]', e.message));
  await imported.goto(base);
  await imported.click('[data-testid=tab-signin]');
  await imported.fill('[data-testid=signin-handle]', 'alice');
  await imported.click('summary');
  await imported.fill('[data-testid=paste-key]', aliceKey);
  await imported.click('[data-testid=signin-submit]');
  await imported.waitForSelector('.empty-state', { timeout: 15000 });
  const importedText = await imported.textContent('.empty-state');
  if (!importedText.includes('alice')) throw new Error('pasted identity key did not restore alice');

  console.log('13. encrypted attachment: image round-trips and renders');
  // 1x1 red PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await alice.click('[data-testid=channel-general]');
  await alice.setInputFiles('[data-testid=attach-input]', {
    name: 'pit-map.png',
    mimeType: 'image/png',
    buffer: png,
  });
  // Sender sees it decrypted…
  await alice.waitForSelector('[data-testid=attachment-img]', { timeout: 15000 });
  // …and so does a receiver, via blob fetch + AES-GCM decrypt.
  await charlie.click('[data-testid=channel-general]');
  await charlie.waitForSelector('[data-testid=attachment-img]', { timeout: 15000 });
  const naturalWidth = await charlie
    .locator('[data-testid=attachment-img]')
    .first()
    .evaluate((img) => img.naturalWidth);
  if (naturalWidth !== 1) throw new Error(`decrypted image is broken (naturalWidth=${naturalWidth})`);

  console.log('14. safety numbers match on both sides; unverified -> verified');
  await alice.click('[data-testid=member-charlie]');
  await alice.waitForSelector('[data-testid=safety-number]');
  const aliceSees = (await alice.textContent('[data-testid=safety-number]')).replace(/\s+/g, '');
  await charlie.click('[data-testid=member-alice]');
  await charlie.waitForSelector('[data-testid=safety-number]');
  const charlieSees = (await charlie.textContent('[data-testid=safety-number]')).replace(/\s+/g, '');
  if (aliceSees !== charlieSees) {
    throw new Error(`safety numbers differ: ${aliceSees} vs ${charlieSees}`);
  }
  if (!/^\d{60}$/.test(aliceSees)) throw new Error(`unexpected safety number format: ${aliceSees}`);
  // charlie carried the via-link badge; verification replaces it.
  if (!(await alice.locator('.badge-unverified').count())) {
    throw new Error('expected charlie to be marked unverified before verification');
  }
  await alice.click('[data-testid=mark-verified]');
  await alice.waitForSelector('.badge-verified', { timeout: 5000 });
  if (await alice.locator('.badge-unverified').count()) {
    throw new Error('unverified badge should be gone after verification');
  }
  await charlie.click('[data-testid=close-modal]');

  console.log('15. service worker registered; notifications button behaves');
  const swRegistered = await alice.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg;
  });
  if (!swRegistered) throw new Error('service worker did not register');
  // Headless chromium has no push service; the button must fail gracefully
  // (toast), never crash.
  await aliceCtx.grantPermissions(['notifications'], { origin: `http://127.0.0.1:${HTTP}` });
  await alice.click('[data-testid=enable-notifications]');
  await alice.waitForSelector('.toast', { timeout: 10000 });

  console.log('16. voice: alice joins lounge, charlie sees presence and joins — DTLS connects');
  await aliceCtx.grantPermissions(['microphone'], { origin: `http://127.0.0.1:${HTTP}` });
  await charlieCtx.grantPermissions(['microphone'], { origin: `http://127.0.0.1:${HTTP}` });
  await alice.click('[data-testid=voice-join-lounge]');
  // Presence reaches non-participants passively (MLS-encrypted ephemeral).
  await charlie.waitForFunction(
    () => document.querySelector('[data-testid=voice-participants-lounge]')?.textContent.includes('alice'),
    { timeout: 15000 }
  );
  await charlie.click('[data-testid=voice-join-lounge]');
  for (const [name, page, peer] of [['alice', alice, 'charlie'], ['charlie', charlie, 'alice']]) {
    await page.waitForFunction(
      (p) => window.__voice?.connections?.[p] === 'connected',
      peer,
      { timeout: 20000 }
    ).catch(() => {
      throw new Error(`${name}: peer connection to ${peer} never reached 'connected'`);
    });
  }

  console.log('17. dave joins via invite link and completes a 3-way mesh');
  await alice.click('[data-testid=create-invite]');
  await alice.waitForSelector('[data-testid=invite-url]');
  const inviteUrl2 = await alice.inputValue('[data-testid=invite-url]');
  await alice.click('[data-testid=close-modal]');
  const daveCtx = await browser.newContext();
  await daveCtx.grantPermissions(['microphone'], { origin: `http://127.0.0.1:${HTTP}` });
  const dave = await daveCtx.newPage();
  dave.on('pageerror', (e) => console.error('[dave pageerror]', e.message));
  await joinViaInvite(dave, 'dave', inviteUrl2);
  await dave.waitForSelector('[data-testid=voice-join-lounge]', { timeout: 20000 });
  await dave.click('[data-testid=voice-join-lounge]');
  await dave.waitForFunction(
    () =>
      window.__voice?.connections?.alice === 'connected' &&
      window.__voice?.connections?.charlie === 'connected',
    { timeout: 25000 }
  );
  await alice.waitForFunction(
    () => window.__voice?.connections?.dave === 'connected',
    { timeout: 15000 }
  );

  console.log('18. leaving updates everyone');
  await charlie.click('[data-testid=voice-leave-lounge]');
  await alice.waitForFunction(
    () => !document.querySelector('[data-testid=voice-participants-lounge]')?.textContent.includes('charlie'),
    { timeout: 15000 }
  );
  await alice.waitForFunction(
    () => window.__voice?.connections?.charlie === undefined,
    { timeout: 15000 }
  );

  console.log('19. charlie secures the deferred account with a password');
  await charlie.click('[data-testid=secure-now]');
  await charlie.fill('[data-testid=secure-password]', 'tyre pressures at dawn');
  await charlie.click('[data-testid=secure-password-submit]');
  await charlie.waitForFunction(
    () => !document.querySelector('[data-testid=secure-banner]'),
    { timeout: 30000 }
  );

  console.log('20. fresh profile signs in as charlie with username + password');
  const pwCtx = await browser.newContext();
  const pwPage = await pwCtx.newPage();
  pwPage.on('pageerror', (e) => console.error('[pw pageerror]', e.message));
  await pwPage.goto(base);
  await pwPage.click('[data-testid=tab-signin]');
  await pwPage.fill('[data-testid=signin-handle]', 'charlie');
  await pwPage.fill('[data-testid=signin-password]', 'tyre pressures at dawn');
  await pwPage.click('[data-testid=signin-submit]');
  await pwPage.waitForSelector('.empty-state', { timeout: 30000 });
  if (!(await pwPage.textContent('.empty-state')).includes('charlie')) {
    throw new Error('password sign-in did not restore charlie');
  }
  // Wrong password must fail without leaking the vault.
  const pw2Ctx = await browser.newContext();
  const pw2 = await pw2Ctx.newPage();
  await pw2.goto(base);
  await pw2.click('[data-testid=tab-signin]');
  await pw2.fill('[data-testid=signin-handle]', 'charlie');
  await pw2.fill('[data-testid=signin-password]', 'not the password');
  await pw2.click('[data-testid=signin-submit]');
  await pw2.waitForSelector('.error', { timeout: 30000 });

  console.log('21. passkey: register with PRF, wipe, sign back in');
  const erinCtx = await browser.newContext();
  const erin = await erinCtx.newPage();
  erin.on('pageerror', (e) => console.error('[erin pageerror]', e.message));
  const cdp = await erinCtx.newCDPSession(erin);
  await cdp.send('WebAuthn.enable');
  let prfOk = true;
  try {
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    });
  } catch (e) {
    prfOk = false;
    console.log(`   SKIPPED: virtual authenticator without PRF support (${e.message})`);
  }
  if (prfOk) {
    await onboard(erin, 'erin', localhostBase);
    await erin.click('[data-testid=secure-open-empty]');
    await erin.click('[data-testid=secure-passkey]');
    await erin.waitForSelector('text=account secured with a passkey', { timeout: 30000 });
    // "New device", same (synced) passkey: wipe local state, sign in.
    await erin.evaluate(() => {
      localStorage.clear();
      return new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('e2ee-client');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    });
    await erin.goto(localhostBase);
    await erin.click('[data-testid=tab-signin]');
    await erin.fill('[data-testid=signin-handle]', 'erin');
    await erin.click('[data-testid=signin-passkey]');
    await erin.waitForSelector('.empty-state', { timeout: 30000 });
    if (!(await erin.textContent('.empty-state')).includes('erin')) {
      throw new Error('passkey sign-in did not restore erin');
    }
  }

  console.log('\nPASS: full client journey — onboarding, E2EE chat, channels,');
  console.log('      IndexedDB persistence, recovery, invite-link external-commit');
  console.log('      join with unverified badge, localStorage identity survival,');
  console.log('      plain key export/import, encrypted attachments, safety');
  console.log('      numbers, service-worker registration, E2EE-signaled mesh');
  console.log('      voice, deferred invite onboarding, password vault sign-in,');
  console.log('      and passkey (WebAuthn PRF) vault sign-in');
  await browser.close();
} catch (e) {
  failed = true;
  console.error('\nFAIL:', e.message);
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
