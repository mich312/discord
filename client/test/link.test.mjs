// Device-linking crypto: the sealed hand-off from a signed-in device to a
// fresh one. Round-trip, isolation between offers, and tamper-resistance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLinkOffer,
  parseLinkUrl,
  sealIdentity,
  openSealed,
  verifyCode,
} from '../src/lib/link.js';

const locOf = (url) => {
  const u = new URL(url);
  return { search: u.search, hash: u.hash, origin: u.origin, pathname: u.pathname };
};

test('a link offer round-trips the identity end to end', async () => {
  const offer = await createLinkOffer('https://quorum.example');
  const parsed = parseLinkUrl(locOf(offer.url));
  assert.ok(parsed, 'the offer url parses as a link');
  assert.deepEqual([...parsed.pub], [...offer.pub], 'the public key survives the url');

  const identity = crypto.getRandomValues(new Uint8Array(220));
  const { payload, code } = await sealIdentity(parsed.pub, identity);

  assert.equal(code, offer.code, 'both devices derive the same check code');
  const got = await openSealed(offer.privateKey, payload);
  assert.deepEqual([...got], [...identity], 'the new device recovers the exact identity');
});

test('a payload sealed to one offer will not open with another', async () => {
  const a = await createLinkOffer('https://q');
  const b = await createLinkOffer('https://q');
  const { payload } = await sealIdentity(a.pub, crypto.getRandomValues(new Uint8Array(64)));
  await assert.rejects(() => openSealed(b.privateKey, payload), 'wrong private key cannot decrypt');
});

test('a tampered payload fails authentication', async () => {
  const offer = await createLinkOffer('https://q');
  const { payload } = await sealIdentity(offer.pub, crypto.getRandomValues(new Uint8Array(64)));
  payload[payload.length - 1] ^= 0xff;
  await assert.rejects(() => openSealed(offer.privateKey, payload), 'AES-GCM rejects tampering');
});

test('parseLinkUrl distinguishes links from invites and junk', () => {
  assert.equal(parseLinkUrl(locOf('https://q/?j=abc#k=xyz')), null, 'invite url is not a link');
  assert.equal(parseLinkUrl(locOf('https://q/?link=abc')), null, 'link without a key is rejected');
  const ok = parseLinkUrl(locOf('https://q/?link=rv123#k=AQID'));
  assert.equal(ok.blobId, 'rv123');
});

test('verifyCode is a stable 6 digits for a given key', async () => {
  const pub = crypto.getRandomValues(new Uint8Array(65));
  const a = await verifyCode(pub);
  const b = await verifyCode(pub);
  assert.equal(a, b);
  assert.match(a, /^\d{6}$/);
});
