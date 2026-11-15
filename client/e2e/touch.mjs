// Touch-target sweep (§8.5): on every main screen, in four touch contexts,
// each visible control a finger can hit must offer at least 44x44 CSS px.
//
// The hit area is the larger of the element's box and any ::before/::after
// that extends it (clipped by the ancestors that would clip it in the
// browser), or the <label> wrapping a checkbox. Disabled controls are
// skipped: nothing can tap them. Controls that are wide but short (a 354x32
// "Create account") fail like small ones: the floor is on both axes.
//
// Contexts: Pixel 7, a 390x844 phone, an 844x390 phone held sideways and a
// 1024x768 tablet, all with touch. The last two never reach the 820px phone
// tier, which is why this sweep exists: they used to get the desktop sizes.
//
// Each context starts its own relay and browser (lib.mjs), one after the
// other. Run after: crypto-core/build-wasm.sh, npm run build,
// cargo build -p relay.
//   npm run e2e:touch
// Env:
//   TOUCH_ONLY=pixel7,tablet   run some contexts only
//   TOUCH_PATCH=/path/x.css    append a stylesheet to every page (preview a
//                              fix before it lands in styles.css)
//   TOUCH_JSON=/path/out.json  write every measurement
//   E2E_PORT=9760              first port (one relay per context)
import { readFileSync, writeFileSync } from 'node:fs';
import { devices } from 'playwright';
import { startStack, freePort, online } from './lib.mjs';

const MIN = 44;

// The only exemptions: links inside a run of text (WCAG 2.5.8's inline
// exception), each named here with its reason. An entry is honoured only
// when the element really is an inline <a> beside text in the page, so this
// list cannot excuse a button. Keep it short: every line is a target
// someone on a phone will miss.
const ALLOW = [
  { sel: '.msg-line .text a', reason: 'a link inside a message body' },
  { sel: '.overview-blurb a', reason: 'a link inside the circle description' },
  { sel: '.notice-text a', reason: 'a link inside a pinned note' },
];

