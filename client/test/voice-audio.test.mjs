// Audio-quality controls: mic DSP constraints (noise suppression / echo
// cancellation / auto gain), the mute control, and the mute-preservation
// guarantee when the mic is hot-swapped mid-call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceManager } from '../src/lib/voice.js';

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
    this.enabled = true;
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
    // A sender that can be re-tracked, like the real RTCRtpSender.
    const sender = { track, stream, async replaceTrack(t) { this.track = t; } };
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

// A minimal in-memory localStorage so persistence can be asserted.
class FakeLocalStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function setupGlobals(lastConstraints) {
  globalThis.RTCPeerConnection = FakePC;
  globalThis.localStorage = new FakeLocalStorage();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (c) => {
          if (lastConstraints) lastConstraints.value = c.audio;
          return new FakeStream([new FakeTrack('audio')]);
        },
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

test('mic DSP is on by default and rides the getUserMedia constraints', async () => {
  const last = {};
  setupGlobals(last);
  const vm = makeManager('alice', []);
  assert.deepEqual(vm.processing, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  await vm.join('srv', 'lounge');
  assert.equal(last.value.echoCancellation, true, 'echo cancellation requested');
  assert.equal(last.value.noiseSuppression, true, 'noise suppression requested');
  assert.equal(last.value.autoGainControl, true, 'auto gain requested');
  await vm.leave();
});

test('a stored "off" for a DSP flag is honoured on construction', async () => {
  setupGlobals();
  localStorage.setItem('quorum-audio-ns', '0');
  const vm = makeManager('alice', []);
  assert.equal(vm.processing.noiseSuppression, false, 'stored off survives a reload');
  assert.equal(vm.processing.echoCancellation, true, 'unstored stays on');
});

test('toggling a DSP flag persists it and re-opens the mic with the new constraint', async () => {
  const last = {};
  setupGlobals(last);
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  await vm.setAudioProcessing({ noiseSuppression: false });
  assert.equal(vm.processing.noiseSuppression, false);
  assert.equal(localStorage.getItem('quorum-audio-ns'), '0', 'off is persisted as 0');
  assert.equal(last.value.noiseSuppression, false, 'the live mic re-opened without suppression');
  // Turning it back on clears the stored key (default-on needs no marker).
  await vm.setAudioProcessing({ noiseSuppression: true });
  assert.equal(localStorage.getItem('quorum-audio-ns'), null, 'on clears the stored flag');
  await vm.leave();
});

test('mute announces itself so peers show the badge, and unmute clears it', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');

  vm.setMuted(true);
  assert.equal(vm.muted, true);
  assert.ok(
    sent.some((s) => s.content.k === 'voice' && s.content.action === 'mute'),
    'the mute is announced so peers show the badge'
  );

  sent.length = 0;
  vm.setMuted(false);
  assert.equal(vm.muted, false);
  assert.ok(
    sent.some((s) => s.content.action === 'unmute'),
    'the re-opened mic is announced'
  );
  await vm.leave();
});

test('leaving resets mute so the next call starts fresh', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  vm.setMuted(true);
  await vm.leave();
  assert.equal(vm.muted, false);
});

test('swapping the mic mid-call preserves the muted state on the new track', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  // A peer so there is a sender to replaceTrack on.
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  vm.setMuted(true);
  assert.ok(vm.active.stream.getAudioTracks().every((t) => !t.enabled), 'muted: track disabled');

  await vm.setInputDevice('some-other-mic');
  assert.equal(vm.muted, true, 'still muted after the swap');
  assert.ok(
    vm.active.stream.getAudioTracks().every((t) => !t.enabled),
    'the fresh mic track carries the mute — you are not silently re-opened'
  );
  await vm.leave();
});
