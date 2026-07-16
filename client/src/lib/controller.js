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
//   {k:'file', ch, file}          — an attachment: {name,size,mime,blob,key};
//                                   blob id points at relay disk, the AES key
//                                   travels only inside this encrypted envelope
import { b64, Relay } from './relay.js';
import { VoiceManager } from './voice.js';
import {
  derivePrfSecret,
  parseCreationOptions,
  parseRequestOptions,
  prfSecret,
  serializeAssertion,
  serializeRegistration,
} from './webauthn.js';
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
      this.setupServiceWorker();
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

  async completeOnboarding(securedLocal = true) {
    await this.db.kvPut('session', { name: this.me, createdAt: Date.now() });
    await this.db.kvPut('securedLocal', securedLocal);
    // Ask the browser not to evict our keys; best-effort (plan §5.2).
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* not fatal */
    }
    this.dispatch({ type: 'booted', me: this.me, servers: this.snapshotServers() });
    this.connectRelay();
    this.setupServiceWorker();
  }

  // === relay ==============================================================

  connectRelay() {
    this.voice = new VoiceManager({
      me: this.me,
      send: (server, content) => this.sendEphemeral(server, content),
      onState: (state) => this.dispatch({ type: 'voice', state }),
      onNotify: (text) => this.dispatch({ type: 'toast', text }),
    });
    this.relay = new Relay({
      url: this.relayUrl,
      name: this.me,
      getPubkey: () => this.crypto('pubkey'),
      sign: (bytes) => this.crypto('sign', { bytes }),
      // Invite-only relays only register a fresh handle if the hello
      // carries a usable invite id (link joiners have one pending).
      getInvite: () => this.pendingInvite?.id ?? null,
      onAuthError: (message) => {
        this.onAuthRejected(message).catch((e) => console.warn(`auth rejection: ${e.message}`));
      },
      onStatus: (status) => this.dispatch({ type: 'connection', status }),
      onEvent: (msg) => this.onRelayEvent(msg).catch((e) => this.toast(e.message)),
    });
    this.relay.connect();
  }

  /** The relay refused the handshake. For an invite-only refusal the
      handle was never registered, so the locally generated identity is
      worthless — clear it and park the user back at the gate with the
      reason. A key-mismatch refusal keeps the local identity (it may be
      the right one for a different relay/handle). */
  async onAuthRejected(message) {
    if (/invite-only/.test(message)) {
      localStorage.removeItem(IDENTITY_LS_KEY);
      await this.db.kvPut('session', null);
      this.me = null;
    }
    this.authError = message;
    this.dispatch({ type: 'phase', phase: 'onboarding' });
  }

  /** Does this relay admit fresh identities without an invite link?
      UI hint only — fail open here; the WS handshake enforces it. */
  async registerPolicy() {
    try {
      const res = await fetch(`${this.httpBase()}/register/policy`);
      if (!res.ok) return { invite_required: false };
      return await res.json();
    } catch {
      return { invite_required: false };
    }
  }

  async onRelayEvent(msg) {
    switch (msg.t) {
      case 'ready': {
        // Whether the relay treats us as a global admin (RELAY_ADMINS).
        this.globalAdmin = !!msg.global_admin;
        this.dispatch({ type: 'admin', globalAdmin: this.globalAdmin });
        // Re-subscribe everything from where we left off, then top up
        // the KeyPackage store so others can add us while we're away.
        for (const record of this.servers.values()) {
          await this.relay
            .request({ t: 'subscribe', group: record.id, after: record.lastSeq })
            .catch((e) => this.toast(`subscribe ${record.id}: ${e.message}`));
          this.refreshRoles(record.id);
        }
        const payloads = [];
        for (let i = 0; i < KP_TOPUP; i++) {
          const { keyPackage, state } = await this.crypto('keyPackage');
          await this.persistState(state);
          payloads.push(b64.enc(keyPackage));
        }
        await this.relay.request({ t: 'publish_kp', payloads });
        // Pick up the operator's ICE servers (STUN/TURN) so voice can traverse
        // NATs. Falls back to VoiceManager's built-in STUN if unavailable.
        try {
          const ice = await this.relay.request({ t: 'ice_info' });
          const servers = JSON.parse(ice.servers);
          if (Array.isArray(servers) && servers.length) this.voice.iceServers = servers;
        } catch (e) {
          console.warn(`ice_info: ${e.message}`);
        }
        for (const record of this.servers.values()) {
          this.voice.probe(record.id);
        }
        this.checkVault();
        // Refresh the push subscription silently if permission was already
        // granted (endpoints rotate; VAPID keys may too).
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          this.enableNotifications().catch((e) => console.warn(`push resubscribe: ${e.message}`));
        }
        if (this.pendingInvite) await this.redeemPendingInvite();
        break;
      }
      case 'welcome':
        await this.onWelcome(msg);
        break;
      case 'msg':
        await this.onGroupMessage(msg);
        break;
      case 'eph':
        await this.onEphemeral(msg);
        break;
    }
  }

  /** Ephemeral fan-out: MLS-encrypted voice presence / WebRTC signaling.
      Never logged server-side, never stored client-side. */
  async onEphemeral(msg) {
    if (!this.servers.has(msg.group)) return;
    try {
      const { event, state } = await this.crypto('receive', { bytes: b64.dec(msg.payload) });
      await this.persistState(state);
      if (event.kind !== 'message') return;
      const content = JSON.parse(event.text);
      if (content.k === 'voice' || content.k === 'rtc' || content.k === 'ring') {
        await this.voice.handleEnvelope(msg.group, event.sender, content);
      }
    } catch (e) {
      console.warn(`ephemeral from ${msg.sender} undecryptable: ${e.message}`);
    }
  }

  /** Encrypt with MLS, deliver via the relay's no-log fan-out. */
  async sendEphemeral(serverId, content) {
    const { blob, state } = await this.crypto('send', {
      group: serverId,
      text: JSON.stringify(content),
    });
    await this.persistState(state);
    await this.relay.request({ t: 'ephemeral', group: serverId, payload: b64.enc(blob) });
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
      voiceChannels: ['lounge'],
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
    this.refreshRoles(group);
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
              voiceChannels: record.voiceChannels ?? ['lounge'],
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
        this.refreshRoles(record.id);
        // And nobody outside the group keeps a live voice leg.
        this.voice.membershipChanged(record.id, event.members);
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
        if (content.voiceChannels) {
          const rooms = record.voiceChannels ?? ['lounge'];
          for (const ch of content.voiceChannels) if (!rooms.includes(ch)) rooms.push(ch);
          record.voiceChannels = rooms;
        }
        break;
      }
      case 'file': {
        if (!record.channels.includes(content.ch)) record.channels.push(content.ch);
        await this.storeMessage({
          server: record.id,
          channel: content.ch,
          sender,
          file: content.file,
          ts: Date.now(),
        });
        break;
      }
      case 'chan': {
        if (!record.channels.includes(content.ch)) {
          record.channels.push(content.ch);
          await this.addSystemMessage(record.id, `#${content.ch} created by ${sender}`, content.ch);
        }
        break;
      }
      case 'vchan': {
        const rooms = record.voiceChannels ?? ['lounge'];
        if (!rooms.includes(content.ch)) {
          record.voiceChannels = [...rooms, content.ch];
          await this.addSystemMessage(record.id, `voice room "${content.ch}" created by ${sender}`);
        }
        break;
      }
      case 'role': {
        // Roles live in the relay's ACL; this envelope just tells everyone
        // to re-read them and leaves a trace in the channel.
        await this.addSystemMessage(
          record.id,
          `${content.user} is now ${content.role === 'admin' ? 'an admin' : 'a regular member'} (changed by ${sender})`
        );
        this.refreshRoles(record.id);
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
      voiceChannels: ['lounge'],
      members: [this.me],
      roles: { [this.me]: 'admin' },
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

  /** Create a named voice room. Like text rooms, the name travels inside the
      encryption; the relay only ever sees an opaque ephemeral/log blob. */
  async createVoiceChannel(serverId, channel) {
    const record = this.servers.get(serverId);
    const ch = channel.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const rooms = record.voiceChannels ?? ['lounge'];
    if (!ch || rooms.includes(ch)) return;
    record.voiceChannels = [...rooms, ch];
    await this.sendContent(serverId, { k: 'vchan', ch });
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
    await this.sendContent(serverId, {
      k: 'meta',
      name: record.name,
      channels: record.channels,
      voiceChannels: record.voiceChannels ?? ['lounge'],
    });
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.refreshRoles(serverId);
  }

  // === roles ==============================================================

  /** Pull the relay's roster roles (admin/member) into the local record.
      Best-effort: the ACL is advisory, so failures only affect badges. */
  async refreshRoles(serverId) {
    const record = this.servers.get(serverId);
    if (!record) return;
    try {
      const reply = await this.relay.request({ t: 'members', group: serverId });
      record.roles = Object.fromEntries(reply.members.map((m) => [m.user, m.role]));
      await this.db.serverPut(record);
      this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    } catch (e) {
      console.warn(`roles for ${serverId}: ${e.message}`);
    }
  }

  /** Promote/demote a member (admins only — the relay enforces it), then
      tell the group so everyone refreshes their badges. */
  async setRole(serverId, user, role) {
    await this.relay.request({ t: 'set_role', group: serverId, user, role });
    await this.sendContent(serverId, { k: 'role', user, role });
    await this.addSystemMessage(
      serverId,
      `${user} is now ${role === 'admin' ? 'an admin' : 'a regular member'} (changed by you)`
    );
    await this.refreshRoles(serverId);
  }

  /** Global admin overview: every user and group the relay knows about.
      Metadata only — the relay cannot read names or messages. */
  adminList() {
    return this.relay.request({ t: 'admin_list' });
  }

  // === account vaults =====================================================

  async checkVault() {
    try {
      const reply = await this.relay.request({ t: 'vault_status' });
      const securedLocal = (await this.db.kvGet('securedLocal')) ?? true;
      this.dispatch({ type: 'vault', kind: reply.kind ?? null, securedLocal });
    } catch (e) {
      console.warn(`vault status: ${e.message}`);
    }
  }

  identityBytes() {
    const stored = this.identityKeyString();
    if (!stored) throw new Error('no identity on this device');
    return b64.dec(stored);
  }

  async markSecuredLocal() {
    await this.db.kvPut('securedLocal', true);
    await this.checkVault();
  }

  /** Password vault: Argon2id splits into an auth half (relay stores only
      its hash) and a wrap half (encrypts the identity, never leaves). */
  async secureWithPassword(password) {
    if ((password ?? '').length < 8) throw new Error('password: 8 characters minimum');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keys = new Uint8Array(await this.crypto('deriveLoginKeys', { password, salt }));
    const authKey = keys.slice(0, 32);
    const wrapKey = keys.slice(32);
    const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', authKey));
    const wrapped = await encryptBlob(wrapKey, this.identityBytes());
    await this.relay.request({
      t: 'vault_set',
      kind: 'password',
      salt: b64.enc(salt),
      verifier: b64.enc(verifier),
      wrapped: b64.enc(wrapped),
      credential: null,
    });
    await this.markSecuredLocal();
  }

  /** Passkey vault: register a WebAuthn credential, derive a wrap key via
      the PRF extension, park the wrapped identity. Nothing brute-forceable
      is stored anywhere. */
  async secureWithPasskey() {
    if (!navigator.credentials?.create) throw new Error('WebAuthn unavailable in this browser');
    const start = await this.relay.request({ t: 'passkey_register_start' });
    const created = await navigator.credentials.create({
      publicKey: parseCreationOptions(JSON.parse(start.payload)),
    });
    const finish = await this.relay.request({
      t: 'passkey_register_finish',
      credential: JSON.stringify(serializeRegistration(created)),
    });
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const secret = await derivePrfSecret(created.rawId, prfSalt);
    if (!secret) {
      throw new Error('this authenticator does not support the PRF extension — use a password instead');
    }
    const wrapped = await encryptBlob(secret, this.identityBytes());
    await this.relay.request({
      t: 'vault_set',
      kind: 'passkey',
      salt: b64.enc(prfSalt),
      verifier: b64.enc(new Uint8Array(0)),
      wrapped: b64.enc(wrapped),
      credential: finish.payload,
    });
    await this.markSecuredLocal();
  }

  /** Pre-boot sign-in on a fresh device: fetch the vault, unwrap locally,
      adopt the identity. Groups don't transfer — only who you are. */
  async signInWithPassword(user, password) {
    const params = await this.accountFetch(`/account/${encodeURIComponent(user)}/params`);
    if (params.kind !== 'password') throw new Error(`this account uses ${params.kind} sign-in`);
    const salt = b64.dec(params.salt);
    const keys = new Uint8Array(await this.crypto('deriveLoginKeys', { password, salt }));
    const reply = await this.accountFetch(`/account/${encodeURIComponent(user)}/login`, {
      auth_key: b64.enc(keys.slice(0, 32)),
    });
    const identity = await decryptBlob(keys.slice(32), b64.dec(reply.wrapped)).catch(() => {
      throw new Error('could not decrypt vault — corrupt data');
    });
    await this.restoreIdentity(identity);
    await this.completeOnboarding(true);
  }

  async signInWithPasskey(user) {
    const params = await this.accountFetch(`/account/${encodeURIComponent(user)}/params`);
    if (params.kind !== 'passkey') throw new Error(`this account uses ${params.kind} sign-in`);
    const prfSalt = b64.dec(params.salt);
    const challenge = await this.accountFetch(
      `/account/${encodeURIComponent(user)}/passkey/challenge`,
      {}
    );
    const assertion = await navigator.credentials.get({
      publicKey: parseRequestOptions(challenge, prfSalt),
    });
    const secret = prfSecret(assertion);
    if (!secret) throw new Error('authenticator returned no PRF secret');
    const reply = await this.accountFetch(`/account/${encodeURIComponent(user)}/passkey/login`, {
      assertion: serializeAssertion(assertion),
    });
    const identity = await decryptBlob(secret, b64.dec(reply.wrapped)).catch(() => {
      throw new Error('could not decrypt vault — corrupt data');
    });
    await this.restoreIdentity(identity);
    await this.completeOnboarding(true);
  }

  async accountFetch(path, body) {
    const res = await fetch(`${this.httpBase()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(res.status === 404 ? 'no such account' : text || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // === attachments ========================================================

  httpBase() {
    return this.relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  }

  async sendFile(serverId, channel, fileHandle) {
    if (fileHandle.size > 20 * 1024 * 1024) throw new Error('attachment too large (20 MB max)');
    const data = new Uint8Array(await fileHandle.arrayBuffer());
    // Random AES-GCM key per file; the relay sees only ciphertext under a
    // random capability id. The key rides inside the MLS message.
    const key = generateFragmentKey();
    const encrypted = await encryptBlob(key, data);
    const blobId = b64url.enc(crypto.getRandomValues(new Uint8Array(18)));
    const res = await fetch(`${this.httpBase()}/blobs/${blobId}`, {
      method: 'PUT',
      body: encrypted,
    });
    if (!res.ok) throw new Error(`upload failed: ${await res.text()}`);
    const file = {
      name: fileHandle.name,
      size: fileHandle.size,
      mime: fileHandle.type || 'application/octet-stream',
      blob: blobId,
      key: b64.enc(key),
    };
    await this.sendContent(serverId, { k: 'file', ch: channel, file });
    await this.storeMessage({ server: serverId, channel, sender: this.me, file, ts: Date.now() });
  }

  async fetchFile(file) {
    const res = await fetch(`${this.httpBase()}/blobs/${file.blob}`);
    if (!res.ok) throw new Error('attachment no longer available on the relay');
    const encrypted = new Uint8Array(await res.arrayBuffer());
    return decryptBlob(b64.dec(file.key), encrypted);
  }

  // === safety numbers =====================================================

  safetyNumber(serverId, peer) {
    return this.crypto('safetyNumber', { group: serverId, peer });
  }

  async markVerified(serverId, peer) {
    const record = this.servers.get(serverId);
    record.verified = [...new Set([...(record.verified ?? []), peer])];
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  // === web push ===========================================================

  async setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      this.swReg = await navigator.serviceWorker.register('/sw.js');
      return this.swReg;
    } catch (e) {
      console.warn(`service worker registration failed: ${e.message}`);
      return null;
    }
  }

  /** Explicit user action: ask permission, subscribe, hand the
      subscription to the relay so it can nudge this device when offline. */
  async enableNotifications() {
    if (!this.swReg) await this.setupServiceWorker();
    if (!this.swReg) throw new Error('service workers unavailable in this browser');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('notification permission denied');
    const info = await this.relay.request({ t: 'push_info' });
    const subscription = await this.swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64url.dec(info.pubkey),
    });
    await this.relay.request({
      t: 'push_subscribe',
      subscription: JSON.stringify(subscription.toJSON()),
    });
    return true;
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
    this.refreshRoles(group);
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
      .map((r) => ({
        ...r,
        channels: [...r.channels],
        voiceChannels: [...(r.voiceChannels ?? ['lounge'])],
        members: [...r.members],
        roles: { ...(r.roles ?? {}) },
      }));
  }

  async loadMessages(serverId, channel) {
    return this.db.msgsFor(serverId, channel);
  }

  toast(text) {
    this.dispatch({ type: 'toast', text });
  }
}
