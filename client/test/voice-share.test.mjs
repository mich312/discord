// Screen-share plumbing in the VoiceManager, exercised against mocked
// WebRTC/media APIs: share announcements, track add/remove + renegotiation
// offers, glare resolution, and presence bookkeeping. The real DTLS path is
// covered by the browser e2e; this pins the protocol logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceManager } from '../src/lib/voice.js';

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
    this.listeners = {};
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ??= []).push(fn);
  }
  stop() {
    this.readyState = 'ended';
  }
  end() {
    (this.listeners.ended ?? []).forEach((fn) => fn());
  }
}

class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

class FakePC {
  constructor() {
    this.senders = [];
    this.signalingState = 'stable';
    this.remoteDescription = null;
    this.offers = 0;
  }
  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    return sender;
  }
  removeTrack(sender) {
    this.senders = this.senders.filter((s) => s !== sender);
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    this.offers += 1;
    return { type: 'offer', sdp: `offer-${this.offers}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(desc) {
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    // An applied offer (incl. implicit rollback of our own) awaits our
    // answer; an applied answer settles us back to stable.
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  close() {
    this.signalingState = 'closed';
  }
}

function setupGlobals() {
  const displayTrack = new FakeTrack('video');
  globalThis.RTCPeerConnection = FakePC;
  // node's own `navigator` global is getter-only — shadow it wholesale.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => new FakeStream([new FakeTrack('audio')]),
        getDisplayMedia: async () => new FakeStream([displayTrack]),
      },
    },
  });
  return { displayTrack };
}

function makeManager(name, sent) {
  const vm = new VoiceManager({
    me: name,
    send: async (server, content) => sent.push(content),
    onState: () => {},
  });
  return vm;
}

test('startShare adds a video track to every peer, re-offers, and announces', async () => {
  const { displayTrack } = setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  // bob joins: alice (smaller name) builds the peer and makes the offer.
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer = vm.peers.get('bob');
  assert.ok(peer, 'peer for bob exists');
  assert.equal(peer.pc.offers, 1, 'initial offer went out');
  peer.pc.signalingState = 'stable'; // answer landed

  sent.length = 0;
  await vm.startShare();
  assert.ok(vm.share, 'local share is live');
  assert.ok(
    peer.pc.senders.some((s) => s.track === displayTrack),
    'display track rides the peer connection'
  );
  assert.equal(peer.pc.offers, 2, 'share triggered a renegotiation offer');
  const kinds = sent.map((c) => `${c.k}:${c.type ?? c.action}`);
  assert.ok(kinds.includes('rtc:offer'), 'renegotiation offer was sent');
  assert.ok(kinds.includes('voice:share'), 'share announcement was sent');
  assert.deepEqual(window_stateless_sharing(vm), ['alice']);
});

test('stopShare removes the track, re-offers, and retracts the announcement', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer = vm.peers.get('bob');
  peer.pc.signalingState = 'stable';
  await vm.startShare();
  peer.pc.signalingState = 'stable';

  sent.length = 0;
  await vm.stopShare();
  assert.equal(vm.share, null);
  assert.ok(!peer.pc.senders.some((s) => s.track.kind === 'video'), 'video sender removed');
  const kinds = sent.map((c) => `${c.k}:${c.type ?? c.action}`);
  assert.ok(kinds.includes('rtc:offer'), 'removal renegotiated');
  assert.ok(kinds.includes('voice:unshare'), 'unshare announcement was sent');
  assert.deepEqual(window_stateless_sharing(vm), []);
});

test('the browser "stop sharing" bar (track ended) tears the share down too', async () => {
  const { displayTrack } = setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.startShare();
  sent.length = 0;
  displayTrack.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(vm.share, null, 'share ended with the track');
  assert.ok(
    sent.some((c) => c.k === 'voice' && c.action === 'unshare'),
    'unshare announced'
  );
});

test('share presence: envelopes and here-with-sharing flag track remote sharers', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('zoe', sent); // zoe > bob: bob initiates, zoe answers
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'here', sharing: true });
  assert.deepEqual(window_stateless_sharing(vm), ['bob'], 'here carried the share flag');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'unshare' });
  assert.deepEqual(window_stateless_sharing(vm), []);
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'share' });
  assert.deepEqual(window_stateless_sharing(vm), ['bob']);
  // Leaving the room clears the sharer.
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'leave' });
  assert.deepEqual(window_stateless_sharing(vm), []);
});

test('a sharer in a different room does not show on my stage', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('zoe', sent);
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'strategy', action: 'share' });
  assert.deepEqual(window_stateless_sharing(vm), [], 'share is scoped to its room');
});

test('joining while someone shares: my here-reply carries the sharing flag', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.startShare();
  sent.length = 0;
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const here = sent.find((c) => c.k === 'voice' && c.action === 'here');
  assert.ok(here, 'here reply went out');
  assert.equal(here.sharing, true, 'here reply advertises the live share');
  // And the newly built peer already carries the display track.
  const peer = vm.peers.get('bob');
  assert.ok(
    peer.pc.senders.some((s) => s.track.kind === 'video'),
    'mid-share joiner gets the track in the first negotiation'
  );
});

test('renegotiation glare: the smaller name wins, the larger rolls back and answers', async () => {
  setupGlobals();
  const sent = [];
  // zoe (larger) has an offer in flight when alice's (smaller) offer arrives:
  // zoe must accept it (implicit rollback) and answer.
  const zoe = makeManager('zoe', sent);
  await zoe.join('srv', 'lounge');
  await zoe.handleEnvelope('srv', 'alice', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer = zoe.peers.get('alice');
  peer.pc.signalingState = 'have-local-offer'; // zoe's own renegotiation pending
  sent.length = 0;
  await zoe.handleEnvelope('srv', 'alice', { k: 'rtc', ch: 'lounge', to: 'zoe', type: 'offer', sdp: 'x' });
  assert.equal(peer.pc.remoteDescription?.sdp, 'x', 'zoe accepted the competing offer');
  assert.ok(
    sent.some((c) => c.k === 'rtc' && c.type === 'answer'),
    'zoe answered after rolling back'
  );

  // The mirror image: alice (smaller) ignores zoe's competing offer.
  const sent2 = [];
  const alice = makeManager('alice', sent2);
  await alice.join('srv', 'lounge');
  await alice.handleEnvelope('srv', 'zoe', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer2 = alice.peers.get('zoe');
  peer2.pc.signalingState = 'have-local-offer';
  const before = peer2.pc.remoteDescription;
  sent2.length = 0;
  await alice.handleEnvelope('srv', 'zoe', { k: 'rtc', ch: 'lounge', to: 'alice', type: 'offer', sdp: 'y' });
  assert.equal(peer2.pc.remoteDescription, before, 'alice ignored the losing offer');
  assert.equal(sent2.length, 0, 'and sent nothing back');
});

test('a stale answer after rollback is ignored instead of wedging the connection', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer = vm.peers.get('bob');
  peer.pc.signalingState = 'stable'; // nothing pending
  const before = peer.pc.remoteDescription;
  await vm.handleEnvelope('srv', 'bob', { k: 'rtc', ch: 'lounge', to: 'alice', type: 'answer', sdp: 'stale' });
  assert.equal(peer.pc.remoteDescription, before, 'unsolicited answer dropped');
});

test('leave stops the capture and clears every share trace', async () => {
  const { displayTrack } = setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.startShare();
  vm.remoteScreens.set('bob', new FakeStream([new FakeTrack('video')]));
  await vm.leave();
  assert.equal(vm.share, null);
  assert.equal(displayTrack.readyState, 'ended', 'capture track stopped');
  assert.equal(vm.remoteScreens.size, 0);
});

/** The `sharing` list exactly as the UI receives it via publish(). */
function window_stateless_sharing(vm) {
  let captured;
  const prev = vm.onState;
  vm.onState = (s) => {
    captured = s;
  };
  vm.publish();
  vm.onState = prev;
  return captured.sharing;
}
