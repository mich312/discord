// Mesh voice channels (audio + optional screen share). Every signal
// (presence + SDP + ICE) travels as an MLS-encrypted ephemeral: the relay
// fans it out but can't read it, and — because MLS authenticates every
// message — the DTLS fingerprints inside the SDP arrive over an
// authenticated channel. That is the fingerprint verification: a relay
// that swapped SDP would fail MLS authentication.
//
// Envelope shapes (inside MLS plaintext):
//   {k:'voice', ch, action:'join'|'here'|'leave'|'probe'|'share'|'unshare',
//    sharing?}                                  — 'here' carries sharing:true
//                                                 when the sender has a live
//                                                 screen share going
//   {k:'rtc', ch, to, type:'offer'|'answer'|'candidate', sdp?, cand?}
//
// Mesh rule: for each pair, the lexicographically smaller name makes the
// initial offer — no glare. Later renegotiation (screen share start/stop)
// can come from either side; collisions resolve with the same ordering:
// the smaller name's offer wins, the larger name rolls back and answers.
// Audio-only keeps mesh viable to ~6–8 participants; screen video is one
// extra sender track per sharer.

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
    // Screen sharing: my outgoing capture, who else is sharing (name ->
    // presence key, learned from share/here envelopes), and the remote
    // display streams as their video tracks arrive.
    this.share = null; // {stream, track}
    this.shares = new Map(); // name -> key(server, channel)
    this.remoteScreens = new Map(); // name -> MediaStream
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
    return this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraint() });
      const track = stream.getAudioTracks()[0];
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(track).catch(() => {});
      }
      this.active.stream.getTracks().forEach((t) => t.stop());
      this.active.stream = stream;
      this.removeMeter(this.me);
      this.addMeter(this.me, stream);
      this.listenOnly = false;
      this.publish();
    } catch {
      /* keep the current mic if the chosen device won't open */
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
    // Leaving implies unshare — the capture must not outlive the call.
    if (this.share) {
      this.share.stream.getTracks().forEach((t) => t.stop());
      this.share = null;
    }
    this.remoteScreens.clear();
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
    this.remoteScreens.delete(name);
    this.publish();
  }

  // === screen sharing =====================================================
  // The display capture is one extra video track on every existing peer
  // connection, added (and removed) via renegotiation. The media itself is
  // P2P DTLS-SRTP like the audio — the relay never carries a frame.

  /** The screen stream for `name`, if one is live: my own capture for me,
      the received remote stream for anyone else. */
  screenStreamFor(name) {
    if (name === this.me) return this.share?.stream ?? null;
    return this.remoteScreens.get(name) ?? null;
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
    const { server, channel } = this.active;
    for (const [name, peer] of this.peers) {
      try {
        peer.shareSender = peer.pc.addTrack(track, stream);
        await this.renegotiate(server, name, peer);
      } catch {
        /* a dying leg misses the share; its reconnect path re-adds it */
      }
    }
    await this.send(server, { k: 'voice', ch: channel, action: 'share' });
    this.publish();
  }

  async stopShare() {
    const share = this.share;
    if (!share) return;
    this.share = null;
    share.stream.getTracks().forEach((t) => t.stop());
    if (this.active) {
      const { server, channel } = this.active;
      for (const [name, peer] of this.peers) {
        if (!peer.shareSender) continue;
        try {
          peer.pc.removeTrack(peer.shareSender);
        } catch {
          /* connection already closed */
        }
        peer.shareSender = null;
        await this.renegotiate(server, name, peer);
      }
      await this.send(server, { k: 'voice', ch: channel, action: 'unshare' }).catch(() => {});
    }
    this.publish();
  }

  /** Re-offer to one peer after a track change. Collisions (both sides
      renegotiating at once) resolve like the initial mesh rule: the smaller
      name's offer wins; see the offer handler in handleSignal. */
  async renegotiate(server, name, peer) {
    try {
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer();
      // An offer arrived while we were building ours and the peer applied
      // it — ours is stale; the answer path re-syncs the tracks.
      if (peer.pc.signalingState !== 'stable') return;
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
    for (const [name, key] of [...this.shares]) {
      if (key.startsWith(`${server}\n`) && !allowed.has(name)) this.shares.delete(name);
    }
    this.publish();
  }

  inChannel(server, channel) {
    return (
      this.active && this.active.server === server && this.active.channel === channel
    );
  }

  /** Presence reply; carries the share flag so late joiners learn who is
      already presenting without waiting for the video track to negotiate. */
  hereEnvelope(channel) {
    return { k: 'voice', ch: channel, action: 'here', ...(this.share ? { sharing: true } : {}) };
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
          if (content.sharing) this.shares.set(sender, this.key(server, content.ch));
          if (this.inChannel(server, content.ch)) {
            if (content.action === 'join') {
              // Tell the newcomer we're here (they can't know otherwise).
              await this.send(server, this.hereEnvelope(content.ch));
            }
            await this.ensurePeer(server, sender);
          }
          break;
        }
        case 'share': {
          this.shares.set(sender, this.key(server, content.ch));
          break;
        }
        case 'unshare': {
          this.shares.delete(sender);
          this.remoteScreens.delete(sender);
          break;
        }
        case 'leave': {
          this.track(server, content.ch, sender, false);
          this.shares.delete(sender);
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
    const peer = { pc, audio: null, pendingCandidates: [], makingOffer: false, shareSender: null };
    for (const t of this.active.stream.getTracks()) pc.addTrack(t, this.active.stream);
    // Mid-share joiner: their very first negotiation already carries the
    // screen track, no follow-up renegotiation needed.
    if (this.share) peer.shareSender = pc.addTrack(this.share.track, this.share.stream);
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
        // The peer's screen. It rides its own MediaStream, distinct from the
        // audio one, so the stage can hand it straight to a <video>.
        const stream = streams[0];
        this.remoteScreens.set(name, stream);
        const gone = () => {
          if (this.remoteScreens.get(name) === stream && !stream.getVideoTracks().some((t) => t.readyState === 'live')) {
            this.remoteScreens.delete(name);
            this.publish();
          }
        };
        stream.onremovetrack = gone;
        track.onended = gone;
        this.publish();
        return;
      }
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
