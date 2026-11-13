// Shared scaffolding for the browser suites: one relay process serving the
// built client on one origin (how it is deployed), separate browser contexts
// as separate devices, and the handful of gestures every journey repeats.
//
// Run after: crypto-core/build-wasm.sh, npm run build, cargo build -p relay.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** Start a relay on `port` serving the built client, and a browser. */
export async function startStack(port, env = {}) {
  const relayBin = here('../../target/debug/relay');
  const clientDir = here('../dist');
  if (!existsSync(relayBin)) throw new Error('relay binary missing — run: cargo build -p relay');
  if (!existsSync(clientDir)) throw new Error('client build missing — run: npm run build');
  let relay = null;
  const startRelay = async () => {
    relay = spawn(relayBin, [], {
      stdio: process.env.E2E_RELAY_LOG ? 'inherit' : 'ignore',
      env: {
        ...process.env,
        RELAY_PORT: port,
        CLIENT_DIR: clientDir,
        RP_ID: 'localhost',
        RP_ORIGIN: `http://localhost:${port}`,
        // These journeys create identities directly; the invite-only gate has
        // its own relay-level tests.
        OPEN_REGISTRATION: '1',
        ...env,
      },
    });
    await new Promise((r) => setTimeout(r, 800)); // let it bind
  };
  process.on('exit', () => relay?.kill());
  await startRelay();
  /** Stop the relay and start a new one on the same port. With the
      in-memory store that is a relay whose database was wiped. */
  const restartRelay = async () => {
    const gone = new Promise((r) => relay.once('exit', r));
    relay.kill();
    await gone;
    await startRelay();
  };
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-fake-ui-for-media-capture', '--use-fake-device-for-media-capture'],
  });
  const base = `http://127.0.0.1:${port}/`;

  /** A device: its own storage, so its own identity and ratchet. */
  async function device(label) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      try {
        // The first-run notifications ask sits on a modal backdrop; answer
        // it up front, as a user does before they get anywhere.
        localStorage.setItem('quorum-notif-prompted', '1');
      } catch {
        /* private mode */
      }
    });
    const watch = (page) => {
      page.on('pageerror', (e) => console.error(`[${label} pageerror]`, e.message));
      if (process.env.E2E_VERBOSE) {
        page.on('console', (m) => {
          if (m.type() === 'error' || m.type() === 'warning') console.error(`[${label} ${m.type()}]`, m.text());
        });
      }
      return page;
    };
    return { label, context, page: watch(await context.newPage()), newTab: async () => watch(await context.newPage()) };
  }

  return { base, browser, device, restartRelay, stop: () => browser.close().then(() => relay.kill()) };
}

export async function onboard(page, base, handle) {
  await page.goto(base);
  await page.fill('[data-testid=handle-input]', handle);
  await page.click('[data-testid=create-identity]');
  await page.waitForSelector('[data-testid=recovery-step]');
  const download = page.waitForEvent('download');
  await page.click('[data-testid=download-recovery]');
  await download;
  await page.check('[data-testid=confirm-saved]');
  await page.click('[data-testid=enter-app]');
  await page.waitForSelector('[data-testid=self-name], [data-testid=circles-home]');
  await online(page);
}

export const online = (page) =>
  page.waitForFunction(
    () => document.querySelector('[data-testid=conn-dot]')?.classList.contains('online'),
    { timeout: 15000 }
  );

/** Wait for a circle to be on screen (after a join, a reload, a sign-in). */
export const inCircle = (page, timeout = 20000) =>
  page.waitForSelector('[data-testid=channel-general]', { timeout });

/**
 * Open a room and wait until it is the room on screen.
 *
 * Not just a click: switching rooms swaps the composer, and text typed in
 * the instant between the click and the swap goes into the outgoing one and
 * is discarded with it. A person never types that fast; a script always
 * does, and "the message never sent" is then a test artefact that reads
 * exactly like the bug it is supposed to be looking for.
 */
export async function room(page, channel) {
  await page.click(`[data-testid=channel-${channel}]`);
  await page.waitForSelector(`[data-testid=composer][placeholder="Message #${channel}"]`, {
    timeout: 10000,
  });
}

export async function board(page) {
  await page.click('[data-testid=channel-overview]');
  await page.waitForSelector('[data-testid=overview-pane]', { timeout: 10000 });
}

export async function say(page, text) {
  await page.fill('[data-testid=composer]', text);
  await page.press('[data-testid=composer]', 'Enter');
  // Own line on screen before moving on: the next gesture should not race it.
  await page.waitForSelector(`text=${text}`, { timeout: 10000 });
}

/** Whether `text` shows up within `timeout`. Never throws. */
export const sees = (page, text, timeout = 10000) =>
  page.waitForSelector(`text=${text}`, { timeout }).then(
    () => true,
    () => false
  );

/** Create a circle from a fresh account and land in #general. */
export async function createCircle(page, name) {
  await page.click('[data-testid=new-server]');
  await page.fill('[data-testid=new-server-name]', name);
  await page.press('[data-testid=new-server-name]', 'Enter');
  await inCircle(page);
  await room(page, 'general');
}

/** Put `handle` forward from the board. In a circle of one that adds them;
    above that it opens a proposal the others sign. */
export async function propose(page, handle) {
  await board(page);
  await page.fill('[data-testid=add-member-input]', handle);
  await page.click('[data-testid=propose-member]');
}

/** Sign the proposal that is waiting on this member. */
export async function signProposal(page) {
  await board(page);
  await page.click('[data-testid^=overview-proposal-open-]', { timeout: 15000 });
  await page.click('[data-testid=signing-sign]');
  await page.click('[data-testid=signing-close]').catch(() => {});
}

export async function inviteLink(page) {
  await board(page);
  await page.click('[data-testid=create-invite]');
  await page.waitForSelector('[data-testid=invite-url]');
  const url = await page.inputValue('[data-testid=invite-url]');
  await page.click('[data-testid=close-modal]');
  return url;
}

/** A tiny check ledger: every expectation runs and is listed, and the suite
    fails at the end if any did not hold — so one failure does not hide the
    ones after it. */
export function ledger() {
  const rows = [];
  return {
    section: (title) => console.log(`\n${title}`),
    check(name, ok) {
      rows.push([name, !!ok]);
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    },
    failed: () => rows.filter(([, ok]) => !ok).map(([name]) => name),
  };
}