const PROFILES = {
  pixel7: { ...devices['Pixel 7'] },
  phone390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  tablet: { viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 2 },
};
const only = process.env.TOUCH_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
const profiles = Object.keys(PROFILES).filter((p) => !only || only.includes(p));
const PATCH = process.env.TOUCH_PATCH ? readFileSync(process.env.TOUCH_PATCH, 'utf8') : null;
const basePort = Number(process.env.E2E_PORT ?? 9760);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- the audit --
// Runs in the page. Self-contained: Playwright serialises it.
function audit({ min, allow }) {
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], [role=radio], [role=link], [tabindex]:not([tabindex="-1"])';
  const overlays = [...document.querySelectorAll('[role=dialog], [aria-modal=true], .palette')].filter((d) => d.getBoundingClientRect().width > 0);
  const scope = overlays.length ? overlays[overlays.length - 1] : document;
  const opacity = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
  const srOnly = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (n.classList.contains('sr-only') || /inset\(50%\)/.test(getComputedStyle(n).clipPath)) return true; } return false; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.pointerEvents !== 'none' && opacity(el) >= 0.05 && !srOnly(el) && !el.closest('[inert]');
  };
  // A scroll container clips to its scrollable extent (you can scroll a
  // target to you); overflow hidden/clip clips to its box.
  const clip = (from, r) => {
    let { left: l, top: t, right: R, bottom: B } = r;
    for (let n = from; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const p = n.getBoundingClientRect();
      const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
      if (cs.overflowX !== 'visible') {
        const scroll = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
        const a = scroll ? p.left + bl - n.scrollLeft : p.left, z = scroll ? a + n.scrollWidth : p.right;
        l = Math.max(l, a); R = Math.min(R, z);
      }
      if (cs.overflowY !== 'visible') {
        const scroll = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        const a = scroll ? p.top + bt - n.scrollTop : p.top, z = scroll ? a + n.scrollHeight : p.bottom;
        t = Math.max(t, a); B = Math.min(B, z);
      }
    }
    return { left: l, top: t, right: Math.max(l, R), bottom: Math.max(t, B) };
  };
  // ::before/::after hit area. Its containing block is the host when the
  // host is positioned, else the nearest positioned ancestor (the "stretched
  // target" pattern). It is clipped from that containing block outwards.
  const pseudo = (el, which) => {
    const cs = getComputedStyle(el, which);
    if (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || cs.pointerEvents === 'none') return null;
    if (cs.position !== 'absolute') return null;
    let cb = el;
    while (cb && cb !== document.body && getComputedStyle(cb).position === 'static') cb = cb.parentElement;
    if (!cb) return null;
    const cr = cb.getBoundingClientRect(), ccs = getComputedStyle(cb);
    const w = parseFloat(cs.width), h = parseFloat(cs.height), x = parseFloat(cs.left), y = parseFloat(cs.top);
    if (![w, h, x, y].every(Number.isFinite)) return null;
    const m = /matrix\(([^)]+)\)/.exec(cs.transform);
    const [tx, ty] = m ? m[1].split(',').map(parseFloat).slice(4, 6) : [0, 0];
    const L = cr.left + (parseFloat(ccs.borderLeftWidth) || 0) + x + tx, T = cr.top + (parseFloat(ccs.borderTopWidth) || 0) + y + ty;
    let r = { left: L, top: T, right: L + w, bottom: T + h };
    if (ccs.overflowX !== 'visible') { r.left = Math.max(r.left, cr.left); r.right = Math.min(r.right, cr.right); }
    if (ccs.overflowY !== 'visible') { r.top = Math.max(r.top, cr.top); r.bottom = Math.min(r.bottom, cr.bottom); }
    return clip(cb.parentElement, r);
  };
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const describe = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : ''}${[...el.classList].map((c) => '.' + c).join('')}`;
  // Inline text link: an <a> laid out inline inside a run of text.
  const inlineText = (el) => {
    if (el.tagName !== 'A' || getComputedStyle(el).display !== 'inline') return false;
    const p = el.parentElement;
    return !!p && [...p.childNodes].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim());
  };

  const out = [];
  const seen = new Set();
  for (const el of scope.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el.disabled || el.classList.contains('skip-link')) continue;
    const labels = el.labels ? [...el.labels].filter(visible) : [];
    const self = visible(el);
    if (!self && !labels.length) continue;
    const base = el.getBoundingClientRect();
    const parts = self ? [base] : [];
    for (const p of [pseudo(el, '::before'), pseudo(el, '::after')]) if (p && p.right > p.left && p.bottom > p.top) parts.push(p);
    for (const l of labels) parts.push(l.getBoundingClientRect());
    const anchor = parts[0];
    const used = parts.filter((p) => p === anchor || overlaps(p, anchor));
    const w = Math.max(...used.map((p) => p.right)) - Math.min(...used.map((p) => p.left));
    const h = Math.max(...used.map((p) => p.bottom)) - Math.min(...used.map((p) => p.top));
    const ok = w >= min - 0.5 && h >= min - 0.5;
    if (ok) { out.push({ ok }); continue; }
    const allowed = inlineText(el) ? allow.find((a) => el.matches(a.sel)) : null;
    out.push({
      ok: false,
      exempt: allowed ? allowed.reason : null,
      el: describe(el),
      name: label(el),
      size: `${Math.round(w)}x${Math.round(h)}`,
      box: `${Math.round(base.width)}x${Math.round(base.height)}`,
      shape: w >= min ? 'short' : h >= min ? 'narrow' : 'small',
    });
  }
  return out;
}

// ------------------------------------------------------------- the journey --
async function journey(name, port) {
  const stack = await startStack(port);
  const { base, browser } = stack;
  const results = [];
  const problems = [];
  const notes = [];
  // A touch member who has not answered the notifications ask yet (so the
  // prompt is on the tour), with a stand-in mic and camera for the call.
  const ctx = await browser.newContext({ ...PROFILES[name], acceptDownloads: true, bypassCSP: !!PATCH });
  await ctx.grantPermissions(['microphone', 'camera'], { origin: base.replace(/\/$/, '') }).catch(() => {});
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
      Notification.requestPermission = async () => 'denied';
    } catch { /* no Notification API */ }
    const md = navigator.mediaDevices;
    if (!md) return;
    md.getUserMedia = async (c) => {
      const s = new MediaStream();
      if (c?.audio) {
        const ac = new AudioContext();
        const dst = ac.createMediaStreamDestination();
        const o = ac.createOscillator();
        o.connect(dst);
        o.start();
        dst.stream.getAudioTracks().forEach((t) => s.addTrack(t));
      }
      if (c?.video) {
        const cv = Object.assign(document.createElement('canvas'), { width: 160, height: 120 });
        cv.getContext('2d').fillRect(0, 0, 160, 120);
        cv.captureStream(5).getVideoTracks().forEach((t) => s.addTrack(t));
      }
      return s;
    };
    md.enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'mic', label: 'Mic', groupId: 'g' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'g' },
    ];
  });
  if (PATCH) {
    await ctx.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.append(s);
      });
    }, PATCH);
  }
  const T = await ctx.newPage();
  // Page errors are reported, not failed on: this suite is about sizes, and
  // run.mjs owns correctness.
  T.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`));
  // A second member on a desktop, so there is someone to talk to and verify.
  const other = await stack.device('bob');
  const B = other.page;

  const vis = (sel) => T.locator(sel).first().isVisible().catch(() => false);
  const tap = (sel, timeout = 8000) => T.locator(sel).first().tap({ timeout });
  const checkOn = async (page, screen) => {
    await sleep(300);
    for (const r of await page.evaluate(audit, { min: MIN, allow: ALLOW })) results.push({ profile: name, screen, ...r });
  };
  const check = (screen) => checkOn(T, screen);
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${label}: ${e.message.split('\n')[0]}`);
    }
  };
  const board = async () => {
    if (await vis('[data-testid=phone-tab-board]')) await tap('[data-testid=phone-tab-board]');
    else await tap('[data-testid=channel-overview]');
    await T.waitForSelector('[data-testid=overview-pane]');
  };
  const roomOf = async (ch) => {
    await tap(`[data-testid=channel-${ch}]`);
    await T.waitForSelector(`[data-testid=composer][placeholder="Message #${ch}"]`);
  };
  const close = async () => {
    const x = T.locator('[role=dialog] [data-testid=close-modal], [data-testid=settings-close]').first();
    if (await x.isVisible().catch(() => false)) await x.tap({ timeout: 2000 }).catch(() => T.keyboard.press('Escape'));
    else await T.keyboard.press('Escape');
    await sleep(200);
  };
  const lineTap = async (text) => {
    const l = T.locator('.msg-line', { hasText: text }).first();
    await l.scrollIntoViewIfNeeded();
    const b = await l.boundingBox();
    await T.touchscreen.tap(b.x + Math.min(40, b.width / 4), b.y + b.height / 2);
    await sleep(250);
    return l;
  };

  try {
    await step('landing', async () => {
      await T.goto(base);
      await T.waitForSelector('[data-testid=handle-input]');
      await check('landing');
      await tap('[data-testid=tab-signin]');
      await check('sign in');
      await T.goto(base);
      await T.waitForSelector('[data-testid=handle-input]');
    });
    await step('recovery', async () => {
      await T.fill('[data-testid=handle-input]', 'tess');
      await tap('[data-testid=create-identity]');
      await T.waitForSelector('[data-testid=recovery-step]');
      await check('recovery');
      const dl = T.waitForEvent('download');
      await tap('[data-testid=download-recovery]');
      await dl;
      await T.check('[data-testid=confirm-saved]');
      await tap('[data-testid=enter-app]');
      await T.waitForSelector('[data-testid=circles-home]');
      await online(T);
    });
    await step('notifications prompt', async () => {
      await T.waitForSelector('[data-testid=notif-prompt]', { timeout: 8000 });
      await check('notifications prompt');
      await tap('[data-testid=notif-prompt-dismiss]');
    });
    await step('circles home', async () => {
      await check('circles home, empty');
      await tap('[data-testid=new-server]');
      await T.fill('[data-testid=new-server-name]', 'Hockey Club');
      await check('new circle form');
      await T.press('[data-testid=new-server-name]', 'Enter');
      await T.waitForSelector('[data-testid=channel-general]', { timeout: 20000 });
      await check('room, empty');
    });
    await step('board', async () => {
      await board();
      await check('board, new');
      await tap('[data-testid=overview-edit]');
      await T.fill('[data-testid=overview-event-title]', 'Season opener');
      const d = new Date(Date.now() + 3 * 86400e3);
      const p2 = (n) => String(n).padStart(2, '0');
      await T.fill('[data-testid=overview-event-at]', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T18:30`).catch(() => {});
      await T.fill('[data-testid=overview-blurb-input]', 'Under-12s and parents.');
      await tap('[data-testid=overview-add-link]');
      await T.fill('[data-testid=overview-link-label-0]', 'fixtures');
      await T.fill('[data-testid=overview-link-url-0]', 'https://example.com/fixtures');
      await check('board, editing');
      await tap('[data-testid=overview-save]');
      await T.waitForSelector('[data-testid=overview-link]');
      await tap('[data-testid=overview-notice-add]');
      await T.fill('[data-testid=overview-notice-input]', 'Bring shin pads on Saturday.');
      await tap('[data-testid=overview-notice-post]');
      await T.waitForSelector('[data-testid=overview-notice]');
      await tap('[data-testid=game-add-tile]');
      await T.fill('[data-testid=game-add-name]', 'Hex Gambit');
      await T.fill('[data-testid=game-add-url]', '/games/hexgambit.html');
      await check('board, adding a game');
      await tap('[data-testid=game-add-save]');
      await T.waitForSelector('[data-testid^=game-launch-]');
    });
    let url;
    await step('invite', async () => {
      if (await vis('[data-testid=create-invite]')) await tap('[data-testid=create-invite]');
      else {
        await tap('[data-testid=palette-hint]');
        await T.fill('.palette-input', 'invite');
        await T.keyboard.press('Enter');
      }
      await T.waitForSelector('[data-testid=invite-url]');
      url = await T.inputValue('[data-testid=invite-url]');
      await check('invite dialog');
      await close();
      // The landing an invite opens, on this same kind of device.
      const L = await (await browser.newContext({ ...PROFILES[name] })).newPage();
      await L.goto(url);
      await L.waitForSelector('[data-testid=handle-input]');
      await checkOn(L, 'invite landing');
      await L.context().close();
      await B.goto(url);
      await B.fill('[data-testid=handle-input]', 'bob');
      await B.click('[data-testid=join-fast]');
      await B.waitForSelector('[data-testid=channel-general]', { timeout: 30000 });
    });
    await step('rooms', async () => {
      await roomOf('general');
      for (const r of ['rides', 'kit', 'snacks', 'photos', 'matchday']) {
        await tap('[data-testid=new-room-menu]');
        await T.waitForSelector('[data-testid=new-channel]');
        if (r === 'rides') await check('room strip menu');
        await tap('[data-testid=new-channel]');
        await T.fill('[data-testid=new-channel-name]', r);
        if (r === 'rides') await check('new room, inline form');
        await T.press('[data-testid=new-channel-name]', 'Enter');
        await T.waitForSelector(`[data-testid=channel-${r}]`);
      }
    });
    await step('conversation', async () => {
      await roomOf('general');
      await B.click('[data-testid=channel-general]');
      await B.waitForSelector('[data-testid=composer][placeholder="Message #general"]');
      for (const t of ['training moved to 6pm on Thursday', 'who can drive on Saturday', 'match kit is in the van']) {
        await B.fill('[data-testid=composer]', t);
        await B.press('[data-testid=composer]', 'Enter');
        await B.waitForSelector(`text=${t}`);
      }
      await B.setInputFiles('[data-testid=attach-input]', { name: 'lineup.txt', mimeType: 'text/plain', buffer: Buffer.from('lineup\n') });
      await T.waitForSelector('text=match kit is in the van', { timeout: 15000 });
      for (const t of ['I can drive two kids', 'typo line to delete']) {
        await T.fill('[data-testid=composer]', t);
        await T.press('[data-testid=composer]', 'Enter');
        await T.waitForSelector(`.msg-line >> text=${t}`);
      }
      await sleep(800);
      await check('room with messages');
    });
    await step('message actions', async () => {
      const l = await lineTap('who can drive on Saturday');
      await check('message actions');
      await l.locator('[data-testid=react-add]').tap();
      await T.waitForSelector('[data-testid=react-picker]');
      await check('reaction picker');
      await T.locator('[data-testid=react-picker] button').first().tap();
      await sleep(300);
      await check('reaction on a message');
      await (await lineTap('training moved')).locator('[data-testid=msg-reply]').tap();
      await T.waitForSelector('[data-testid=reply-bar]');
      await check('replying');
      await tap('[data-testid=reply-cancel]');
      await (await lineTap('I can drive two kids')).locator('[data-testid=msg-edit]').tap();
      await T.waitForSelector('[data-testid=edit-bar]');
      await check('editing');
      await tap('[data-testid=edit-cancel]');
      await (await lineTap('typo line to delete')).locator('[data-testid=msg-del]').tap();
      await T.waitForSelector('[data-testid=msg-del-confirm]');
      await check('delete confirm');
      await tap('[data-testid=msg-del-confirm]');
    });
    await step('dialogs', async () => {
      await tap('[data-testid=channel-settings-general]');
      await T.waitForSelector('[role=dialog]');
      await check('room settings');
      await close();
      await board();
      await check('board, full');
      await tap('[data-testid=member-menu-bob]');
      await T.waitForSelector('[data-testid=remove-member-bob]');
      await check('member row menu');
      await T.keyboard.press('Escape');
      const v = T.locator('[data-testid=verify-bob], [data-testid=badge-unverified-bob]').first();
      await v.tap();
      await T.waitForSelector('[data-testid=safety-number]');
      await check('safety number');
      await close();
      await tap('[data-testid=circle-settings]');
      await T.waitForSelector('[role=dialog]');
      await check('circle settings');
      await close();
      await tap('[data-testid=open-settings]');
      await T.waitForSelector('[data-testid=settings-secure]');
      await check('settings');
      await tap('[data-testid=settings-secure]');
      await T.waitForSelector('[data-testid=secure-passkey], [data-testid=secure-password]');
      await check('secure account');
      await close();
      await close();
      await tap('[data-testid=palette-hint]');
      await T.waitForSelector('.palette-input');
      await check('command palette');
      await T.keyboard.press('Escape');
    });
    await step('circles home with a circle', async () => {
      if (await vis('[data-testid=phone-tab-circles]')) await tap('[data-testid=phone-tab-circles]');
      else await tap('[data-testid=masthead-home]');
      await T.waitForSelector('[data-testid=circles-home]');
      await check('circles home, one circle');
      await tap('[data-testid^=circles-open-]');
      await T.waitForSelector('[data-testid=channel-general]');
    });
    await step('call', async () => {
      await roomOf('general');
      await tap('[data-testid=voice-join-lounge]');
      await T.waitForSelector('[data-testid=call-stage]');
      await B.click('[data-testid=voice-join-lounge]').catch(() => {});
      await sleep(1500);
      await check('call stage');
      await tap('[data-testid=stage-back]');
      await sleep(500);
      await check('room during a call');
      if (await vis('[data-testid=masthead-call]')) await tap('[data-testid=masthead-call]');
      else await tap('[data-testid=call-bar-open]');
      await tap('[data-testid=stage-leave]');
    });
    await step('game', async () => {
      await board();
      await tap('[data-testid^=game-launch-]');
      await T.waitForSelector('[data-testid=game-stage]');
      await sleep(800);
      await check('game stage');
    });
  } finally {
    await stack.stop();
  }
  return { results, problems, notes };
}

