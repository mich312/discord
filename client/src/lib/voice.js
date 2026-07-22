// Mesh voice channels (audio + optional screen share). Every signal
// (presence + SDP + ICE) travels as an MLS-encrypted ephemeral: the relay
// fans it out but can't read it, and — because MLS authenticates every
// message — the DTLS fingerprints inside the SDP arrive over an
// authenticated channel. That is the fingerprint verification: a relay
// that swapped SDP would fail MLS authentication.
//
// Envelope shapes (inside MLS plaintext):
//   {k:'voice', ch, action:'join'|'here'|'leave'|'probe'
//                        |'share'|'unshare'|'camera'|'uncamera'
//                        |'mute'|'unmute',
//    sharing?, shareSid?, camera?, cameraSid?, muted?}
//                                                — 'here' carries the live
//                                                  share/camera flags (with
//                                                  the stream id that routes
//                                                  the incoming video) so a
//                                                  joiner learns state up front
//   {k:'rtc', ch, to, type:'offer'|'answer'|'candidate', sdp?, cand?}
//
// A screen share and a camera are each one extra outgoing video track. They
// look identical on the wire (both are m=video), so every video announcement
// carries the MediaStream id (`sid`); the receiver maps that id to 'screen'
// or 'camera' and routes the arriving track to the right tile — which is what
// lets one person share their screen and show their face at the same time.
//
// Mesh rule: for each pair, the lexicographically smaller name makes the
// initial offer — no glare. Later renegotiation (screen share start/stop)
// can come from either side; collisions resolve with the same ordering:
// the smaller name's offer wins, the larger name rolls back and answers.
// Audio-only keeps mesh viable to ~6–8 participants; each video track is one
// more sender leg per peer, so camera + screen tighten that ceiling.

import { frameRms, levelFromRms, nextSpeaking } from './meter.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// Opus fmtp knobs we stamp onto every offer/answer. DTX stops the encoder
// sending steady packets through silence (big win in a mesh, where every
// participant is a separate uplink); the bitrate cap keeps a mono voice
// stream well under a music-grade default; FEC lets the decoder paper over
// isolated packet loss. Mono only — voice gains nothing from stereo.
const OPUS_PARAMS = {
  useinbandfec: '1',
  usedtx: '1',
  maxaveragebitrate: '32000',
  stereo: '0',
  'sprop-stereo': '0',
};

/** Merge OPUS_PARAMS into an existing `a=fmtp` parameter string. */
function mergeOpusParams(existing) {
  const params = {};
  for (const kv of existing.split(';')) {
    const t = kv.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq === -1) params[t] = null;
    else params[t.slice(0, eq)] = t.slice(eq + 1);
  }
  Object.assign(params, OPUS_PARAMS);
  return Object.entries(params)
    .map(([k, v]) => (v === null ? k : `${k}=${v}`))
    .join(';');
}

/** Rewrite an SDP so the Opus payload advertises DTX + a voice bitrate cap +
    FEC. Pure string surgery: finds the opus payload type(s), merges the knobs
    into their `a=fmtp` line (inserting one if absent), and leaves everything
    else — including non-opus codecs — untouched. A no-op on SDP with no
    opus line, so it is safe to run over every description unconditionally. */
export function tuneOpus(sdp) {
  if (!sdp || !/opus\/48000/i.test(sdp)) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const pts = [];
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (m) pts.push(m[1]);
  }
  if (!pts.length) return sdp;
  const handled = new Set();
  const out = lines.map((line) => {
    const fm = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fm && pts.includes(fm[1])) {
      handled.add(fm[1]);
      return `a=fmtp:${fm[1]} ${mergeOpusParams(fm[2])}`;
    }
    return line;
  });
  // Any opus payload without an fmtp line gets one right after its rtpmap.
  for (const pt of pts) {
    if (handled.has(pt)) continue;
    const idx = out.findIndex((l) => new RegExp(`^a=rtpmap:${pt} opus`, 'i').test(l));
    if (idx >= 0) out.splice(idx + 1, 0, `a=fmtp:${pt} ${mergeOpusParams('')}`);
  }
  return out.join(eol);
}

