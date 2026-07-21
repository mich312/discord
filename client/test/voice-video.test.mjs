// Opus SDP tuning (DTX + bitrate cap + FEC), camera video streams (a second
// video kind coexisting with screen share), and join/leave chimes — pinned
// against mocked WebRTC / media / WebAudio. The real DTLS path is covered by
// the browser e2e; this fixes the protocol + routing logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceManager, tuneOpus } from '../src/lib/voice.js';

let streamSeq = 0;

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
    this.enabled = true;
    this.listeners = {};
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ??= []).push(fn);
  }
  stop() {
    this.readyState = 'ended';
  }
  end() {
    this.readyState = 'ended';
    (this.listeners.ended ?? []).forEach((fn) => fn());
  }
}

class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
    this.id = `stream-${++streamSeq}`;
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
    const sender = { track, stream, async replaceTrack(t) { this.track = t; } };
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
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  close() {
    this.signalingState = 'closed';
  }
}

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

// Counts oscillator notes so chimes can be observed without real audio.
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
  }
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    return {
      type: '',
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {
        FakeAudioContext.notes += 1;
      },
      stop() {},
    };
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
  close() {
    return Promise.resolve();
  }
}
FakeAudioContext.notes = 0;

function setupGlobals() {
  streamSeq = 0;
  FakeAudioContext.notes = 0;
  globalThis.RTCPeerConnection = FakePC;
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.window = { AudioContext: FakeAudioContext };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (c) =>
          c.video ? new FakeStream([new FakeTrack('video')]) : new FakeStream([new FakeTrack('audio')]),
        getDisplayMedia: async () => new FakeStream([new FakeTrack('video')]),
      },
    },
  });
}

function makeManager(name, sent) {
  const states = [];
  const vm = new VoiceManager({
    me: name,
    send: async (server, content) => sent.push(content),
    onState: (st) => states.push(st),
  });
  vm._states = states;
  return vm;
}

const last = (vm) => vm._states.at(-1);

// === Opus SDP tuning =====================================================

test('tuneOpus merges DTX + bitrate + FEC into an existing opus fmtp line', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:0 PCMU/8000',
    '',
  ].join('\r\n');
  const out = tuneOpus(sdp);
  const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
  assert.match(fmtp, /usedtx=1/, 'DTX enabled');
  assert.match(fmtp, /maxaveragebitrate=32000/, 'bitrate capped');
  assert.match(fmtp, /useinbandfec=1/, 'existing FEC preserved');
  assert.match(fmtp, /minptime=10/, 'unrelated existing param preserved');
  assert.match(fmtp, /stereo=0/, 'forced mono');
  assert.ok(out.includes('a=rtpmap:0 PCMU/8000'), 'other codecs untouched');
});

test('tuneOpus inserts an fmtp line when opus has none', () => {
  const sdp = ['m=audio 9 x 111', 'a=rtpmap:111 opus/48000/2', 'a=rtpmap:0 PCMU/8000'].join('\r\n');
  const lines = tuneOpus(sdp).split('\r\n');
  const idx = lines.findIndex((l) => l.startsWith('a=rtpmap:111 opus'));
  assert.ok(lines[idx + 1].startsWith('a=fmtp:111'), 'fmtp inserted right after the rtpmap');
  assert.match(lines[idx + 1], /usedtx=1/);
});

test('tuneOpus leaves SDP without opus untouched', () => {
  const sdp = 'v=0\r\nm=video 9 x 96\r\na=rtpmap:96 VP8/90000';
  assert.equal(tuneOpus(sdp), sdp);
});

test('every offer and answer that goes out is opus-tuned', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  // Force createOffer/createAnswer to emit real opus SDP so tuning is visible.
  const OPUS = 'v=0\r\nm=audio 9 x 111\r\na=rtpmap:111 opus/48000/2\r\n';
  const origOffer = FakePC.prototype.createOffer;
  const origAnswer = FakePC.prototype.createAnswer;
  FakePC.prototype.createOffer = async function () {
    return { type: 'offer', sdp: OPUS };
  };
  FakePC.prototype.createAnswer = async function () {
    return { type: 'answer', sdp: OPUS };
  };
  try {
    await vm.join('srv', 'lounge');
    // alice < bob: alice offers.
    await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
    const offer = sent.find((c) => c.k === 'rtc' && c.type === 'offer');
    assert.match(offer.sdp, /usedtx=1/, 'outgoing offer carries the tuning');
    // zoe > alice: alice answers zoe's offer.
    sent.length = 0;
    const vm2 = makeManager('zoe', sent);
    await vm2.join('srv', 'lounge');
    await vm2.handleEnvelope('srv', 'alice', {
      k: 'rtc',
      ch: 'lounge',
      to: 'zoe',
      type: 'offer',
      sdp: OPUS,
    });
    const answer = sent.find((c) => c.k === 'rtc' && c.type === 'answer');
    assert.match(answer.sdp, /usedtx=1/, 'outgoing answer carries the tuning');
  } finally {
    FakePC.prototype.createOffer = origOffer;
    FakePC.prototype.createAnswer = origAnswer;
  }
});

// === Camera ==============================================================

test('startCamera adds a video track, announces with a stream id, and shows me on camera', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer = vm.peers.get('bob');
  peer.pc.signalingState = 'stable';

  sent.length = 0;
  await vm.startCamera();
  assert.ok(vm.camera, 'local camera is live');
  assert.ok(peer.pc.senders.some((s) => s.track.kind === 'video'), 'camera track rides the peer');
  const cam = sent.find((c) => c.k === 'voice' && c.action === 'camera');
  assert.ok(cam, 'camera announcement went out');
  assert.ok(cam.sid, 'the announcement carries the stream id');
  assert.deepEqual(last(vm).cameras, ['alice'], 'I show as on camera');
});

