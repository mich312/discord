// Audio-only mesh voice channels. Every signal (presence + SDP + ICE)
// travels as an MLS-encrypted ephemeral: the relay fans it out but can't
// read it, and — because MLS authenticates every message — the DTLS
// fingerprints inside the SDP arrive over an authenticated channel. That
// is the fingerprint verification: a relay that swapped SDP would fail
// MLS authentication.
//
// Envelope shapes (inside MLS plaintext):
//   {k:'voice', ch, action:'join'|'here'|'leave'|'probe'}
//   {k:'rtc', ch, to, type:'offer'|'answer'|'candidate', sdp?, cand?}
//
// Mesh rule: for each pair, the lexicographically smaller name makes the
// offer — no glare. Audio-only keeps mesh viable to ~6–8 participants.

import { frameRms, levelFromRms, nextSpeaking } from './meter.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

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
    this.iceServers = opts.iceServers ?? DEFAULT_ICE;
    this.active = null; // {server, channel, stream}
    this.ring = null; // incoming direct call awaiting our answer: {server, room, from}
    this.dial = null; // outgoing direct call we're ringing: {server, room, to}
    this.peers = new Map(); // name -> {pc, audio}
    // (server, channel) -> Set of names, maintained passively for everyone
    this.presence = new Map();
    // Active-speaker metering (local + each remote), all client-side.
    this.levels = {}; // name -> 0..1 instantaneous loudness (read by the meter UI)
    this.speaking = new Set(); // names currently over the speaking threshold
    this.analysers = new Map(); // name -> { src, analyser, data }
    this.meterCtx = null;
    this.meterSink = null;
    this.meterRAF = null;
  }

  key(server, channel) {
    return `${server}\n${channel}`;
  }

  participants(server, channel) {
    return [...(this.presence.get(this.key(server, channel)) ?? [])].sort();
  }

  publish() {
    const state = {
      active: this.active ? { server: this.active.server, channel: this.active.channel } : null,
      listenOnly: this.active ? !!this.listenOnly : false,
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

  track(server, channel, name, present) {
    const key = this.key(server, channel);
    if (!this.presence.has(key)) this.presence.set(key, new Set());
    const set = this.presence.get(key);
    present ? set.add(name) : set.delete(name);
  }

  /** Mic if available; otherwise a silent WebAudio track — joining
      listen-only beats being locked out, and the peer connection stays
      symmetric (audio m-line in both directions) either way. */
  async captureAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.listenOnly = false;
      return stream;
    } catch {
      const ctx = new AudioContext();
      const destination = ctx.createMediaStreamDestination();
      this.audioCtx = ctx; // no source connected -> silence
      this.listenOnly = true;
      return destination.stream;
    }
  }

  async join(server, channel) {
    if (this.active) await this.leave();
    const stream = await this.captureAudio();
    this.active = { server, channel, stream };
    this.addMeter(this.me, stream); // show my own level even before anyone joins
    this.track(server, channel, this.me, true);
    await this.send(server, { k: 'voice', ch: channel, action: 'join' });
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
    this.audioCtx?.close?.().catch?.(() => {});
    this.audioCtx = null;
    this.track(server, channel, this.me, false);
    this.active = null;
    this.dial = null; // hanging up also ends any outstanding outgoing ring
    this.publish();
  }

  teardownPeer(peer) {
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
    this.publish();
  }

  /** Ask who's in voice (on connect/reconnect) — participants answer 'here'. */
  async probe(server) {
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
    await this.send(server, { k: 'ring', to: name, ch: room, action: 'invite' });
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
    this.publish();
  }

  inChannel(server, channel) {
    return (
      this.active && this.active.server === server && this.active.channel === channel
    );
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
          this.track(server, content.ch, sender, true);
          if (this.inChannel(server, content.ch)) {
            if (content.action === 'join') {
              // Tell the newcomer we're here (they can't know otherwise).
              await this.send(server, { k: 'voice', ch: content.ch, action: 'here' });
            }
            await this.ensurePeer(server, sender);
          }
          break;
        }
        case 'leave': {
          this.track(server, content.ch, sender, false);
          this.dropPeer(sender);
          // A direct call ends the instant the other side hangs up.
          if (this.active && this.directPeer(this.active.channel) && this.peers.size === 0) {
            await this.leave();
          }
          break;
        }
        case 'probe': {
          if (this.active && this.active.server === server) {
            await this.send(server, { k: 'voice', ch: this.active.channel, action: 'here' });
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
    const peer = { pc, audio: null, pendingCandidates: [] };
    for (const t of this.active.stream.getTracks()) pc.addTrack(t, this.active.stream);
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
    pc.ontrack = ({ streams }) => {
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
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // Peer vanished without a leave (tab kill, network drop).
        if (pc.connectionState === 'failed') this.dropPeer(name);
      }
      this.publish();
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
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: content.sdp });
        for (const c of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(c);
        const answer = await peer.pc.createAnswer();
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