export class VoiceManager {
  /**
   * @param {{me: string, send: (server: string, content: object) => Promise<void>,
   *          onState: (state: object) => void, iceServers?: object[]}} opts
   */
  constructor(opts) {
    this.me = opts.me;
    this.send = opts.send;
    this.onState = opts.onState;
    this.onNotify = opts.onNotify ?? (() => {}); // transient user messages (toasts)
    // A room's presence went 0 -> 1: someone opened a call. The controller
    // drops a system line into the room's first text channel.
    this.onCallStarted = opts.onCallStarted ?? (() => {});
    this.muted = false; // my mic, track.enabled-level — peers hear silence
    this.iceServers = opts.iceServers ?? DEFAULT_ICE;
    this.active = null; // {server, channel, stream}
    this.ring = null; // incoming direct call awaiting our answer: {server, room, from}
    this.dial = null; // outgoing direct call we're ringing: {server, room, to}
    this.peers = new Map(); // name -> {pc, audio}
    // (server, channel) -> Set of names, maintained passively for everyone
    this.presence = new Map();
    // Screen sharing: my outgoing capture, who else is sharing (name ->
    // presence key, learned from share/here envelopes), and the remote
    // display streams as their video tracks arrive.
    this.share = null; // {stream, track}
    this.shares = new Map(); // name -> key(server, channel)
    this.remoteScreens = new Map(); // name -> MediaStream
    // Camera: mirror of the screen-share bookkeeping. A separate outgoing
    // video track, a map of who else has their camera on, and the remote
    // camera streams as they arrive.
    this.camera = null; // {stream, track}
    this.cameras = new Map(); // name -> key(server, channel)
    this.remoteCameras = new Map(); // name -> MediaStream
    // Incoming video is just m=video — this maps a stream id to what it is
    // ('screen'|'camera'), learned from the announcement that accompanies it.
    this.videoKind = new Map(); // stream.id -> 'screen' | 'camera'
    this.unroutedVideo = new Map(); // stream.id -> {name, stream, track} awaiting its kind
    this.mutedPeers = new Set(); // names that told us their mic is muted
    // Active-speaker metering (local + each remote), all client-side.
    this.levels = {}; // name -> 0..1 instantaneous loudness (read by the meter UI)
    this.speaking = new Set(); // names currently over the speaking threshold
    this.analysers = new Map(); // name -> { src, analyser, data }
    this.meterCtx = null;
    this.meterSink = null;
    this.meterRAF = null;
    // Preferred audio devices (persisted). Empty = system default. Output
    // routing (setSinkId) is what fixes "sound comes out of the wrong device".
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    this.inputDeviceId = ls?.getItem('quorum-audio-in') || null;
    this.outputDeviceId = ls?.getItem('quorum-audio-out') || null;
    // A short chime when someone joins or leaves the call you're in — on by
    // default. Synthesised with WebAudio so there is no asset to ship or fetch.
    this.callSounds = ls?.getItem('quorum-call-sounds') !== '0';
    this.chimeCtx = null;
    // Voice DSP the browser applies to the mic before it hits the wire. All
    // on by default — that is what turns "raw" capture into a call that
    // sounds like a call (echo gone, keyboard/fan hiss gate, level evened
    // out). Persisted so a user who wants the raw signal (musicians, good
    // hardware) can keep it off. A stored '0' means explicitly off; anything
    // else — including a first run with nothing stored — means on.
    this.processing = {
      echoCancellation: ls?.getItem('quorum-audio-ec') !== '0',
      noiseSuppression: ls?.getItem('quorum-audio-ns') !== '0',
      autoGainControl: ls?.getItem('quorum-audio-agc') !== '0',
    };
  }

  key(server, channel) {
    return `${server}\n${channel}`;
  }

  participants(server, channel) {
    return [...(this.presence.get(this.key(server, channel)) ?? [])].sort();
  }

  publish() {
    const activeKey = this.active ? this.key(this.active.server, this.active.channel) : null;
    const state = {
      active: this.active ? { server: this.active.server, channel: this.active.channel } : null,
      listenOnly: this.active ? !!this.listenOnly : false,
      muted: this.active ? !!this.muted : false,
      // Who has a live screen share in my current room (me included), and
      // whose display stream has actually arrived (a share announcement
      // lands before the renegotiated video track does).
      sharing: activeKey
        ? [
            ...(this.share ? [this.me] : []),
            ...[...this.shares.entries()].filter(([, k]) => k === activeKey).map(([n]) => n),
          ].sort()
        : [],
      screens: [...this.remoteScreens.keys()].sort(),
      // Who has their camera on in my room (me included), and whose camera
      // stream has actually arrived — same announce-then-track split as shares.
      cameras: activeKey
        ? [
            ...(this.camera ? [this.me] : []),
            ...[...this.cameras.entries()].filter(([, k]) => k === activeKey).map(([n]) => n),
          ].sort()
        : [],
      cams: [...this.remoteCameras.keys()].sort(),
      // Peers who told us their mic is muted (mic-off badge on their bubble).
      mutedPeers: [...this.mutedPeers].sort(),
      connections: Object.fromEntries(
        [...this.peers.entries()].map(([name, p]) => [name, p.pc.connectionState])
      ),
      presence: Object.fromEntries(
        [...this.presence.entries()].map(([k, v]) => [k.replace('\n', '/'), [...v].sort()])
      ),
      // Who is currently talking. Instantaneous per-name levels for the mini
      // waveforms live on window.__voiceLevels (updated every frame) so the
      // meters can animate smoothly without re-rendering React each tick.
      speaking: [...this.speaking].sort(),
      // Direct (1:1) calling: an incoming ring to answer, or an outgoing one
      // we're placing. `direct` names the peer when the active room is a DM.
      ring: this.ring ? { server: this.ring.server, room: this.ring.room, from: this.ring.from } : null,
      dial: this.dial ? { server: this.dial.server, room: this.dial.room, to: this.dial.to } : null,
      direct: this.active ? this.directPeer(this.active.channel) : null,
    };
    if (typeof window !== 'undefined') window.__voice = state;
    this.onState(state);
  }

  /** Persist and toggle the join/leave chime preference. */
  setCallSounds(on) {
    this.callSounds = !!on;
    this.persistDevice('quorum-call-sounds', on ? '' : '0');
    this.publish();
  }

