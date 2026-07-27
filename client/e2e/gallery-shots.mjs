// Screenshot the whole preview gallery: every view, both themes, desktop and
// mobile. Dev tooling, not a test — this is what a design review looks at, so
// the reviewer argues with pixels instead of with CSS.
//
//   node e2e/gallery-shots.mjs              # → /tmp/ui
//   SHOT_DIR=… node e2e/gallery-shots.mjs   # → somewhere else
//
// Needs no relay and no crypto core: preview.html renders the real components
// against mock state. Output is named `{viewport}-{theme}-{view}.png`.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 9750);
const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.env.SHOT_DIR ?? '/tmp/ui';
await mkdir(out, { recursive: true });

// Every view preview.jsx knows how to render, minus `boot`, which is a
// spinner and screenshots as noise.
const VIEWS = [
  'app', 'overview', 'overview-idle', 'emptychat', 'empty', 'banner',
  'onboarding', 'invited', 'call', 'call-share', 'game', 'palette',
  'modal-safety', 'modal-invite', 'modal-secure', 'modal-identity',
];

// On a phone the interesting question is the floor plan, not the modals.
const MOBILE_VIEWS = ['app', 'overview', 'onboarding', 'call', 'emptychat'];

// `touch` is load-bearing, not a detail: without it Playwright reports a
// hover-capable device, `@media (hover: none)` never matches, and every
// reveal-on-touch affordance stays hidden. A mobile shot taken that way
// renders a layout no phone user will ever see.
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, views: VIEWS, touch: false },
  { name: 'mobile', width: 390, height: 844, views: MOBILE_VIEWS, touch: true },
];

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
process.on('exit', () => vite.kill());

const base = `http://127.0.0.1:${PORT}/preview.html`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(base)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) {
  console.error(`vite never came up on :${PORT}`);
  process.exit(1);
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);

let n = 0;
for (const vp of VIEWPORTS) {
  // 2× so type rendering and hairlines survive the review.
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    hasTouch: vp.touch,
    isMobile: vp.touch,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`  ! ${e.message}`));
  for (const theme of ['carbon', 'paper']) {
    for (const view of vp.views) {
      await page.goto(`${base}?view=${view}&theme=${theme}`, { timeout: 20000 });
      // Mesh-orb avatars and the speaking meters settle a frame or two late.
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/${vp.name}-${theme}-${view}.png` });
      n++;
    }
  }
  await ctx.close();
}
await browser.close();
console.log(`${n} shots → ${out}`);
process.exit(0);