test('stopCamera removes the track and retracts the announcement', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const peer = vm.peers.get('bob');
  peer.pc.signalingState = 'stable';
  await vm.startCamera();
  peer.pc.signalingState = 'stable';

  sent.length = 0;
  await vm.stopCamera();
  assert.equal(vm.camera, null);
  assert.ok(!peer.pc.senders.some((s) => s.track.kind === 'video'), 'camera track removed');
  assert.ok(sent.some((c) => c.k === 'voice' && c.action === 'uncamera'), 'uncamera announced');
  assert.deepEqual(last(vm).cameras, []);
});

test('a here-reply advertises a live camera with its stream id', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('alice', sent);
  await vm.join('srv', 'lounge');
  await vm.startCamera();
  sent.length = 0;
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  const here = sent.find((c) => c.k === 'voice' && c.action === 'here');
  assert.equal(here.camera, true, 'here advertises the camera');
  assert.ok(here.cameraSid, 'and the id to route it');
  assert.ok(vm.peers.get('bob').pc.senders.some((s) => s.track.kind === 'video'), 'joiner gets the track up front');
});

test('a remote camera envelope records the sharer and the video kind', async () => {
  setupGlobals();
  const sent = [];
  const vm = makeManager('zoe', sent);
  await vm.join('srv', 'lounge');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'camera', sid: 'stream-remote' });
  assert.ok(vm.cameras.has('bob'), 'bob tracked as on camera');
  assert.equal(vm.videoKind.get('stream-remote'), 'camera', 'the stream id maps to camera');
  assert.deepEqual(last(vm).cameras, ['bob']);
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'uncamera' });
  assert.ok(!vm.cameras.has('bob'), 'uncamera clears it');
});

test('a video track that arrives before its announcement is parked, then routed', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  const stream = new FakeStream([new FakeTrack('video')]);
  // ontrack fires with no known kind yet.
  vm.attachRemoteVideo('bob', stream, stream.getVideoTracks()[0], undefined);
  assert.ok(vm.unroutedVideo.has(stream.id), 'parked awaiting its kind');
  assert.equal(vm.cameraStreamFor('bob'), null);
  // the announcement lands.
  vm.routeVideo(stream.id, 'camera');
  assert.equal(vm.cameraStreamFor('bob'), stream, 'now routed to the camera tile');
  assert.ok(!vm.unroutedVideo.has(stream.id), 'no longer parked');
});

test('one peer sharing screen AND camera routes each to its own tile', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  const screen = new FakeStream([new FakeTrack('video')]);
  const cam = new FakeStream([new FakeTrack('video')]);
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'share', sid: screen.id });
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'camera', sid: cam.id });
  vm.attachRemoteVideo('bob', screen, screen.getVideoTracks()[0], vm.videoKind.get(screen.id));
  vm.attachRemoteVideo('bob', cam, cam.getVideoTracks()[0], vm.videoKind.get(cam.id));
  assert.equal(vm.screenStreamFor('bob'), screen, 'screen tile has the screen');
  assert.equal(vm.cameraStreamFor('bob'), cam, 'camera tile has the camera');
});

test('leave stops the camera capture and clears all video maps', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  await vm.startCamera();
  const track = vm.camera.track;
  vm.remoteCameras.set('bob', new FakeStream([new FakeTrack('video')]));
  await vm.leave();
  assert.equal(vm.camera, null);
  assert.equal(track.readyState, 'ended', 'camera capture stopped');
  assert.equal(vm.remoteCameras.size, 0);
  assert.equal(vm.videoKind.size, 0);
});

// === Join / leave chimes =================================================

test('a remote join chimes, a here (catch-up) does not, and a leave chimes', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  FakeAudioContext.notes = 0;
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  assert.equal(FakeAudioContext.notes, 1, 'join chimed');
  await vm.handleEnvelope('srv', 'carol', { k: 'voice', ch: 'lounge', action: 'here' });
  assert.equal(FakeAudioContext.notes, 1, 'a catch-up here did not chime');
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'leave' });
  assert.equal(FakeAudioContext.notes, 2, 'leave chimed');
});

test('deafened silences chimes', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  vm.setDeafened(true);
  FakeAudioContext.notes = 0;
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  assert.equal(FakeAudioContext.notes, 0, 'no chime while deafened');
});

test('turning call sounds off persists and suppresses chimes', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  vm.setCallSounds(false);
  assert.equal(localStorage.getItem('quorum-call-sounds'), '0', 'preference persisted');
  FakeAudioContext.notes = 0;
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'lounge', action: 'join' });
  assert.equal(FakeAudioContext.notes, 0);
  // A fresh manager reads the stored preference.
  const vm2 = makeManager('alice', []);
  assert.equal(vm2.callSounds, false);
});

test('a join in a room I am not in never chimes', async () => {
  setupGlobals();
  const vm = makeManager('alice', []);
  await vm.join('srv', 'lounge');
  FakeAudioContext.notes = 0;
  await vm.handleEnvelope('srv', 'bob', { k: 'voice', ch: 'strategy', action: 'join' });
  assert.equal(FakeAudioContext.notes, 0, 'a join elsewhere is silent');
});
