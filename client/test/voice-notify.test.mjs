// Call reachability + mesh-recovery regressions: ring/join push-wake
// (notify), mute presence, probe reconciliation, and the DM auto-hangup
// when the other leg dies without a polite leave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceManager } from '../src/lib/voice.js';

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
  }
  addEventListener() {}
  stop() {
    this.readyState = 'ended';
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
    this.connectionState = 'new';
    this.remoteDescription = null;
  }
  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }
  async addIceCandidate() {}
  close() {
    this.signalingState = 'closed';
  }
}

function setupGlobals() {
  globalThis.RTCPeerConnection = FakePC;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => new FakeStream([new FakeTrack('audio')]),
      },
    },
  });
}

function makeManager(name, sent) {
  return new VoiceManager({
    me: name,
    send: async (server, content, notify) => sent.push({ content, notify }),
    onState: () => {},
  });
}

test('ringing a user asks the relay to push-wake exactly them', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.callUser('srv', 'bob');
  const ring = sent.find((s) => s.content.k === 'ring');
  assert.ok(ring, 'ring envelope went out');
  assert.deepEqual(ring.notify, ['bob'], 'the callee is push-woken');
  await vm.leave();
});

test('starting a call in an empty group room push-wakes the roster; joining a live one does not', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  const join1 = sent.find((s) => s.content.action === 'join');
  assert.equal(join1.notify, '*', 'first joiner wakes the circle');
  await vm.leave();

  sent.length = 0;
  // Someone is already in the room: no wake-up spam for late joiners.
  vm.track('srv', 'lounge', 'bob', true);
  await vm.join('srv', 'lounge');
  const join2 = sent.find((s) => s.content.action === 'join');
  assert.equal(join2.notify, undefined, 'joining a running call notifies nobody');
  await vm.leave();
});

test('a DM room join never blanket-notifies (the ring already did)', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'dm:alice+bob');
  const join = sent.find((s) => s.content.action === 'join');
  assert.equal(join.notify, undefined);
  await vm.leave();
});

test('mute state travels: envelope on toggle, flag on here, badge set maintained', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');

  vm.setMuted(true);
  assert.ok(
    sent.some((s) => s.content.k === 'voice' && s.content.action === 'mute'),
    'mute announced'
  );
  assert.equal(vm.hereEnvelope('lounge').muted, true, 'here replies carry the flag');

  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'here', muted: true });
  assert.ok(vm.mutedPeers.has('bob'), 'peer muted flag tracked from here');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'unmute' });
  assert.ok(!vm.mutedPeers.has('bob'), 'unmute clears it');
  await vm.leave();
});

test('probe reconciles presence: members gone while we were away disappear', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  // Learned before a disconnect: bob and carol in the lounge.
  vm.track('srv', 'lounge', 'bob', true);
  vm.track('srv', 'lounge', 'carol', true);
  await vm.probe('srv');
  assert.deepEqual(vm.participants('srv', 'lounge'), [], 'stale presence cleared');
  // Only bob answers the probe.
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'here' });
  assert.deepEqual(vm.participants('srv', 'lounge'), ['bob'], 'probe replies rebuild it');
});

test('a here reply never announces "started a call"; a join does', async () => {
  setupGlobals();
  const started = [];
  const vm = new VoiceManager({
    me: 'alice',
    send: async () => {},
    onState: () => {},
    onCallStarted: (server, channel, name) => started.push(name),
  });
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'here' });
  assert.deepEqual(started, [], 'catch-up here is not a call start');
  await vm.handleEnvelope('srv', 'lounge-2' && 'carol', { k: 'voice', ch: 'quiet', action: 'join' });
  assert.deepEqual(started, ['carol'], 'a real first join announces');
});

test('DM auto-hangup: dropping the only peer of a direct call leaves the room', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'dm:alice+bob');
  // Bob's leg exists, then dies without a polite leave (tab kill).
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'dm:alice+bob', action: 'join' });
  assert.ok(vm.peers.has('bob'));
  vm.dropPeer('bob');
  await new Promise((r) => setImmediate(r));
  assert.equal(vm.active, null, 'the dead 1:1 call ended instead of hanging forever');
});
