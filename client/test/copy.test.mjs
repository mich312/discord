// §11.5 and §11.6 — the words the product does not say.
//
// Two lists, and they fail for different reasons.
//
// The protocol list (§11.5) is jargon leaking out of the crypto layer.
// *A non-technical organiser adding a friend was shown "has no published key
// packages (have they signed up?)".* The words are correct and the sentence
// is useless: it names the artefact that was missing rather than the person
// they typed or the thing that would fix it.
//
// The fear list (§11.6) is the product raising its voice. *A permanent
// undismissable red bar told users by name that they would be "gone
// forever", forty seconds after they joined.* A risk is stated once, calmly,
// next to the button that resolves it.
//
// Both are asserted at zero rather than against a ceiling, because unlike
// the spacing scale there is no migration to do: every one of these was a
// sentence somebody could rewrite in a minute, and all of them were.
//
// What counts as user-facing is deliberately narrow — JSX text, the
// attributes a screen reader or a tooltip reads, and the strings that reach
// a toast, a system message or a thrown error. `record.epoch` is not copy,
// and a lint that says it is gets switched off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));

const PROTOCOL = [
  'MLS', 'RFC 9420', 'epoch', 'epochs', 'ratchet', 'ratchets', 'KeyPackage',
  'key package', 'key packages', 'external commit', 'HKDF', 'AES-GCM',
  'Argon2id', 'forward secrecy',
];
const FEAR = ['forever', 'gone', 'lost', 'destroyed', 'you can never', 'refusing', 'danger'];

function sources(dir = root, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.jsx') || p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Blank out comments without moving any line or column. A rule about what
    the product says must not fire on a note about what it used to say. */
function decomment(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** Every string in a file that a user can actually read. */
function copyIn(src) {
  const s = decomment(src);
  const at = (i) => s.slice(0, i).split('\n').length;
  const out = [];
  const take = (re, group) => {
    for (const m of s.matchAll(re)) out.push([at(m.index), m[group]]);
  };
  // JSX text nodes — anything between tags with a word in it.
  take(/>([^<>{}]*[A-Za-z]{3}[^<>{}]*)</g, 1);
  // The attributes assistive tech and tooltips read.
  take(/\b(placeholder|title|aria-label|alt)=(?:\{)?["'`]([^"'`]+)["'`]/g, 2);
  // Toasts, palette entries, hints, notes.
  take(/\b(text|label|hint|note)\s*:\s*[`'"]([^`'"]+)[`'"]/g, 2);
  // Errors reach the user: every one of these is caught into a toast.
  take(/new Error\(\s*[`'"]([^`'"]+)[`'"]/g, 1);
  // System messages are written into the room everyone reads.
  take(/addSystemMessage\([^,]+,\s*[`'"]([^`'"]+)[`'"]/g, 1);
  return out;
}

function offenders(words) {
  const hits = [];
  for (const f of sources()) {
    for (const [line, text] of copyIn(readFileSync(f, 'utf8'))) {
      for (const w of words) {
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(text)) {
          hits.push(`${f.slice(root.length + 1)}:${line} [${w}] ${text.trim().slice(0, 80)}`);
        }
      }
    }
  }
  return hits;
}

test('no protocol vocabulary reaches user-facing copy', () => {
  const hits = offenders(PROTOCOL);
  assert.deepEqual(hits, [], `§11.5 — say what happened and what to do:\n${hits.join('\n')}`);
});

test('no fear vocabulary reaches user-facing copy', () => {
  const hits = offenders(FEAR);
  assert.deepEqual(hits, [], `§11.6 — state the risk once, calmly, beside its fix:\n${hits.join('\n')}`);
});

test('the lint reads copy and not code', () => {
  // The check is only worth having if it is narrow enough to stay switched
  // on, so its own scope is asserted: an identifier is not a sentence, and a
  // comment about a banned word is not the word.
  const sample = `
    const record = { epoch: 4 };            // epoch: an identifier
    // the epoch used to appear in this line
    /* and in this one, too: gone forever */
    const a = <p className="danger">all set</p>;
    const b = <p>this room keeps its history forever</p>;
  `;
  const found = copyIn(sample).map(([, t]) => t.trim());
  assert.ok(found.includes('this room keeps its history forever'), 'JSX text must be read');
  assert.ok(found.includes('all set'), 'JSX text must be read');
  assert.ok(!found.some((t) => t.includes('identifier')), 'code must not be read');
  assert.ok(!found.some((t) => t.includes('used to appear')), 'comments must not be read');
});