// ------------------------------------------------------------------ report --
// One context at a time: four relays and browsers at once is enough load on
// a small CI runner to turn waits into flakes, and this suite is about sizes.
const runs = [];
let port = basePort;
for (const p of profiles) {
  port = await freePort(port);
  console.log(`touch: ${p} (port ${port})`);
  runs.push(await journey(p, port));
  port += 1;
}
const all = runs.flatMap((r) => r.results);
const problems = runs.flatMap((r, i) => r.problems.map((m) => `[${profiles[i]}] ${m}`));
const notes = [...new Set(runs.flatMap((r, i) => r.notes.map((m) => `[${profiles[i]}] ${m}`)))];
if (process.env.TOUCH_JSON) writeFileSync(process.env.TOUCH_JSON, JSON.stringify({ all, problems }, null, 1));

const failing = all.filter((r) => !r.ok && !r.exempt);
const exempt = all.filter((r) => !r.ok && r.exempt);
// One line per control: where it fails, at what size.
const byControl = new Map();
for (const f of failing) {
  const k = f.el.replace(/-(bob|tess|general|rides|kit|snacks|photos|matchday|lounge)(?=[\].]|$)/g, '-*').replace(/(game-[a-z]+|circles-[a-z]+|overview-notice-remove)-[\w-]+/g, '$1-*').replace(/\.(active|on|selected|pressed|muted-on)(?=[.\s]|$)/g, '');
  if (!byControl.has(k)) byControl.set(k, { name: f.name, seen: new Map() });
  const row = byControl.get(k);
  const where = `${f.profile}: ${f.size}`;
  if (!row.seen.has(where)) row.seen.set(where, f.screen);
}
console.log(`touch targets: ${all.length} checks across ${profiles.length} contexts, ${failing.length} under ${MIN}x${MIN}, ${exempt.length} exempt`);
for (const [k, row] of byControl) {
  console.log(`  FAIL ${k} "${row.name}"`);
  for (const [where, screen] of row.seen) console.log(`         ${where}  (first on: ${screen})`);
}
for (const p of problems) console.log(`  STEP ${p}`);
for (const n of notes) console.log(`  note ${n}`);
// A step that could not run is a failure too: its screen went unchecked.
process.exit(failing.length || problems.length ? 1 : 0);