  /** A short synthesised blip when someone comes or goes: a rising two-tone
      for a join, a falling one for a leave. No asset, no wire traffic — just
      a couple of oscillator notes on a lazily-created context. Suppressed
      when the user turned sounds off. */
  chime(kind) {
    if (!this.callSounds) return;
    if (typeof window === 'undefined') return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.chimeCtx) this.chimeCtx = new Ctx();
      const ctx = this.chimeCtx;
      ctx.resume?.().catch?.(() => {});
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const [f1, f2] = kind === 'join' ? [523.25, 783.99] : [659.25, 415.3];
      osc.frequency.setValueAtTime(f1, now);
      osc.frequency.setValueAtTime(f2, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    } catch {
      /* audio blocked or unavailable — a missing chime is not worth a throw */
    }
  }

  // === active-speaker metering ===========================================

  /** Tap `stream` with an AnalyserNode so we can measure how loud `name` is.
      Purely local analysis of media that is already flowing; adds nothing to
      the wire. */
  addMeter(name, stream) {
    if (!stream || this.analysers.has(name)) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!this.meterCtx) {
        this.meterCtx = new Ctx();
        // A silent sink keeps the graph pulling: an AnalyserNode with no path
        // to the destination isn't guaranteed to advance (it stays flat in
        // headless Chrome), and gain 0 means we never double-play the audio.
        this.meterSink = this.meterCtx.createGain();
        this.meterSink.gain.value = 0;
        this.meterSink.connect(this.meterCtx.destination);
      }
      this.meterCtx.resume?.().catch?.(() => {});
      const src = this.meterCtx.createMediaStreamSource(stream);
      const analyser = this.meterCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      analyser.connect(this.meterSink);
      this.analysers.set(name, { src, analyser, data: new Uint8Array(analyser.fftSize) });
      this.startMeter();
    } catch {
      /* a stream that can't be analysed just gets no meter */
    }
  }

  removeMeter(name) {
    const m = this.analysers.get(name);
    if (m) {
      try {
        m.src.disconnect();
        m.analyser.disconnect();
      } catch {
        /* already gone */
      }
      this.analysers.delete(name);
    }
    delete this.levels[name];
    this.speaking.delete(name);
  }

  startMeter() {
    if (this.meterRAF || typeof requestAnimationFrame === 'undefined') return;
    const tick = () => {
      let changed = false;
      for (const [name, m] of this.analysers) {
        m.analyser.getByteTimeDomainData(m.data);
        const rms = frameRms(m.data);
        this.levels[name] = levelFromRms(rms);
        const was = this.speaking.has(name);
        const now = nextSpeaking(was, rms);
        if (now !== was) {
          if (now) this.speaking.add(name);
          else this.speaking.delete(name);
          changed = true;
        }
      }
      if (typeof window !== 'undefined') window.__voiceLevels = this.levels;
      if (changed) this.publish(); // React re-renders only on start/stop talking
      this.meterRAF = requestAnimationFrame(tick);
    };
    this.meterRAF = requestAnimationFrame(tick);
  }

  stopMeter() {
    if (this.meterRAF && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.meterRAF);
    }
    this.meterRAF = null;
    for (const m of this.analysers.values()) {
      try {
        m.src.disconnect();
        m.analyser.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.analysers.clear();
    this.levels = {};
    this.speaking.clear();
    try {
      this.meterSink?.disconnect();
    } catch {
      /* already gone */
    }
    this.meterSink = null;
    this.meterCtx?.close?.().catch?.(() => {});
    this.meterCtx = null;
    if (typeof window !== 'undefined') window.__voiceLevels = {};
  }

  /** `announce`: whether a 0 -> 1 transition means a call actually started
      right now. 'here' replies to a probe describe a call that has been
      running — announcing those would drop a bogus "started a call" line
      on every reconnect. */
  track(server, channel, name, present, announce = true) {
    const key = this.key(server, channel);
    if (!this.presence.has(key)) this.presence.set(key, new Set());
    const set = this.presence.get(key);
    if (present && announce && set.size === 0) this.onCallStarted(server, channel, name);
    present ? set.add(name) : set.delete(name);
  }

  /** Mute/unmute my mic without renegotiating: the track keeps flowing,
      disabled tracks carry silence. Announced so peers can show a mic-off
      badge instead of wondering why someone is silent. */
  setMuted(muted) {
    this.applyMute(!!muted);
  }

  /** The wire-and-track half of muting. */
  applyMute(muted) {
    this.muted = !!muted;
    const stream = this.active?.stream;
    if (stream) for (const t of stream.getAudioTracks()) t.enabled = !this.muted;
    if (this.active) {
      this.send(this.active.server, {
        k: 'voice',
        ch: this.active.channel,
        action: this.muted ? 'mute' : 'unmute',
      }).catch(() => {});
    }
    this.publish();
  }

  /** Mic if available; otherwise a silent WebAudio track — joining
      listen-only beats being locked out, and the peer connection stays
      symmetric (audio m-line in both directions) either way. */
  async captureAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraint() });
      this.listenOnly = false;
      return stream;
    } catch {
      // A pinned input device that's since been unplugged throws — fall back
      // to the system default before giving up to listen-only.
      if (this.inputDeviceId) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.listenOnly = false;
          return stream;
        } catch {
          /* fall through to silent track */
        }
      }
    }
    {
      const ctx = new AudioContext();
      const destination = ctx.createMediaStreamDestination();
      this.audioCtx = ctx; // no source connected -> silence
      this.listenOnly = true;
      return destination.stream;
    }
  }

  audioConstraint() {
    const c = { ...this.processing };
    if (this.inputDeviceId) c.deviceId = { exact: this.inputDeviceId };
    return c;
  }

  /** Re-open the mic with the current device + processing constraints and
      hot-swap it into every live peer connection, preserving mute state.
      Shared by the device picker and the DSP toggles; requires an active
      call (both callers guard). Throws if the new device won't open so the
      caller can keep the old capture. */
  async recaptureMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraint() });
    const track = stream.getAudioTracks()[0];
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(track).catch(() => {});
    }
    this.active.stream.getTracks().forEach((t) => t.stop());
    this.active.stream = stream;
    // Carry the current mute state onto the fresh track — otherwise swapping
    // devices (or toggling noise suppression) mid-call silently un-mutes you.
    for (const t of stream.getAudioTracks()) t.enabled = !this.muted;
    this.removeMeter(this.me);
    this.addMeter(this.me, stream);
    this.listenOnly = false;
  }

  /** Toggle mic DSP (echo cancellation / noise suppression / auto gain).
      Persisted, and applied live to an in-progress call by re-opening the
      mic with the new constraints. */
  async setAudioProcessing(patch) {
    this.processing = { ...this.processing, ...patch };
    this.persistDevice('quorum-audio-ec', this.processing.echoCancellation ? '' : '0');
    this.persistDevice('quorum-audio-ns', this.processing.noiseSuppression ? '' : '0');
    this.persistDevice('quorum-audio-agc', this.processing.autoGainControl ? '' : '0');
    if (this.active && !this.listenOnly) {
      try {
        await this.recaptureMic();
      } catch {
        /* keep the current capture if re-opening the mic fails */
      }
    }
    this.publish();
  }

  persistDevice(key, id) {
    if (typeof localStorage === 'undefined') return;
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  }

  /** Persist and apply the output device to every live call leg (setSinkId).
      This is the fix for "audio plays out of the wrong device". */
  async setOutputDevice(id) {
    this.outputDeviceId = id || null;
    this.persistDevice('quorum-audio-out', this.outputDeviceId);
    for (const peer of this.peers.values()) {
      if (peer.audio?.setSinkId) await peer.audio.setSinkId(id || '').catch(() => {});
    }
  }

  /** Persist the input device and hot-swap the mic on any active call. */
  async setInputDevice(id) {
    this.inputDeviceId = id || null;
    this.persistDevice('quorum-audio-in', this.inputDeviceId);
    if (!this.active) return; // otherwise it applies on the next join
    try {
      await this.recaptureMic();
      this.publish();
    } catch {
      /* keep the current mic if the chosen device won't open */
    }
  }

  async join(server, channel) {
    if (this.active) await this.leave();
    const stream = await this.captureAudio();
    this.muted = false; // every call starts open-mic; muting is a per-call act
    // Joining an *empty* group room starts a call: push-wake the roster so
    // members with the app closed learn about it (a 1:1 room rings its one
    // peer explicitly instead — see callUser).
    const startsCall =
      this.participants(server, channel).length === 0 && !this.directPeer(channel);
    this.active = { server, channel, stream };
    this.addMeter(this.me, stream); // show my own level even before anyone joins
    this.track(server, channel, this.me, true);
    await this.send(server, { k: 'voice', ch: channel, action: 'join' }, startsCall ? '*' : undefined);
    this.publish();
  }

  async leave() {
    if (!this.active) return;
    const { server, channel, stream } = this.active;
    await this.send(server, { k: 'voice', ch: channel, action: 'leave' }).catch(() => {});
    for (const [, peer] of this.peers) this.teardownPeer(peer);
    this.peers.clear();
    this.stopMeter();
    stream.getTracks().forEach((t) => t.stop());
    // Leaving implies unshare / camera-off — no capture outlives the call.
    if (this.share) {
      this.share.stream.getTracks().forEach((t) => t.stop());
      this.share = null;
    }
    if (this.camera) {
      this.camera.stream.getTracks().forEach((t) => t.stop());
      this.camera = null;
    }
    this.remoteScreens.clear();
    this.remoteCameras.clear();
    this.cameras.clear();
    this.videoKind.clear();
    this.unroutedVideo.clear();
    this.mutedPeers.clear();
    this.audioCtx?.close?.().catch?.(() => {});
    this.audioCtx = null;
    this.chimeCtx?.close?.().catch?.(() => {});
    this.chimeCtx = null;
    this.track(server, channel, this.me, false);
    this.active = null;
    this.muted = false; // a fresh call always starts open-mic
    this.dial = null; // hanging up also ends any outstanding outgoing ring
    this.publish();
  }

  teardownPeer(peer) {
    clearTimeout(peer.reapTimer);
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
    peer.audio?.remove?.();
  }

  dropPeer(name) {
    const peer = this.peers.get(name);
    if (!peer) return;
    this.teardownPeer(peer);
    this.peers.delete(name);
    this.removeMeter(name);
    this.remoteScreens.delete(name);
    this.remoteCameras.delete(name);
    this.cameras.delete(name);
    this.mutedPeers.delete(name);
    // A 1:1 call is over when the other party's leg is gone — whether they
    // left politely (leave envelope) or their tab/network died and the leg
    // was reaped. Without this, a crashed peer leaves you in a dead call.
    if (
      this.active &&
      name === this.directPeer(this.active.channel) &&
      this.peers.size === 0
    ) {
      this.leave().catch(() => {});
    }
    this.publish();
  }

  // === screen sharing + camera ============================================
  // A screen or camera capture is one extra video track on every existing
  // peer connection, added (and removed) via renegotiation. The media itself
  // is P2P DTLS-SRTP like the audio — the relay never carries a frame. The
  // two are symmetric; startVideo/stopVideo do the shared work and the
  // share/camera entry points differ only in how they capture.

  /** The screen stream for `name`, if one is live: my own capture for me,
      the received remote stream for anyone else. */
  screenStreamFor(name) {
    if (name === this.me) return this.share?.stream ?? null;
    return this.remoteScreens.get(name) ?? null;
  }

  /** The camera stream for `name`, if one is live. */
  cameraStreamFor(name) {
    if (name === this.me) return this.camera?.stream ?? null;
    return this.remoteCameras.get(name) ?? null;
  }

  /** Add `track`/`stream` (a screen or camera capture) to every peer,
      renegotiate, and announce it with the stream id so receivers can tell
      the two video kinds apart. `senderKey` is where the RTCRtpSender is
      stashed on each peer ('shareSender' | 'cameraSender'). */
  async startVideo(kind, stream, track, senderKey, action) {
    this.videoKind.set(stream.id, kind);
    const { server, channel } = this.active;
    for (const [name, peer] of this.peers) {
      try {
        peer[senderKey] = peer.pc.addTrack(track, stream);
        await this.renegotiate(server, name, peer);
      } catch {
        /* a dying leg misses it; its reconnect path re-adds the track */
      }
    }
    await this.send(server, { k: 'voice', ch: channel, action, sid: stream.id });
    this.publish();
  }

  /** Remove a screen/camera track from every peer, renegotiate, and retract
      the announcement. */
  async stopVideo(stream, senderKey, action) {
    this.videoKind.delete(stream.id);
    if (this.active) {
      const { server, channel } = this.active;
      for (const [name, peer] of this.peers) {
        if (!peer[senderKey]) continue;
        try {
          peer.pc.removeTrack(peer[senderKey]);
        } catch {
          /* connection already closed */
        }
        peer[senderKey] = null;
        await this.renegotiate(server, name, peer);
      }
      await this.send(server, { k: 'voice', ch: channel, action }).catch(() => {});
    }
    this.publish();
  }

  async startShare() {
    if (!this.active || this.share) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('screen sharing is not available in this browser');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('no video track in the captured screen');
    }
    // The browser's own "stop sharing" bar ends the track out from under us.
    track.addEventListener('ended', () => {
      this.stopShare().catch(() => {});
    });
    this.share = { stream, track };
    await this.startVideo('screen', stream, track, 'shareSender', 'share');
  }

  async stopShare() {
    const share = this.share;
    if (!share) return;
    this.share = null;
    share.stream.getTracks().forEach((t) => t.stop());
    await this.stopVideo(share.stream, 'shareSender', 'unshare');
  }

  /** Modest capture — a mesh pays for every video leg, so cap the camera
      well below screen-share resolution. */
  videoConstraint() {
    return { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };
  }

  async startCamera() {
    if (!this.active || this.camera) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('camera is not available in this browser');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: this.videoConstraint(),
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('no video track from the camera');
    }
    // A camera yanked mid-call (unplugged, revoked) ends the track — tear down.
    track.addEventListener('ended', () => {
      this.stopCamera().catch(() => {});
    });
    this.camera = { stream, track };
    await this.startVideo('camera', stream, track, 'cameraSender', 'camera');
  }

  async stopCamera() {
    const cam = this.camera;
    if (!cam) return;
    this.camera = null;
    cam.stream.getTracks().forEach((t) => t.stop());
    await this.stopVideo(cam.stream, 'cameraSender', 'uncamera');
  }

  /** Re-offer to one peer after a track change. Collisions (both sides
      renegotiating at once) resolve like the initial mesh rule: the smaller
      name's offer wins; see the offer handler in handleSignal. A re-offer
      that can't go out right now (signaling mid-flight) is *queued*, not
      dropped — signalingstatechange retries it once the pc is stable again,
      otherwise a track added during glare would never be negotiated. */
  async renegotiate(server, name, peer) {
    try {
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer();
      // An offer arrived while we were building ours and the peer applied
      // it — ours is stale; retry once the signaling settles.
      if (peer.pc.signalingState !== 'stable') {
        peer.renegotiateNeeded = true;
        return;
      }
      peer.renegotiateNeeded = false;
      offer.sdp = tuneOpus(offer.sdp);
      await peer.pc.setLocalDescription(offer);
      await this.send(server, {
        k: 'rtc',
        ch: this.active.channel,
        to: name,
        type: 'offer',
        sdp: offer.sdp,
      });
    } finally {
      peer.makingOffer = false;
    }
  }

  /** Ask who's in voice (on connect/reconnect) — participants answer 'here'.
      A probe round is authoritative: everyone still present replies, so
      presence learned before the probe is cleared and rebuilt. Without this,
      a member who left while we were disconnected shows "in call" forever
      (their leave envelope is gone for good). My own active room survives. */
  async probe(server) {
    for (const [key, set] of this.presence) {
      if (!key.startsWith(`${server}\n`)) continue;
      for (const name of [...set]) {
        if (!(name === this.me && this.active && this.key(this.active.server, this.active.channel) === key)) {
          set.delete(name);
        }
      }
    }
    for (const [name, key] of [...this.shares]) {
      if (key.startsWith(`${server}\n`)) this.shares.delete(name);
    }
    for (const [name, key] of [...this.cameras]) {
      if (key.startsWith(`${server}\n`)) this.cameras.delete(name);
    }
    this.publish();
    await this.send(server, { k: 'voice', ch: '*', action: 'probe' }).catch(() => {});
  }

  // === direct (1:1) calls ================================================
  // A direct call is just an ad-hoc voice room shared by two members of a
  // circle: no new crypto, it rides the same MLS group. A `ring` envelope
  // invites the callee; both sides derive the same deterministic room id and
  // the existing mesh machinery does the rest.

  /** Deterministic room id for a pair, so both sides derive the same name. */
  directRoom(a, b) {
    return 'dm:' + [a, b].sort().join('+');
  }

  /** The other party in a direct room, or null for a normal voice room. */
  directPeer(channel) {
    if (!channel || !channel.startsWith('dm:')) return null;
    return channel.slice(3).split('+').find((n) => n !== this.me) ?? null;
  }

  /** Ring a member we share this server with, and wait in the room. */
  async callUser(server, name) {
    if (name === this.me || this.active || this.dial) return;
    const room = this.directRoom(this.me, name);
    this.dial = { server, room, to: name };
    // notify: if the callee's app is closed, the relay push-wakes them —
    // otherwise the ring only ever reaches an already-open tab.
    await this.send(server, { k: 'ring', to: name, ch: room, action: 'invite' }, [name]);
    await this.join(server, room); // the caller waits in the room for an answer
  }

  /** Give up on an unanswered outgoing call. */
  async cancelCall() {
    const d = this.dial;
    if (!d) return;
    this.dial = null;
    await this.send(d.server, { k: 'ring', to: d.to, ch: d.room, action: 'cancel' }).catch(() => {});
    await this.leave();
  }

  /** Answer an incoming ring: join the same room; the caller is already there. */
  async acceptRing() {
    const r = this.ring;
    if (!r) return;
    this.ring = null;
    await this.send(r.server, { k: 'ring', to: r.from, ch: r.room, action: 'accept' }).catch(() => {});
    await this.join(r.server, r.room);
  }

  async declineRing() {
    const r = this.ring;
    if (!r) return;
    this.ring = null;
    await this.send(r.server, { k: 'ring', to: r.from, ch: r.room, action: 'decline' }).catch(() => {});
    this.publish();
  }

  /** MLS membership changed: anyone no longer in the group leaves the mesh
      and the presence maps — a kicked member must not keep a live leg. */
  membershipChanged(server, members) {
    const allowed = new Set(members);
    for (const name of [...this.peers.keys()]) {
      if (!allowed.has(name)) this.dropPeer(name);
    }
    for (const [key, set] of this.presence) {
      if (!key.startsWith(`${server}\n`)) continue;
      for (const name of [...set]) {
        if (!allowed.has(name)) set.delete(name);
      }
    }
    for (const [name, key] of [...this.shares]) {
      if (key.startsWith(`${server}\n`) && !allowed.has(name)) this.shares.delete(name);
    }
    for (const [name, key] of [...this.cameras]) {
      if (key.startsWith(`${server}\n`) && !allowed.has(name)) this.cameras.delete(name);
    }
    this.publish();
  }

  inChannel(server, channel) {
    return (
      this.active && this.active.server === server && this.active.channel === channel
    );
  }

  /** Presence reply; carries the share/camera flags (and the stream ids that
      route each incoming video) so late joiners learn who is already
      presenting without waiting for the tracks to negotiate. */
  hereEnvelope(channel) {
    return {
      k: 'voice',
      ch: channel,
      action: 'here',
      ...(this.share ? { sharing: true, shareSid: this.share.stream.id } : {}),
      ...(this.camera ? { camera: true, cameraSid: this.camera.stream.id } : {}),
      ...(this.muted ? { muted: true } : {}),
    };
  }

  /** Record what an incoming video stream is (screen/camera) and, if its
      track already arrived before the announcement, route it now. */
  routeVideo(sid, kind) {
    if (!sid) return;
    this.videoKind.set(sid, kind);
    const pending = this.unroutedVideo.get(sid);
    if (pending) {
      this.unroutedVideo.delete(sid);
      this.attachRemoteVideo(pending.name, pending.stream, pending.track, kind);
    }
  }

  /** File an arrived remote video stream into the screen or camera map. If we
      don't yet know which it is (announcement in flight), park it in
      unroutedVideo keyed by stream id — routeVideo drains it on arrival. */
  attachRemoteVideo(name, stream, track, kind) {
    if (!kind) {
      this.unroutedVideo.set(stream.id, { name, stream, track });
      const drop = () => {
        this.unroutedVideo.delete(stream.id);
      };
      stream.onremovetrack = drop;
      track.onended = drop;
      return;
    }
    const map = kind === 'camera' ? this.remoteCameras : this.remoteScreens;
    map.set(name, stream);
    const gone = () => {
      if (map.get(name) === stream && !stream.getVideoTracks().some((t) => t.readyState === 'live')) {
        map.delete(name);
        this.publish();
      }
    };
    stream.onremovetrack = gone;
    track.onended = gone;
    this.publish();
  }

  async handleEnvelope(server, sender, content) {
    if (sender === this.me) return;

    if (content.k === 'ring') {
      if (content.to !== this.me) return; // rings are addressed to one member
      switch (content.action) {
        case 'invite': {
          if (this.active || this.ring) {
            // Busy: refuse right away so the caller stops ringing.
            await this.send(server, { k: 'ring', to: sender, ch: content.ch, action: 'decline' }).catch(() => {});
            return;
          }
          this.ring = { server, room: content.ch, from: sender };
          break;
        }
        case 'accept': {
          this.dial = null; // callee picked up — we're in the call now
          break;
        }
        case 'decline': {
          if (this.dial && this.dial.to === sender) {
            this.dial = null;
            this.onNotify(`${sender} declined the call`);
            await this.leave();
            return;
          }
          break;
        }
        case 'cancel': {
          if (this.ring && this.ring.from === sender) {
            this.ring = null;
            this.onNotify(`missed call from ${sender}`);
          }
          break;
        }
      }
      this.publish();
      return;
    }

    if (content.k === 'voice') {
      switch (content.action) {
        case 'join':
        case 'here': {
          this.track(server, content.ch, sender, true, content.action === 'join');
          if (content.sharing) {
            this.shares.set(sender, this.key(server, content.ch));
            this.routeVideo(content.shareSid, 'screen');
          }
          if (content.camera) {
            this.cameras.set(sender, this.key(server, content.ch));
            this.routeVideo(content.cameraSid, 'camera');
          }
          if (content.muted) this.mutedPeers.add(sender);
          else if (content.action === 'join') this.mutedPeers.delete(sender);
          if (this.inChannel(server, content.ch)) {
            if (content.action === 'join') {
              // Someone new arrived in my call — chime, then tell them we're
              // here (they can't know otherwise).
              this.chime('join');
              await this.send(server, this.hereEnvelope(content.ch));
            }
            await this.ensurePeer(server, sender);
          }
          break;
        }
        case 'mute': {
          this.mutedPeers.add(sender);
          break;
        }
        case 'unmute': {
          this.mutedPeers.delete(sender);
          break;
        }
        case 'share': {
          this.shares.set(sender, this.key(server, content.ch));
          this.routeVideo(content.sid, 'screen');
          break;
        }
        case 'unshare': {
          this.shares.delete(sender);
          this.remoteScreens.delete(sender);
          break;
        }
        case 'camera': {
          this.cameras.set(sender, this.key(server, content.ch));
          this.routeVideo(content.sid, 'camera');
          break;
        }
        case 'uncamera': {
          this.cameras.delete(sender);
          this.remoteCameras.delete(sender);
          break;
        }
        case 'leave': {
          const wasInMyCall = this.inChannel(server, content.ch);
          this.track(server, content.ch, sender, false);
          this.shares.delete(sender);
          this.cameras.delete(sender);
          if (wasInMyCall) this.chime('leave');
          this.dropPeer(sender);
          // A direct call ends when the *other party* leaves that same room —
          // not when some unrelated member leaves another voice room, which
          // would otherwise spuriously drop a 1:1 call or cancel a live ring.
          if (
            this.active &&
            content.ch === this.active.channel &&
            sender === this.directPeer(this.active.channel) &&
            this.peers.size === 0
          ) {
            await this.leave();
          }
          break;
        }
        case 'probe': {
          if (this.active && this.active.server === server) {
            await this.send(server, this.hereEnvelope(this.active.channel));
          }
          break;
        }
      }
      this.publish();
      return;
    }

    if (content.k === 'rtc' && content.to === this.me) {
      if (!this.inChannel(server, content.ch)) return;
      await this.handleSignal(server, sender, content);
    }
  }

  async ensurePeer(server, name) {
    if (this.peers.has(name)) return;
    const initiator = this.me < name; // deterministic — no glare
    const peer = this.createPeer(server, name);
    this.peers.set(name, peer);
    if (initiator) {
      const offer = await peer.pc.createOffer();
      // The peer may have left (or we may have) while the offer was being
      // built — signaling a closed/replaced leg throws or, worse, sends an
      // offer to someone no longer in the call.
      if (this.peers.get(name) !== peer || !this.active) return;
      offer.sdp = tuneOpus(offer.sdp);
      await peer.pc.setLocalDescription(offer);
      await this.send(server, {
        k: 'rtc',
        ch: this.active.channel,
        to: name,
        type: 'offer',
        sdp: offer.sdp,
      });
    }
    this.publish();
  }

  createPeer(server, name) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      pc,
      audio: null,
      pendingCandidates: [],
      makingOffer: false,
      shareSender: null,
      cameraSender: null,
      renegotiateNeeded: false,
      reapTimer: null,
    };
    for (const t of this.active.stream.getTracks()) pc.addTrack(t, this.active.stream);
    // Mid-share / mid-camera joiner: their very first negotiation already
    // carries whatever video I'm sending, no follow-up renegotiation needed.
    if (this.share) peer.shareSender = pc.addTrack(this.share.track, this.share.stream);
    if (this.camera) peer.cameraSender = pc.addTrack(this.camera.track, this.camera.stream);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !this.active) return;
      this.send(server, {
        k: 'rtc',
        ch: this.active.channel,
        to: name,
        type: 'candidate',
        cand: candidate.toJSON(),
      }).catch(() => {});
    };
    pc.ontrack = ({ track, streams }) => {
      if (track.kind === 'video') {
        // A screen or camera track — both are m=video, so which one it is
        // comes from the stream id we were told about. If the announcement
        // hasn't landed yet, attach routes it as soon as routeVideo learns.
        const stream = streams[0];
        this.attachRemoteVideo(name, stream, track, this.videoKind.get(stream.id));
        return;
      }
      // Renegotiation/ICE restarts can re-fire ontrack for audio: drop the
      // previous element first or it keeps playing, detached and doubled.
      peer.audio?.remove?.();
      const audio = new Audio();
      audio.srcObject = streams[0];
      audio.autoplay = true;
      audio.playsInline = true;
      // Attach the element to the DOM. A detached <audio> plays unreliably:
      // iOS Safari won't play it at all, and on desktop the audio can fail to
      // follow the system output device (e.g. Bluetooth headphones) — it
      // sticks to the default sink. Hidden in the DOM, playback routes to the
      // active output like any other media element.
      audio.style.display = 'none';
      if (typeof document !== 'undefined') document.body.appendChild(audio);
      // Route to the user's chosen output device, if any and if supported.
      if (this.outputDeviceId && audio.setSinkId) audio.setSinkId(this.outputDeviceId).catch(() => {});
      // Autoplay can be blocked pre-gesture; media still flows and the
      // join click is normally gesture enough. Retry once on the next pointer
      // interaction so a blocked start doesn't leave the call silent.
      const tryPlay = () => audio.play().catch(() => {});
      tryPlay();
      if (typeof document !== 'undefined') {
        const resume = () => {
          tryPlay();
          document.removeEventListener('pointerdown', resume);
        };
        document.addEventListener('pointerdown', resume, { once: true });
      }
      peer.audio = audio;
      this.addMeter(name, streams[0]); // measure this peer's speaking level
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        // Peer vanished without a leave (tab kill, network drop).
        this.dropPeer(name);
      } else if (state === 'disconnected') {
        // Some browsers sit in 'disconnected' forever instead of reaching
        // 'failed'. A leg that stays dead must be reaped — a lingering
        // zombie blocks ensurePeer from rebuilding on the next 'here'.
        clearTimeout(peer.reapTimer);
        peer.reapTimer = setTimeout(() => {
          if (this.peers.get(name) === peer && pc.connectionState !== 'connected') {
            this.dropPeer(name);
          }
        }, 8000);
      } else if (state === 'connected') {
        clearTimeout(peer.reapTimer);
        peer.reapTimer = null;
      }
      this.publish();
    };
    pc.onsignalingstatechange = () => {
      // A re-offer postponed by glare goes out once the pc settles.
      if (pc.signalingState === 'stable' && peer.renegotiateNeeded && !peer.makingOffer) {
        peer.renegotiateNeeded = false;
        if (this.peers.get(name) === peer && this.active) {
          this.renegotiate(server, name, peer).catch(() => {});
        }
      }
    };
    return peer;
  }

  async handleSignal(server, sender, content) {
    let peer = this.peers.get(sender);
    if (!peer && content.type === 'offer') {
      peer = this.createPeer(server, sender);
      this.peers.set(sender, peer);
    }
    if (!peer) return;

    switch (content.type) {
      case 'offer': {
        // Renegotiation glare: both sides offered at once (e.g. two screen
        // shares starting together). Deterministic winner, same ordering as
        // the initial mesh rule: the smaller name's offer stands, the larger
        // name rolls back its own and answers instead.
        const collision = peer.makingOffer || peer.pc.signalingState !== 'stable';
        if (collision) {
          const politeLoser = this.me > sender;
          if (!politeLoser) break; // their offer loses; ours is in flight
          // setRemoteDescription(offer) implicitly rolls back our pending
          // local offer; our track change re-offers once this settles.
        }
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: content.sdp });
        // The sender may have left (dropPeer closed this leg) while the
        // description was being applied — answering a closed pc throws.
        if (this.peers.get(sender) !== peer) break;
        for (const c of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(c);
        const answer = await peer.pc.createAnswer();
        if (this.peers.get(sender) !== peer) break;
        answer.sdp = tuneOpus(answer.sdp);
        await peer.pc.setLocalDescription(answer);
        await this.send(server, {
          k: 'rtc',
          ch: content.ch,
          to: sender,
          type: 'answer',
          sdp: answer.sdp,
        });
        break;
      }
      case 'answer': {
        // A stale answer can trail a rolled-back offer; only apply one we
        // are actually waiting for.
        if (peer.pc.signalingState !== 'have-local-offer') break;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: content.sdp });
        for (const c of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(c);
        break;
      }
      case 'candidate': {
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(content.cand).catch(() => {});
        } else {
          peer.pendingCandidates.push(content.cand);
        }
        break;
      }
    }
    this.publish();
  }
}
