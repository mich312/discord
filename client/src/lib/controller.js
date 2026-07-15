// Orchestration: worker (crypto) <-> relay (transport) <-> IndexedDB
// (persistence) <-> React (render). The controller owns the canonical
// in-memory server records; React state is a projection of them.
//
// Message content is a JSON envelope INSIDE the MLS plaintext, so channel
// structure and server names are invisible to the relay:
//   {k:'chat', ch, text}          — a chat message in channel `ch`
//   {k:'meta', name, channels}    — server metadata; rebroadcast after every
//                                   member add because joiners have no
//                                   scrollback to learn it from
//   {k:'chan', ch}                — a channel was created
import { b64, Relay } from './relay.js';
import {
  b64url,
  buildInviteUrl,
  decryptBlob,
  encryptBlob,
  generateFragmentKey,
  generateInviteId,
} from './invite.js';

const KP_TOPUP = 2; // fresh KeyPackages published per connect
const INVITE_TTL_SECONDS = 7 * 24 * 3600;
// The identity bundle also lives in localStorage: IndexedDB and
// localStorage have different eviction behaviors, so the identity key
// (the unrecoverable part) survives an IndexedDB wipe. Same-origin JS can
// read either store, so this adds redundancy, not exposure.
const IDENTITY_LS_KEY = 'e2ee-identity';

export class Controller {
  constructor({ db, crypto, dispatch, relayUrl }) {
    this.db = db;
    this.crypto = crypto; // (cmd, args) => Promise
    this.dispatch = dispatch;
    this.relayUrl = relayUrl;
    this.relay = null;
    this.servers = new Map(); // id -> record
    this.me = null;
  }

  // === boot paths =========================================================

  async boot() {
    const session = await this.db.kvGet('session');
    const state = session ? await this.db.kvGet('mlsState') : null;
    if (session && state) {
      const result = await this.crypto('boot', { state });
      this.me = result.name;
      await this.persistState(result.state);
      for (const record of await this.db.serversAll()) {
        this.servers.set(record.id, record);
      }
      this.dispatch({ type: 'booted', me: this.me, servers: this.snapshotServers() });
      this.connectRelay();
      return;
    }
    // IndexedDB is gone (or never was) — the localStorage identity keeps
    // the account. Groups can't survive that (their ratchets lived in the
    // wiped state), but the user is still themselves.
    const storedIdentity = localStorage.getItem(IDENTITY_LS_KEY);
    if (storedIdentity) {
      await this.restoreIdentity(b64.dec(storedIdentity));
      await this.completeOnboarding();
      this.toast('storage was cleared: your identity survived, but group keys did not — ask to be re-added');
      return;
    }
    this.dispatch({ type: 'phase', phase: 'onboarding' });
  }

  /** Onboarding path A: brand-new identity. Returns identity bytes for the
      recovery flow; the caller completes onboarding separately. */
  async createIdentity(name) {
    const result = await this.crypto('boot', { name });
    this.me = result.name;
    await this.persistState(result.state);
    const identity = new Uint8Array(await this.crypto('exportIdentity'));
    localStorage.setItem(IDENTITY_LS_KEY, b64.enc(identity));
    return identity;
  }

  /** Onboarding path B: restore from an identity bundle (recovery file or
      pasted key). */
  async restoreIdentity(identity) {
    const result = await this.crypto('boot', { identity });
    this.me = result.name;
    await this.persistState(result.state);
    localStorage.setItem(IDENTITY_LS_KEY, b64.enc(identity));
  }

  /** The raw identity key as a copyable string. Anyone holding it IS this
      user — the UI says so next to the copy button. */
  identityKeyString() {
    return localStorage.getItem(IDENTITY_LS_KEY);
  }

