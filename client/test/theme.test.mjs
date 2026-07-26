// The app defaulted to dark for everyone and only ever stored a resolved
// theme, so a machine set to light mode still opened to carbon and there was
// no way to say "follow my system". These cover the tri-state that replaced
// it, and the CSS duplication that makes the system default survive first
// paint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readPref,
  writePref,
  resolveTheme,
  prefersLight,
  watchSystem,
  THEME_COLOR,
  STORAGE_KEY,
} from '../src/lib/theme.js';

/** Minimal localStorage stand-in. `fail: true` models private mode, where
 *  every access throws rather than returning null. */
function fakeStorage(seed = {}, { fail = false } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(k) {
      if (fail) throw new DOMException('denied');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (fail) throw new DOMException('denied');
      map.set(k, v);
    },
    removeItem(k) {
      if (fail) throw new DOMException('denied');
      map.delete(k);
    },
    has: (k) => map.has(k),
  };
}

/* ------------------------------------------------------------ reading -- */

test('a fresh profile has no preference, so it can follow the system', () => {
  assert.equal(readPref(fakeStorage()), null);
});

test('an explicit choice is read back exactly', () => {
  assert.equal(readPref(fakeStorage({ [STORAGE_KEY]: 'paper' })), 'paper');
  assert.equal(readPref(fakeStorage({ [STORAGE_KEY]: 'carbon' })), 'carbon');
});

test("the previous theme's name still resolves", () => {
  assert.equal(readPref(fakeStorage({ [STORAGE_KEY]: 'vellum' })), 'paper');
});

test('a corrupt value follows the system rather than pinning dark', () => {
  // The old code fell through to 'carbon' for anything it did not recognise,
  // which silently pinned a theme the user never picked.
  assert.equal(readPref(fakeStorage({ [STORAGE_KEY]: 'chartreuse' })), null);
});

test('storage that throws is survivable', () => {
  assert.equal(readPref(fakeStorage({}, { fail: true })), null);
  assert.equal(writePref('paper', fakeStorage({}, { fail: true })), false);
});

test('no storage at all is survivable', () => {
  // Node, a stripped-down embedded webview, tests.
  assert.equal(readPref(undefined), null);
  assert.equal(writePref('paper', undefined), true);
});

/* ------------------------------------------------------------ writing -- */

test('choosing a theme persists it', () => {
  const s = fakeStorage();
  assert.equal(writePref('paper', s), true);
  assert.equal(readPref(s), 'paper');
});

test('going back to the system clears the key rather than storing a value', () => {
  // Storing the *resolved* theme here is the bug this replaces: it would pin
  // whatever was showing at the moment the user asked to stop pinning.
  const s = fakeStorage({ [STORAGE_KEY]: 'carbon' });
  writePref(null, s);
  assert.equal(s.has(STORAGE_KEY), false);
  assert.equal(readPref(s), null);
});

/* ----------------------------------------------------------- resolving -- */

test('an explicit preference wins over the system', () => {
  assert.equal(resolveTheme('carbon', true), 'carbon');
  assert.equal(resolveTheme('paper', false), 'paper');
});

test('no preference follows the system', () => {
  assert.equal(resolveTheme(null, true), 'paper');
  assert.equal(resolveTheme(null, false), 'carbon');
});

test('an unknown preference is treated as no preference', () => {
  assert.equal(resolveTheme('chartreuse', true), 'paper');
});

test('every resolvable theme has a chrome colour', () => {
  for (const t of [resolveTheme(null, true), resolveTheme(null, false)]) {
    assert.match(THEME_COLOR[t], /^#[0-9a-f]{6}$/, `${t} needs a theme-color`);
  }
});

/* -------------------------------------------------------- system query -- */

test('the system preference is read from the media query', () => {
  assert.equal(prefersLight(() => ({ matches: true })), true);
  assert.equal(prefersLight(() => ({ matches: false })), false);
});

test('a browser without matchMedia keeps the historical dark default', () => {
  assert.equal(prefersLight(undefined), false);
  assert.equal(
    prefersLight(() => {
      throw new Error('unsupported');
    }),
    false,
  );
});

test('the system flipping mid-session is delivered, and unsubscribing stops it', () => {
  const listeners = new Set();
  const mm = () => ({
    matches: false,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  });
  const seen = [];
  const off = watchSystem((light) => seen.push(light), mm);
  for (const fn of listeners) fn({ matches: true });
  assert.deepEqual(seen, [true]);

  off();
  assert.equal(listeners.size, 0, 'listener must be released, or every remount leaks one');
  for (const fn of listeners) fn({ matches: false });
  assert.deepEqual(seen, [true], 'no delivery after unsubscribe');
});

test('unsubscribing is safe where the query is unsupported', () => {
  assert.doesNotThrow(() => watchSystem(() => {}, undefined)());
  assert.doesNotThrow(() => watchSystem(() => {}, () => ({}))());
});

/* ------------------------------------------------ the CSS that pairs it -- */

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/** Every `<selector> { ... }` rule in `text`, as [selector, body] pairs.
 *  Good enough for this stylesheet: flat rules, no nesting inside the parts
 *  we look at. */
function rules(text) {
  // Comments first: one sitting above a rule would otherwise be swallowed
  // into its selector, and these files are heavily commented.
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([m[1].trim(), m[2].replace(/\s+/g, ' ').trim()]);
  }
  return out;
}

/** Declarations keyed by property, so ordering differences don't count as drift. */
function decls(body) {
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      }),
  );
}

// Plain CSS cannot share one declaration body between a plain selector and a
// media query, so the paper palette is written twice. That is only safe if
// something checks it, which is this.
test('the system-preference paper palette matches the explicit one exactly', () => {
  const media = css.match(
    /@media \(prefers-color-scheme: light\) \{([\s\S]*?)\n\}\n/,
  );
  assert.ok(media, 'the prefers-color-scheme block must exist, or fresh installs default dark');

  const explicit = new Map(
    rules(css)
      .filter(([sel]) => sel.startsWith("[data-theme='paper']"))
      .map(([sel, body]) => [sel.replace("[data-theme='paper']", '').trim(), body]),
  );
  const system = new Map(
    rules(media[1])
      .filter(([sel]) => sel.startsWith(':root:not([data-theme])'))
      .map(([sel, body]) => [sel.replace(':root:not([data-theme])', '').trim(), body]),
  );

  assert.ok(explicit.size > 0 && system.size > 0, 'both forms must be present');
  assert.deepEqual(
    [...system.keys()].sort(),
    [...explicit.keys()].sort(),
    'a paper rule exists in one form but not the other — add the mirror',
  );
  for (const [key, body] of explicit) {
    assert.deepEqual(
      decls(system.get(key)),
      decls(body),
      `paper rule "${key || ':root'}" has drifted between the two forms`,
    );
  }
});

test('the paper palette carries a light color-scheme in both forms', () => {
  // Without it the browser paints form controls, scrollbars and the caret
  // dark on a light surface.
  const paper = rules(css).find(([sel]) => sel === "[data-theme='paper']");
  assert.equal(decls(paper[1])['color-scheme'], 'light');
});

test('the chrome colours match the surfaces they sit against', () => {
  // A theme-color that disagrees with --well leaves a visible seam under the
  // address bar, which is exactly the kind of thing nobody notices in review.
  const root = rules(css).find(([sel]) => sel === ':root');
  const paper = rules(css).find(([sel]) => sel === "[data-theme='paper']");
  assert.equal(decls(root[1])['--well'], THEME_COLOR.carbon);
  assert.equal(decls(paper[1])['--well'], THEME_COLOR.paper);
});
