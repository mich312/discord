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
    this.iceServers = opts.iceServers ?? DEFAULT_ICE;
    this.active = null; // {server, channel, stream}
    this.peers = new Map(); // name -> {pc, audio}
    // (server, channel) -> Set of names, maintained passively for everyone
    this.presence = new Map();
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
    };
    if (typeof window !== 'undefined') window.__voice = state;
    this.onState(state);
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
    stream.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close?.().catch?.(() => {});
    this.audioCtx = null;
    this.track(server, channel, this.me, false);
    this.active = null;
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
    this.publish();
  }

  /** Ask who's in voice (on connect/reconnect) — participants answer 'here'. */
  async probe(server) {
    await this.send(server, { k: 'voice', ch: '*', action: 'probe' }).catch(() => {});
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
      // Autoplay can be blocked pre-gesture; media still flows and the
      // join click is normally gesture enough.
      audio.play().catch(() => {});
      peer.audio = audio;
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