  async completeOnboarding() {
    await this.db.kvPut('session', { name: this.me, createdAt: Date.now() });
    // Ask the browser not to evict our keys; best-effort (plan §5.2).
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* not fatal */
    }
    this.dispatch({ type: 'booted', me: this.me, servers: this.snapshotServers() });
    this.connectRelay();
  }

  // === relay ==============================================================

  connectRelay() {
    this.relay = new Relay({
      url: this.relayUrl,
      name: this.me,
      getPubkey: () => this.crypto('pubkey'),
      sign: (bytes) => this.crypto('sign', { bytes }),
      onStatus: (status) => this.dispatch({ type: 'connection', status }),
      onEvent: (msg) => this.onRelayEvent(msg).catch((e) => this.toast(e.message)),
    });
    this.relay.connect();
  }

  async onRelayEvent(msg) {
    switch (msg.t) {
      case 'ready': {
        // Re-subscribe everything from where we left off, then top up
        // the KeyPackage store so others can add us while we're away.
        for (const record of this.servers.values()) {
          await this.relay
            .request({ t: 'subscribe', group: record.id, after: record.lastSeq })
            .catch((e) => this.toast(`subscribe ${record.id}: ${e.message}`));
        }
        const payloads = [];
        for (let i = 0; i < KP_TOPUP; i++) {
          const { keyPackage, state } = await this.crypto('keyPackage');
          await this.persistState(state);
          payloads.push(b64.enc(keyPackage));
        }
        await this.relay.request({ t: 'publish_kp', payloads });
        if (this.pendingInvite) await this.redeemPendingInvite();
        break;
      }
      case 'welcome':
        await this.onWelcome(msg);
        break;
      case 'msg':
        await this.onGroupMessage(msg);
        break;
    }
  }

  async onWelcome(msg) {
    const { group, epoch, members, state } = await this.crypto('joinFromWelcome', {
      welcome: b64.dec(msg.payload),
    });
    await this.persistState(state);
    const record = {
      id: group,
      name: group, // placeholder until the meta rebroadcast lands
      channels: ['general'],
      members,
      epoch,
      lastSeq: msg.after,
      joinedAt: Date.now(),
    };
    this.servers.set(group, record);
    await this.db.serverPut(record);
    await this.addSystemMessage(group, `you joined — history before this point does not exist for you`);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.relay.request({ t: 'subscribe', group, after: msg.after });
  }

  async onGroupMessage(msg) {
    const record = this.servers.get(msg.group);
    if (!record) return;
    // Every stored blob advances the resume point — even ones we can't
    // process (our own commits echoed by catch-up, stale epochs). A blob
    // that wedges the cursor would wedge the client forever.
    record.lastSeq = Math.max(record.lastSeq, msg.seq);

    try {
      const { event, state } = await this.crypto('receive', { bytes: b64.dec(msg.payload) });
      await this.persistState(state);
      if (event.kind === 'message') {
        await this.onContent(record, event.sender, event.text);
      } else if (event.kind === 'membershipChange') {
        const before = new Set(record.members);
        record.members = event.members;
        record.epoch = event.epoch;
        const added = event.members.filter((m) => !before.has(m));
        if (added.includes(event.sender)) {
          // External commit: the commit is signed by the joiner themselves.
          // A stranger appearing in the member list is an event, and they
          // are unverified until someone checks their safety number.
          record.linkJoined = [...new Set([...(record.linkJoined ?? []), event.sender])];
          await this.addSystemMessage(
            record.id,
            `${event.sender} joined via invite link — unverified (epoch ${event.epoch})`
          );
          // Link joiners have no scrollback; whoever owns invites for this
          // group rebroadcasts the metadata they missed.
          if (record.invites?.length) {
            await this.sendContent(record.id, {
              k: 'meta',
              name: record.name,
              channels: record.channels,
            });
          }
        } else {
          await this.addSystemMessage(
            record.id,
            `members now: ${event.members.join(', ')} (epoch ${event.epoch})`
          );
        }
        // Every epoch change kills parked GroupInfo blobs; refresh ours.
        await this.refreshInvites(record);
      }
    } catch (e) {
      // Expected for own commits replayed by catch-up; log and move on.
      console.warn(`undecryptable blob seq ${msg.seq} in ${msg.group}: ${e.message}`);
    }
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  async onContent(record, sender, raw) {
    let content;
    try {
      content = JSON.parse(raw);
    } catch {
      content = { k: 'chat', ch: 'general', text: raw };
    }
    switch (content.k) {
      case 'chat': {
        if (!record.channels.includes(content.ch)) record.channels.push(content.ch);
        await this.storeMessage({
          server: record.id,
          channel: content.ch,
          sender,
          text: content.text,
          ts: Date.now(),
        });
        break;
      }
      case 'meta': {
        record.name = content.name ?? record.name;
        for (const ch of content.channels ?? []) {
          if (!record.channels.includes(ch)) record.channels.push(ch);
        }
        break;
      }
      case 'chan': {
        if (!record.channels.includes(content.ch)) {
          record.channels.push(content.ch);
          await this.addSystemMessage(record.id, `#${content.ch} created by ${sender}`, content.ch);
        }
        break;
      }
    }
  }

  // === user actions =======================================================

  async createServer(name) {
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server'}-${Math.random().toString(36).slice(2, 6)}`;
    const { state } = await this.crypto('createGroup', { group: id });
    await this.persistState(state);
    await this.relay.request({ t: 'create_group', group: id });
    const record = {
      id,
      name,
      channels: ['general'],
      members: [this.me],
      epoch: 0,
      lastSeq: 0,
      joinedAt: Date.now(),
    };
    this.servers.set(id, record);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    return id;
  }

  async createChannel(serverId, channel) {
    const record = this.servers.get(serverId);
    const ch = channel.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!ch || record.channels.includes(ch)) return;
    record.channels.push(ch);
    await this.sendContent(serverId, { k: 'chan', ch });
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  async sendChat(serverId, channel, text) {
    await this.sendContent(serverId, { k: 'chat', ch: channel, text });
    await this.storeMessage({ server: serverId, channel, sender: this.me, text, ts: Date.now() });
  }

  async addMember(serverId, user) {
    const record = this.servers.get(serverId);
    const reply = await this.relay.request({ t: 'fetch_kp', user });
    if (!reply.payload) {
      throw new Error(`${user} has no published key packages (have they signed up?)`);
    }
    const { commit, welcome, epoch, members, state } = await this.crypto('addMember', {
      group: serverId,
      keyPackage: b64.dec(reply.payload),
    });
    await this.persistState(state);
    const sent = await this.relay.request({
      t: 'send',
      group: serverId,
      epoch,
      payload: b64.enc(commit),
    });
    record.lastSeq = Math.max(record.lastSeq, sent.seq);
    await this.relay.request({ t: 'allow', group: serverId, user });
    await this.relay.request({
      t: 'welcome',
      to: user,
      group: serverId,
      after: sent.seq,
      payload: b64.enc(welcome),
    });
    record.members = members;
    record.epoch = epoch;
    await this.addSystemMessage(serverId, `${user} added (epoch ${epoch}) — unverified until you check their safety number`);
    // Joiners have no scrollback: rebroadcast name + channels so their
    // placeholder record fills in.
    await this.sendContent(serverId, { k: 'meta', name: record.name, channels: record.channels });
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  // === invite links =======================================================

  /** Queue an invite from the URL (?j=<id>#k=<key>); redeemed once the
      relay connection is ready (after onboarding if needed). */
  setPendingInvite(invite) {
    this.pendingInvite = invite;
  }

  async createInvite(serverId) {
    const record = this.servers.get(serverId);
    const inviteId = generateInviteId();
    const fragmentKey = generateFragmentKey();
    const groupInfo = await this.crypto('exportGroupInfo', { group: serverId });
    const blob = await encryptBlob(fragmentKey, groupInfo);
    await this.relay.request({
      t: 'create_invite',
      invite: inviteId,
      group: serverId,
      payload: b64.enc(blob),
      expires_at: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
      max_uses: null,
    });
    // Keep the fragment key so we can re-encrypt fresh GroupInfo after
    // every epoch change (a parked blob dies with its epoch).
    record.invites = [...(record.invites ?? []), { id: inviteId, key: b64.enc(fragmentKey) }];
    await this.db.serverPut(record);
    return buildInviteUrl(location, inviteId, fragmentKey);
  }

  /** Re-encrypt the current epoch's GroupInfo under each invite's existing
      fragment key and swap the relay's blob. Called after epoch changes. */
  async refreshInvites(record) {
    for (const invite of record.invites ?? []) {
      try {
        const groupInfo = await this.crypto('exportGroupInfo', { group: record.id });
        const blob = await encryptBlob(b64.dec(invite.key), groupInfo);
        await this.relay.request({ t: 'update_invite', invite: invite.id, payload: b64.enc(blob) });
      } catch (e) {
        console.warn(`invite ${invite.id} refresh failed: ${e.message}`);
      }
    }
  }

  async redeemPendingInvite() {
    const { id, key } = this.pendingInvite;
    this.pendingInvite = null;
    const reply = await this.relay.request({ t: 'redeem_invite', invite: id }).catch((e) => {
      throw new Error(`invite not usable: ${e.message}`);
    });
    if (this.servers.has(reply.group)) return; // already a member
    const groupInfo = await decryptBlob(b64url.dec(key), b64.dec(reply.payload));
    const { group, commit, epoch, members, state } = await this.crypto('joinByExternalCommit', {
      groupInfo,
    });
    await this.persistState(state);
    // Publishing our external commit is what makes the join real for
    // everyone else; its seq is where our log begins.
    const sent = await this.relay.request({ t: 'send', group, epoch, payload: b64.enc(commit) });
    const record = {
      id: group,
      name: group, // placeholder until a member rebroadcasts meta
      channels: ['general'],
      members,
      epoch,
      lastSeq: sent.seq,
      joinedAt: Date.now(),
    };
    this.servers.set(group, record);
    await this.db.serverPut(record);
    await this.addSystemMessage(
      group,
      `you joined via invite link — history before this point does not exist for you`
    );
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.relay.request({ t: 'subscribe', group, after: sent.seq });
  }

  // === helpers ============================================================

  async sendContent(serverId, content) {
    const record = this.servers.get(serverId);
    const { blob, epoch, state } = await this.crypto('send', {
      group: serverId,
      text: JSON.stringify(content),
    });
    await this.persistState(state);
    const sent = await this.relay.request({
      t: 'send',
      group: serverId,
      epoch,
      payload: b64.enc(blob),
    });
    record.lastSeq = Math.max(record.lastSeq, sent.seq);
    await this.db.serverPut(record);
    return sent.seq;
  }

  async storeMessage(message) {
    await this.db.msgAdd(message);
    this.dispatch({ type: 'newMessage', message });
  }

  async addSystemMessage(serverId, text, channel = 'general') {
    await this.storeMessage({ server: serverId, channel, sender: '', text, ts: Date.now(), system: true });
  }

  async persistState(state) {
    if (state) await this.db.kvPut('mlsState', state);
  }

  snapshotServers() {
    // Plain-object projection for React (sorted stable by join time).
    return [...this.servers.values()]
      .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
      .map((r) => ({ ...r, channels: [...r.channels], members: [...r.members] }));
  }

  async loadMessages(serverId, channel) {
    return this.db.msgsFor(serverId, channel);
  }

  toast(text) {
    this.dispatch({ type: 'toast', text });
  }
}
