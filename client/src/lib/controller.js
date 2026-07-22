// Orchestration: worker (crypto) <-> relay (transport) <-> IndexedDB
// (persistence) <-> React (render). The controller owns the canonical
// in-memory server records; React state is a projection of them.
//
// Message content is a JSON envelope INSIDE the MLS plaintext, so channel
// structure and server names are invisible to the relay:
//   {k:'chat', ch, text}          — a chat message in channel `ch`. A `ch`
//                                   of the form `voice:<room>` is a call's
//                                   conversation thread: same crypto, same
//                                   storage, but it belongs to the voice
//                                   room's stage, never the rooms sidebar
//   {k:'meta', name, channels,
//    chanMeta}                    — server metadata; rebroadcast after every
//                                   member add because joiners have no
//                                   scrollback to learn it from. chanMeta
//                                   carries per-channel topic/retention and —
//                                   when history is on — the channel history
//                                   key, so joining IS how the key is shared.
//   {k:'overview', ov}            — the home base's admin-edited half
//                                   changed: {blurb, links, event}. Rides
//                                   inside MLS like everything else, so the
//                                   relay never learns what a circle says
//                                   about itself
//   {k:'notice', op, n|id}        — the noticeboard: op 'add' pins {id,
//                                   text,ts} (author = MLS sender), op
//                                   'del' removes by id (author or admin)
//   {k:'chan', ch}                — a channel was created
//   {k:'chanset', ch, meta}       — a channel's settings changed (topic,
//                                   auto-delete, history on/off + its key)
//   {k:'file', ch, file}          — an attachment: {name,size,mime,blob,key};
//                                   blob id points at relay disk, the AES key
//                                   travels only inside this encrypted envelope
//   {k:'pres', playing}           — ephemeral rich presence: the sender is
//                                   in this game right now (or null = done).
//                                   In-memory only, expires client-side;
//                                   never persisted, never rebroadcast
//   {k:'react', ch, to:{sender,ts},
//    emo, op}                      — a reaction on one message (op add|del).
//                                   emo is a short string rendered as text
//   {k:'rsvp', at, going}          — answer to the hub's next-event card,
//                                   keyed to the event's timestamp so stale
//                                   answers die with the old event
//   {k:'game', ch, game}          — "I opened this game from the shelf":
//                                   {id,name,kind} renders as a join card.
//                                   The card resolves against the circle's
//                                   own registry — the payload itself never
//                                   supplies a URL to launch
import { b64, Relay } from './relay.js';
import {
  generateHistoryId,
  generateHistoryKey,
  messageFingerprint,
  openBackup,
  openHistoryEntry,
  sealBackup,
  sealHistoryEntry,
} from './history.js';
import { VoiceManager } from './voice.js';
import {
  VAULT_PRF_SALT,
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
import {
  canRemoveNotice,
  mergeNotices,
  normalizeNotice,
  normalizeOverview,
  reconcileMeta,
  upsertNotice,
} from './overview.js';
import { freshPresence, normalizeGameRef, normalizePresence, normalizeWant } from './games.js';

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

  /** Sign out of this device: wipe the local identity and every circle's
      keys, then reload to the onboarding gate. Nothing is sent to the relay
      — the account only ever lived here. Destructive: if the account was
      never secured (no vault, no exported key), this is unrecoverable, which
      is why the UI confirms first. */
  async logout() {
    try {
      this.relay?.close?.();
    } catch {
      /* already down */
    }
    // Drop the identity that would otherwise auto-restore on next boot
    // (see boot(): a surviving localStorage key resurrects the account even
    // with IndexedDB gone).
    localStorage.removeItem(IDENTITY_LS_KEY);
    // Release our connection so the delete isn't blocked, then wipe the DB.
    try {
      this.db?.close?.();
    } catch {
      /* not open */
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const req = indexedDB.deleteDatabase('e2ee-client');
        req.onsuccess = finish;
        req.onerror = finish;
        req.onblocked = finish;
      } catch {
        finish();
      }
      // Never hang the sign-out on a wedged delete.
      setTimeout(finish, 1500);
    });
    location.reload();
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
      send: (server, content, notify) => this.sendEphemeral(server, content, notify),
      onState: (state) => this.dispatch({ type: 'voice', state }),
      onNotify: (text) => this.dispatch({ type: 'toast', text }),
      // First joiner in an empty room = a call started; say so in the
      // room's first text channel so it reads like the event it is.
      onCallStarted: (server, channel, name) => {
        const record = this.servers.get(server);
        if (!record) return;
        const who = name === this.me ? 'you' : name;
        this.addSystemMessage(
          server,
          `${who} started a call in ${channel}`,
          record.channels[0] ?? 'general'
        ).catch(() => {});
      },
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
        // Restored records (from the encrypted backup) have no MLS state
        // to decrypt with — they stay read-only until a re-add arrives.
        for (const record of this.servers.values()) {
          if (record.restored) {
            this.refreshRoles(record.id);
            continue;
          }
          await this.relay
            .request({ t: 'subscribe', group: record.id, after: record.lastSeq })
            .catch((e) => {
              // The relay says we're not a member (removed while offline) or
              // the group is gone (deleted): forget it here instead of
              // retrying forever against a circle we can no longer see.
              if (/not a member|no such group/i.test(e.message)) {
                this.toast(`you no longer have access to "${record.name}"`);
                this.forgetServerLocal(record.id).catch(() => {});
              } else {
                this.toast(`subscribe ${record.id}: ${e.message}`);
              }
            });
          this.refreshRoles(record.id);
        }
        // A fresh sign-in has an identity but no circles: pull the
        // encrypted backup (if one was parked) and restore what this
        // account knew — names, channels, and channel history keys.
        if (this.servers.size === 0) {
          await this.restoreFromBackup().catch((e) =>
            console.warn(`backup restore: ${e.message}`)
          );
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
          if (!record.restored) this.voice.probe(record.id);
        }
        // Catch up channel history logs: fills any gap between what this
        // device saw live and what senders parked (deduplicated), and is
        // what populates a just-restored device.
        for (const record of this.servers.values()) {
          this.backfillHistory(record).catch((e) =>
            console.warn(`history backfill ${record.id}: ${e.message}`)
          );
        }
        // One-shot per session: rebroadcast our own view of each circle's
        // shape. Members can't create channels/voice rooms, so a room that
        // exists on one device but not another is pure sync divergence — a
        // role-gated chan/vchan event some peer dropped, or one sent while a
        // peer was offline. The `meta` union (ungated) adopts any room the
        // receiver is missing, so a single rebroadcast per device converges
        // everyone. Skip restored stubs (no MLS state to send with) and
        // pendingMetaSync records (their shape is unreconciled — sending it
        // could spread a stale view instead of healing).
        if (!this.metaHealed) {
          this.metaHealed = true;
          for (const record of this.servers.values()) {
            if (record.restored || record.pendingMetaSync) continue;
            this.sendContent(record.id, this.metaContent(record)).catch((e) =>
              console.warn(`meta heal ${record.id}: ${e.message}`)
            );
          }
        }
        this.scheduleBackup();
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
      } else if (content.k === 'pres') {
        this.setLivePresence(msg.group, event.sender, normalizePresence(content));
      } else if (content.k === 'want') {
        this.setLiveWant(msg.group, event.sender, normalizeWant(content));
      }
    } catch (e) {
      console.warn(`ephemeral from ${msg.sender} undecryptable: ${e.message}`);
    }
  }

  /** Encrypt with MLS, deliver via the relay's no-log fan-out. `notify`
      (optional) push-wakes members who aren't live — an array of handles,
      or '*' for the whole roster minus me. This is how a ring reaches a
      closed app; the relay learns only "these members should look now",
      never what the blob says. */
  async sendEphemeral(serverId, content, notify, notifyKind) {
    const { blob, state } = await this.crypto('send', {
      group: serverId,
      text: JSON.stringify(content),
    });
    await this.persistState(state);
    const record = this.servers.get(serverId);
    const names =
      notify === '*' ? (record?.members ?? []).filter((m) => m !== this.me) : notify;
    await this.relay.request({
      t: 'ephemeral',
      group: serverId,
      payload: b64.enc(blob),
      ...(names?.length ? { notify: names } : {}),
      // Tells the relay which kind of nudge to push (defaults to a call);
      // rallies label themselves so a closed app shows the right text.
      ...(names?.length && notifyKind ? { notify_kind: notifyKind } : {}),
    });
  }

  async onWelcome(msg) {
    const { group, epoch, members, state } = await this.crypto('joinFromWelcome', {
      welcome: b64.dec(msg.payload),
    });
    await this.persistState(state);
    // A backup-restored record may already exist for this circle — being
    // re-added upgrades it to a live one; keep everything it knew.
    const prior = this.servers.get(group);
    const record = {
      id: group,
      name: prior?.name ?? group, // placeholder until the meta rebroadcast lands
      channels: prior?.channels ?? ['general'],
      voiceChannels: prior?.voiceChannels ?? ['lounge'],
      chanMeta: prior?.chanMeta ?? {},
      overview: prior?.overview,
      notices: prior?.notices ?? [],
      seen: prior?.seen ?? {},
      hcursor: prior?.hcursor ?? {},
      verified: prior?.verified,
      members,
      epoch,
      lastSeq: msg.after,
      joinedAt: prior?.joinedAt ?? Date.now(),
      // This device resumes the log *after* the point it was added, so it
      // will never replay the channel/overview/notice changes that happened
      // while it was gone. Whatever shape it is carrying (a restored stub, or
      // a stale live record from before it was removed) may be out of date:
      // let the next meta rebroadcast reconcile it authoritatively instead of
      // just unioning, so deletions actually land. See the `meta` handler.
      pendingMetaSync: true,
    };
    this.servers.set(group, record);
    await this.db.serverPut(record);
    await this.addSystemMessage(
      group,
      prior?.restored
        ? `you were re-added — this device can send again`
        : `you joined — history before this point does not exist for you`
    );
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.relay.request({ t: 'subscribe', group, after: msg.after });
    this.refreshRoles(group);
    this.backfillHistory(record).catch((e) => console.warn(`history: ${e.message}`));
    this.scheduleBackup();
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
        // Were we the one dropped? A re-key that no longer lists us means we
        // were removed (kicked, or the circle is being deleted). Forget it
        // here and stop — the record is gone, so don't fall through to the
        // serverPut below, which would resurrect it.
        if (!event.members.includes(this.me)) {
          this.toast(`you were removed from "${record.name}"`);
          await this.forgetServerLocal(record.id);
          return;
        }
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
          // group rebroadcasts the metadata they missed (including channel
          // history keys — sharing them with the roster is their design).
          if (record.invites?.length) {
            await this.sendContent(record.id, this.metaContent(record));
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
        this.ensureChannel(record, content.ch);
        await this.storeMessage({
          server: record.id,
          channel: content.ch,
          sender,
          text: content.text,
          ts: messageTs(content.ts),
        });
        break;
      }
      case 'game': {
        // Same channel handling as chat; the ref is whitelisted and the
        // Join affordance resolves against the shelf, never this payload.
        const game = normalizeGameRef(content.game);
        if (!game) break;
        this.ensureChannel(record, content.ch);
        await this.storeMessage({
          server: record.id,
          channel: content.ch,
          sender,
          game,
          ts: messageTs(content.ts),
        });
        break;
      }
      case 'pres': {
        // Ephemeral by design: kept in a controller-side map, expired by
        // readers, never written to the record store or the backup.
        this.setLivePresence(record.id, sender, normalizePresence(content));
        break;
      }
      case 'want': {
        // A rally — same ephemeral discipline as presence: a controller-side
        // map, reader-expired, never persisted to the record or the backup.
        this.setLiveWant(record.id, sender, normalizeWant(content));
        break;
      }
      case 'react': {
        const emo = String(content.emo ?? '').slice(0, 8).trim();
        const to = content.to ?? {};
        const op = content.op === 'del' ? 'del' : 'add';
        if (!emo || !to.sender || !Number.isFinite(Number(to.ts))) break;
        await this.applyReaction(record.id, String(content.ch ?? ''), {
          sender: String(to.sender),
          ts: Number(to.ts),
        }, emo, op, sender);
        this.dispatch({ type: 'refreshMessages' });
        break;
      }
      case 'rsvp': {
        const at = Number(content.at);
        if (!Number.isFinite(at)) break;
        const rsvps = { ...(record.rsvps ?? {}) };
        if (content.going) rsvps[sender] = { at, ts: Date.now() };
        else delete rsvps[sender];
        record.rsvps = rsvps;
        break;
      }
      case 'meta': {
        record.name = content.name ?? record.name;
        // A device catching up after a (re-)join or restore may be holding a
        // stale shape: phantom channels a since-departed admin deleted, a game
        // hub from before the shelf changed, notices long since unpinned. It
        // resumed the log past those events and will never replay them, but the
        // rebroadcaster has and is authoritative — so adopt its snapshot
        // wholesale. The union path below can only ever grow the shape; this is
        // the one place it must be allowed to shrink.
        if (record.pendingMetaSync) {
          record.pendingMetaSync = false;
          Object.assign(record, reconcileMeta(content));
          // The snapshot is authoritative about what exists now, so a channel
          // or voice room it lists is not a tombstone — drop any stale one so
          // it isn't wrongly blocked from re-appearing.
          if (record.deletedChannels?.length) {
            record.deletedChannels = record.deletedChannels.filter(
              (c) => !record.channels.includes(c)
            );
          }
          if (record.deletedVoice?.length) {
            record.deletedVoice = record.deletedVoice.filter(
              (c) => !(record.voiceChannels ?? []).includes(c)
            );
          }
          this.backfillHistory(record).catch((e) => console.warn(`history: ${e.message}`));
          this.scheduleBackup();
          break;
        }
        // Union gap-fill: adopt rooms this device is missing, but never a room
        // it has seen deleted — otherwise a peer that missed the deletion
        // would resurrect it on every meta rebroadcast (now one per connect).
        for (const ch of content.channels ?? []) {
          if (!record.channels.includes(ch) && !(record.deletedChannels ?? []).includes(ch)) {
            record.channels.push(ch);
          }
        }
        if (content.voiceChannels) {
          const rooms = record.voiceChannels ?? ['lounge'];
          for (const ch of content.voiceChannels) {
            if (!rooms.includes(ch) && !(record.deletedVoice ?? []).includes(ch)) rooms.push(ch);
          }
          record.voiceChannels = rooms;
        }
        // Gap-fill the home base the same way: a joiner has none, and
        // explicit edits arrive as their own `overview`/`notice` events.
        // Adopting it re-parks the backup so it survives a vault restore.
        if (content.overview !== undefined && record.overview == null) {
          const adopted = normalizeOverview(content.overview);
          if (adopted) {
            record.overview = adopted;
            this.scheduleBackup();
          }
        }
        // Noticeboard union: ids this device already has win. Authors in a
        // rebroadcast are vouched for by the rebroadcaster, like the rest
        // of the metadata a joiner has no scrollback to verify.
        if (Array.isArray(content.notices) && content.notices.length) {
          const incoming = content.notices
            .map((n) => normalizeNotice(n, n?.author))
            .filter(Boolean);
          const merged = mergeNotices(record.notices, incoming);
          if (merged.length !== (record.notices ?? []).length) {
            record.notices = merged;
            this.scheduleBackup();
          }
        }
        // Gap-fill RSVPs the same way (a joiner has none). Bounded and
        // whitelisted: handle -> {at}. Existing local answers win.
        if (content.rsvps && typeof content.rsvps === 'object') {
          const mine = record.rsvps ?? {};
          const merged = { ...mine };
          for (const [handle, v] of Object.entries(content.rsvps).slice(0, 64)) {
            const at = Number(v?.at);
            if (!Number.isFinite(at) || merged[handle]) continue;
            merged[String(handle).slice(0, 64)] = { at, ts: Number(v?.ts) || Date.now() };
          }
          record.rsvps = merged;
        }
        // Gap-fill channel settings (a joiner has none): explicit changes
        // arrive as their own `chanset` events, so never clobber here.
        if (content.chanMeta) {
          const mine = record.chanMeta ?? {};
          for (const [ch, meta] of Object.entries(content.chanMeta)) {
            mine[ch] = { ...meta, ...(mine[ch] ?? {}) };
          }
          record.chanMeta = mine;
          this.backfillHistory(record).catch((e) => console.warn(`history: ${e.message}`));
        }
        break;
      }
      case 'chanset': {
        // A channel's settings changed: topic, auto-delete, or history
        // (the history key itself rides in `meta.hkey` — inside MLS, so
        // the relay never sees it). The sender's copy is authoritative.
        // Same advisory admin gate as `chan`: ignore senders we know are
        // not admins, fail open while roles are still syncing.
        if (!(await this.senderIsAdmin(record, sender))) break;
        if (!record.channels.includes(content.ch)) record.channels.push(content.ch);
        record.chanMeta = { ...(record.chanMeta ?? {}), [content.ch]: content.meta ?? {} };
        await this.addSystemMessage(
          record.id,
          `#${content.ch} settings changed by ${sender}${describeChanMeta(content.meta)}`,
          content.ch
        );
        await this.applyRetention(record, content.ch);
        this.backfillHistory(record).catch((e) => console.warn(`history: ${e.message}`));
        this.scheduleBackup();
        break;
      }
      case 'overview': {
        // The home base's admin-edited half changed. Same advisory admin
        // gate as `chanset`: MLS can't enforce roles, so ignore senders we
        // know are not admins and fail open while roles are still syncing.
        if (!(await this.senderIsAdmin(record, sender))) break;
        record.overview = normalizeOverview(content.ov);
        await this.addSystemMessage(record.id, `home base updated by ${sender}`);
        this.scheduleBackup();
        break;
      }
      case 'notice': {
        // The noticeboard is the whole roster's — any member may pin. The
        // author is the MLS-authenticated sender, never the payload.
        if (content.op === 'add') {
          const notice = normalizeNotice(content.n, sender);
          if (notice) {
            record.notices = upsertNotice(record.notices, notice);
            this.scheduleBackup();
          }
        } else if (content.op === 'del') {
          const target = (record.notices ?? []).find((n) => n.id === content.id);
          if (target && canRemoveNotice(target, sender, record.roles)) {
            record.notices = record.notices.filter((n) => n.id !== content.id);
            this.scheduleBackup();
          }
        }
        break;
      }
      case 'file': {
        this.ensureChannel(record, content.ch);
        await this.storeMessage({
          server: record.id,
          channel: content.ch,
          sender,
          file: content.file,
          ts: messageTs(content.ts),
        });
        break;
      }
      case 'chan': {
        // Only admins may create channels. Enforced client-side (the relay
        // can't read content): ignore a chan from someone we know is not an
        // admin. Fail open if the sender's role isn't known yet, so a legit
        // creation racing role sync isn't dropped.
        if (!(await this.senderIsAdmin(record, sender))) break;
        this.clearChannelDeleted(record, content.ch);
        if (!record.channels.includes(content.ch)) {
          record.channels.push(content.ch);
          await this.addSystemMessage(record.id, `#${content.ch} created by ${sender}`, content.ch);
          this.scheduleBackup();
        }
        break;
      }
      case 'vchan': {
        if (!(await this.senderIsAdmin(record, sender))) break;
        this.clearVoiceDeleted(record, content.ch);
        const rooms = record.voiceChannels ?? ['lounge'];
        if (!rooms.includes(content.ch)) {
          record.voiceChannels = [...rooms, content.ch];
          await this.addSystemMessage(record.id, `voice room "${content.ch}" created by ${sender}`);
        }
        break;
      }
      case 'chan-ren': {
        if (!(await this.senderIsAdmin(record, sender))) break;
        if (record.channels.includes(content.ch) && !record.channels.includes(content.to)) {
          record.channels = record.channels.map((c) => (c === content.ch ? content.to : c));
          this.markChannelDeleted(record, content.ch);
          this.clearChannelDeleted(record, content.to);
          if (record.chanMeta?.[content.ch]) {
            record.chanMeta = { ...record.chanMeta, [content.to]: record.chanMeta[content.ch] };
            delete record.chanMeta[content.ch];
          }
          await this.db.msgsRename(record.id, content.ch, content.to);
          await this.addSystemMessage(record.id, `#${content.ch} renamed to #${content.to}`, content.to);
          this.dispatch({ type: 'refreshMessages' });
          this.scheduleBackup();
        }
        break;
      }
      case 'chan-del': {
        if (!(await this.senderIsAdmin(record, sender))) break;
        if (record.channels.includes(content.ch) && record.channels.length > 1) {
          record.channels = record.channels.filter((c) => c !== content.ch);
          this.markChannelDeleted(record, content.ch);
          if (record.chanMeta?.[content.ch]) {
            record.chanMeta = { ...record.chanMeta };
            delete record.chanMeta[content.ch];
          }
          await this.db.msgsDelete(record.id, content.ch);
          await this.addSystemMessage(record.id, `#${content.ch} deleted by ${sender}`);
          this.scheduleBackup();
        }
        break;
      }
      case 'vchan-ren': {
        if (!(await this.senderIsAdmin(record, sender))) break;
        const rooms = record.voiceChannels ?? ['lounge'];
        if (rooms.includes(content.ch) && !rooms.includes(content.to)) {
          record.voiceChannels = rooms.map((c) => (c === content.ch ? content.to : c));
          this.markVoiceDeleted(record, content.ch);
          this.clearVoiceDeleted(record, content.to);
          if (this.voice?.active?.server === record.id && this.voice.active.channel === content.ch) {
            await this.voice.leave();
          }
          await this.addSystemMessage(record.id, `voice room "${content.ch}" renamed to "${content.to}"`);
          this.scheduleBackup();
        }
        break;
      }
      case 'vchan-del': {
        if (!(await this.senderIsAdmin(record, sender))) break;
        const rooms = record.voiceChannels ?? ['lounge'];
        if (rooms.includes(content.ch)) {
          record.voiceChannels = rooms.filter((c) => c !== content.ch);
          this.markVoiceDeleted(record, content.ch);
          if (this.voice?.active?.server === record.id && this.voice.active.channel === content.ch) {
            await this.voice.leave();
          }
          await this.addSystemMessage(record.id, `voice room "${content.ch}" deleted by ${sender}`);
          this.scheduleBackup();
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
    this.scheduleBackup();
    return id;
  }

  // === channel presence guard ============================================
  //
  // A message can legitimately arrive for a channel this device hasn't been
  // told about yet — its `chan` event still in flight over the ordered log,
  // or a channel created before we joined. We surface such a channel so the
  // message isn't stranded. But the log is not perfectly ordered relative to
  // deletes, and a re-added device can be handed old blobs: a late, replayed,
  // or reordered message for a *deleted* channel must never bring it back.
  // Deleted names are tombstoned (bounded) so only an explicit admin `chan`
  // re-creation can revive them.
  static DELETED_MAX = 200;

  /** Surface an unknown channel for an incoming message, unless it is a call
      thread or a room we have seen deleted. */
  ensureChannel(record, ch) {
    if (isCallChat(ch) || record.channels.includes(ch)) return;
    if ((record.deletedChannels ?? []).includes(ch)) return;
    record.channels.push(ch);
  }

  /** Remember a removed channel so a stray message can't resurrect it. */
  markChannelDeleted(record, ch) {
    record.deletedChannels = [...new Set([...(record.deletedChannels ?? []), ch])].slice(
      -Controller.DELETED_MAX
    );
  }

  /** A channel is legitimately (re-)created: it is no longer a tombstone. */
  clearChannelDeleted(record, ch) {
    if (record.deletedChannels?.length) {
      record.deletedChannels = record.deletedChannels.filter((c) => c !== ch);
    }
  }

  /** Voice rooms get the same tombstone treatment as text channels, so the
      meta union (now rebroadcast on every connect to heal divergence) can't
      resurrect a room this device has seen deleted. */
  markVoiceDeleted(record, ch) {
    record.deletedVoice = [...new Set([...(record.deletedVoice ?? []), ch])].slice(
      -Controller.DELETED_MAX
    );
  }

  clearVoiceDeleted(record, ch) {
    if (record.deletedVoice?.length) {
      record.deletedVoice = record.deletedVoice.filter((c) => c !== ch);
    }
  }

  /** The full metadata snapshot a joiner (or a peer that missed an event)
      needs to reconstruct the circle's shape. Rebroadcast on member add and
      after a structural change so the ungated `meta` union self-heals any
      device that dropped the original, role-gated `chan`/`vchan` event. */
  metaContent(record) {
    return {
      k: 'meta',
      name: record.name,
      channels: record.channels,
      voiceChannels: record.voiceChannels ?? ['lounge'],
      chanMeta: record.chanMeta ?? {},
      overview: record.overview ?? null,
      notices: record.notices ?? [],
      rsvps: record.rsvps ?? {},
    };
  }

  async createChannel(serverId, channel) {
    const record = this.servers.get(serverId);
    const ch = channel.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!ch || record.channels.includes(ch)) return;
    record.channels.push(ch);
    this.clearChannelDeleted(record, ch);
    await this.sendContent(serverId, { k: 'chan', ch });
    // The `chan` event above is dropped by any peer that doesn't yet see us
    // as an admin (stale role cache, or a global admin who is only a circle
    // member). Follow it with a meta snapshot so the ungated union repairs
    // them — otherwise the room shows for us and never for them.
    await this.sendContent(serverId, this.metaContent(record));
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  /** Change a channel's settings: topic, auto-delete (retention, seconds),
      and whether the channel keeps encrypted history for joiners. The UI
      gates this to admins; inside the group it is a visible, announced
      change like channel creation — MLS can't enforce roles, so the
      roster's own eyes are the enforcement. */
  async setChannelSettings(serverId, channel, { topic, retention, history }) {
    const record = this.servers.get(serverId);
    const prev = record.chanMeta?.[channel] ?? {};
    const meta = { ...prev };

    if (topic !== undefined) {
      if (topic) meta.topic = topic;
      else delete meta.topic;
    }
    if (retention !== undefined) {
      if (retention) meta.retention = retention;
      else delete meta.retention;
    }
    if (history !== undefined) {
      if (history && !meta.hid) {
        // Turning history on mints the channel's key. From here on, every
        // message is also sealed under it and parked on the relay; anyone
        // who joins gets the key with the metadata and can read back.
        meta.hid = generateHistoryId();
        meta.hkey = generateHistoryKey();
      } else if (!history && meta.hid) {
        // Off: stop writing, drop the key, and ask the relay to delete the
        // ciphertext (server-enforced deletion — honest-weak, but the key
        // is gone from future meta shares either way).
        this.relay
          .request({ t: 'history_prune', group: serverId, hid: meta.hid, before_ts: Number.MAX_SAFE_INTEGER })
          .catch((e) => console.warn(`history wipe: ${e.message}`));
        delete meta.hid;
        delete meta.hkey;
      }
    }

    record.chanMeta = { ...(record.chanMeta ?? {}), [channel]: meta };
    await this.sendContent(serverId, { k: 'chanset', ch: channel, meta });
    await this.addSystemMessage(
      serverId,
      `#${channel} settings changed by you${describeChanMeta(meta)}`,
      channel
    );
    // Retention shrank (or appeared): prune the relay log now — new
    // entries carry their own expiry, this covers the ones that predate
    // the change.
    if (meta.hid && meta.retention && meta.retention !== prev.retention) {
      this.relay
        .request({
          t: 'history_prune',
          group: serverId,
          hid: meta.hid,
          before_ts: Math.floor(Date.now() / 1000) - meta.retention,
        })
        .catch((e) => console.warn(`history prune: ${e.message}`));
    }
    await this.applyRetention(record, channel);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.dispatch({ type: 'refreshMessages' });
    this.scheduleBackup();
  }

  /** Replace the home base's admin-edited half (blurb, pinned links, next
      event). The UI gates this to admins; inside the group it is a visible,
      announced change like channel settings — the roster's own eyes are
      the enforcement. */
  async setOverview(serverId, overview) {
    const record = this.servers.get(serverId);
    record.overview = normalizeOverview(overview);
    await this.sendContent(serverId, { k: 'overview', ov: record.overview });
    await this.addSystemMessage(serverId, 'home base updated by you');
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  /** Pin a note to the noticeboard — open to every member, not just
      admins; a home base belongs to the whole roster. */
  async addNotice(serverId, text) {
    const record = this.servers.get(serverId);
    const id = b64url.enc(crypto.getRandomValues(new Uint8Array(9)));
    const notice = normalizeNotice({ id, text, ts: Date.now() }, this.me);
    if (!notice) return;
    record.notices = upsertNotice(record.notices, notice);
    await this.sendContent(serverId, { k: 'notice', op: 'add', n: { id, text: notice.text, ts: notice.ts } });
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  /** Unpin a note (the UI offers this to the author and to admins; the
      receive side re-checks the same rule). */
  async removeNotice(serverId, id) {
    const record = this.servers.get(serverId);
    record.notices = (record.notices ?? []).filter((n) => n.id !== id);
    await this.sendContent(serverId, { k: 'notice', op: 'del', id });
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  // === home-base catch-up (device-local, never synced) ====================

  /** Viewing a room marks it read on this device. `seen` is deliberately
      per-device state: what *you* have caught up on, not account data —
      it stays out of the meta envelopes and the backup. */
  async markSeen(serverId, channel, atLeastTs = 0) {
    const record = this.servers.get(serverId);
    if (!record || !channel) return;
    // Message ts is the *sender's* clock; take the max with our own so a
    // fast sender clock can't leave an already-read message counted unread.
    record.seen = { ...(record.seen ?? {}), [channel]: Math.max(Date.now(), atLeastTs) };
    await this.db.serverPut(record);
  }

  /** Per-room digest for the home base: unread-since-last-look and the
      latest line, straight from this device's own store. */
  async channelDigest(serverId) {
    const record = this.servers.get(serverId);
    if (!record) return [];
    const out = [];
    for (const channel of record.channels) {
      const msgs = (await this.db.msgsFor(serverId, channel))
        .filter((m) => !m.system)
        .sort((a, b) => a.ts - b.ts);
      const seen = record.seen?.[channel] ?? record.joinedAt ?? 0;
      const unread = msgs.filter((m) => m.ts > seen && m.sender !== this.me).length;
      const last = msgs.at(-1);
      out.push({
        channel,
        unread,
        last: last
          ? {
              sender: last.sender,
              text: last.file ? `sent ${last.file.name}` : last.text,
              ts: last.ts,
            }
          : null,
      });
    }
    return out;
  }

  /** Local half of auto-delete: drop this device's copies past retention. */
  async applyRetention(record, channel) {
    const retention = record.chanMeta?.[channel]?.retention;
    if (!retention) return;
    await this.db.msgsPrune(record.id, channel, Date.now() - retention * 1000);
  }

  /** Create a named voice room. Like text rooms, the name travels inside the
      encryption; the relay only ever sees an opaque ephemeral/log blob. */
  async createVoiceChannel(serverId, channel) {
    const record = this.servers.get(serverId);
    const ch = channel.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const rooms = record.voiceChannels ?? ['lounge'];
    if (!ch || rooms.includes(ch)) return;
    record.voiceChannels = [...rooms, ch];
    this.clearVoiceDeleted(record, ch);
    await this.sendContent(serverId, { k: 'vchan', ch });
    // Same self-heal as createChannel: a meta snapshot after the gated
    // `vchan` so peers that dropped it still pick the voice room up.
    await this.sendContent(serverId, this.metaContent(record));
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  static slugChannel(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /** Rename a text channel: its message history and settings follow the new
      name. Announced in-channel like other admin actions. */
  async renameChannel(serverId, from, to) {
    const record = this.servers.get(serverId);
    const ch = Controller.slugChannel(to);
    if (!ch || ch === from || !record.channels.includes(from) || record.channels.includes(ch)) return;
    record.channels = record.channels.map((c) => (c === from ? ch : c));
    this.markChannelDeleted(record, from);
    this.clearChannelDeleted(record, ch);
    if (record.chanMeta?.[from]) {
      record.chanMeta = { ...record.chanMeta, [ch]: record.chanMeta[from] };
      delete record.chanMeta[from];
    }
    await this.db.msgsRename(serverId, from, ch);
    await this.sendContent(serverId, { k: 'chan-ren', ch: from, to: ch });
    await this.addSystemMessage(serverId, `#${from} renamed to #${ch}`, ch);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.dispatch({ type: 'refreshMessages' });
    this.scheduleBackup();
  }

  /** Delete a text channel and purge its local history. */
  async deleteChannel(serverId, channel) {
    const record = this.servers.get(serverId);
    if (!record.channels.includes(channel)) return;
    if (record.channels.length <= 1) throw new Error('a server needs at least one channel');
    record.channels = record.channels.filter((c) => c !== channel);
    this.markChannelDeleted(record, channel);
    if (record.chanMeta?.[channel]) {
      record.chanMeta = { ...record.chanMeta };
      delete record.chanMeta[channel];
    }
    await this.db.msgsDelete(serverId, channel);
    await this.sendContent(serverId, { k: 'chan-del', ch: channel });
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  async renameVoiceChannel(serverId, from, to) {
    const record = this.servers.get(serverId);
    const rooms = record.voiceChannels ?? ['lounge'];
    const ch = Controller.slugChannel(to);
    if (!ch || ch === from || !rooms.includes(from) || rooms.includes(ch)) return;
    record.voiceChannels = rooms.map((c) => (c === from ? ch : c));
    this.markVoiceDeleted(record, from);
    this.clearVoiceDeleted(record, ch);
    if (this.voice?.active?.server === serverId && this.voice.active.channel === from) {
      await this.voice.leave();
    }
    await this.sendContent(serverId, { k: 'vchan-ren', ch: from, to: ch });
    await this.addSystemMessage(serverId, `voice room "${from}" renamed to "${ch}"`);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  async deleteVoiceChannel(serverId, channel) {
    const record = this.servers.get(serverId);
    const rooms = record.voiceChannels ?? ['lounge'];
    if (!rooms.includes(channel)) return;
    record.voiceChannels = rooms.filter((c) => c !== channel);
    this.markVoiceDeleted(record, channel);
    if (this.voice?.active?.server === serverId && this.voice.active.channel === channel) {
      await this.voice.leave();
    }
    await this.sendContent(serverId, { k: 'vchan-del', ch: channel });
    await this.addSystemMessage(serverId, `voice room "${channel}" deleted`);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  async sendChat(serverId, channel, text) {
    // The timestamp is the sender's, carried on the wire, so every device —
    // and the kept-history log — stamps this message identically. Otherwise
    // each recipient's own receive-clock ts would (a) order messages
    // differently per member and (b) defeat the history dedup, which keys on
    // ts, duplicating every backfilled line. See `messageTs`.
    //
    // Store-then-send: the user's own line renders immediately and, if the
    // network send fails (offline, half-open socket), it stays visible as
    // *failed* with a retry — instead of silently vanishing from the input.
    const ts = Date.now();
    await this.storeMessage({ server: serverId, channel, sender: this.me, text, ts, pending: true });
    await this.deliverChat(serverId, channel, text, ts);
  }

  /** Network half of sendChat; also the retry path for a failed line. */
  async deliverChat(serverId, channel, text, ts) {
    try {
      await this.sendContent(serverId, { k: 'chat', ch: channel, text, ts });
    } catch (e) {
      await this.db.msgPatch(serverId, channel, this.me, ts, (m) => ({
        ...m,
        pending: false,
        failed: true,
      }));
      this.dispatch({ type: 'refreshMessages' });
      throw e;
    }
    await this.db.msgPatch(serverId, channel, this.me, ts, ({ pending, failed, ...m }) => m);
    this.dispatch({ type: 'refreshMessages' });
    this.appendHistory(serverId, channel, { server: serverId, channel, sender: this.me, text, ts });
  }

  /** Retry a message that failed to send (still stored locally). */
  async retryMessage(serverId, channel, message) {
    await this.db.msgPatch(serverId, channel, this.me, message.ts, (m) => ({
      ...m,
      pending: true,
      failed: false,
    }));
    this.dispatch({ type: 'refreshMessages' });
    await this.deliverChat(serverId, channel, message.text, message.ts);
  }

  /** Announce a game launch as a first-class message: renders as a join
      card for everyone in the room. Only a reference travels — id, name,
      kind — never a URL; joining resolves against the shelf. */
  async sendGameCard(serverId, channel, game) {
    const ref = normalizeGameRef(game);
    if (!ref) return;
    const ts = Date.now();
    await this.sendContent(serverId, { k: 'game', ch: channel, game: ref, ts });
    const message = { server: serverId, channel, sender: this.me, game: ref, ts };
    await this.storeMessage(message);
    this.appendHistory(serverId, channel, message);
  }

  /** Ephemeral rich presence: tell the circle which game I'm in (or that
      I left one). Riding MLS like everything else, the relay learns
      nothing; peers keep it in memory only and expire it. */
  async setPlaying(serverId, gameRef) {
    if (!this.servers.get(serverId)) return;
    const playing = gameRef ? normalizeGameRef(gameRef) : null;
    const ts = Date.now();
    this.setLivePresence(serverId, this.me, { playing, ts });
    // Ephemeral fan-out, not the group log: a presence claim replayed from
    // the log on catch-up would resurrect "in game" long after the game
    // ended. The ts rides along so even a delayed copy ages out correctly.
    await this.sendEphemeral(serverId, { k: 'pres', playing, ts });
  }

  setLivePresence(serverId, handle, entry) {
    if (!this.livePresence) this.livePresence = new Map();
    const map = this.livePresence.get(serverId) ?? {};
    map[handle] = entry;
    this.livePresence.set(serverId, map);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Ephemeral rally: "I want to play X — come join" (or, with a null ref,
      that I'm standing down). Same wire and same discipline as setPlaying —
      fanned out over MLS, kept only in memory, expired by readers — so the
      relay learns nothing and a replay can't resurrect a stale rally. */
  async setWant(serverId, gameRef) {
    if (!this.servers.get(serverId)) return;
    const want = gameRef ? normalizeGameRef(gameRef) : null;
    const ts = Date.now();
    this.setLiveWant(serverId, this.me, { want, ts });
    // Starting a rally push-wakes offline members ("a rally was started");
    // standing down (null ref) stays silent — nothing to gather around.
    await this.sendEphemeral(serverId, { k: 'want', want, ts }, want ? '*' : undefined, 'rally');
  }

  setLiveWant(serverId, handle, entry) {
    if (!this.liveWants) this.liveWants = new Map();
    const map = this.liveWants.get(serverId) ?? {};
    map[handle] = entry;
    this.liveWants.set(serverId, map);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Toggle my reaction on one message. The reaction set lives on the
      stored message; deduped per (member, emoji). */
  async react(serverId, channel, target, emo) {
    const record = this.servers.get(serverId);
    if (!record) return;
    const mine = await this.applyReaction(serverId, channel, target, emo, 'toggle', this.me);
    this.dispatch({ type: 'refreshMessages' });
    await this.sendContent(serverId, {
      k: 'react',
      ch: channel,
      to: { sender: target.sender, ts: target.ts },
      emo,
      op: mine ? 'add' : 'del',
    });
  }

  /** Mutate a stored message's reaction map. Returns whether `who` ends up
      reacted (for toggle senders). Not written to kept-history — reactions
      are decoration, the message is the record. */
  async applyReaction(serverId, channel, target, emo, op, who) {
    let present = false;
    await this.db.msgPatch(serverId, channel, target.sender, target.ts, (m) => {
      const reacts = { ...(m.reacts ?? {}) };
      const set = new Set(reacts[emo] ?? []);
      const want = op === 'toggle' ? !set.has(who) : op === 'add';
      want ? set.add(who) : set.delete(who);
      present = want;
      if (set.size) reacts[emo] = [...set];
      else delete reacts[emo];
      return { ...m, reacts };
    });
    return present;
  }

  /** Answer the hub's next-event card. Keyed to the event timestamp, so
      answers for a replaced event simply stop counting. */
  async rsvp(serverId, at, going) {
    const record = this.servers.get(serverId);
    if (!record) return;
    const rsvps = { ...(record.rsvps ?? {}) };
    if (going) rsvps[this.me] = { at, ts: Date.now() };
    else delete rsvps[this.me];
    record.rsvps = rsvps;
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.sendContent(serverId, { k: 'rsvp', at, going: !!going });
  }

  /** Sender-side write into the channel's encrypted relay history log —
      only if this channel keeps history. Best-effort: the MLS message is
      the message; the log is a convenience copy. */
  appendHistory(serverId, channel, message) {
    const meta = this.servers.get(serverId)?.chanMeta?.[channel];
    if (!meta?.hkey || !meta?.hid) return;
    const tsSecs = Math.floor(message.ts / 1000);
    const entry = {
      sender: message.sender,
      ts: message.ts,
      ...(message.file
        ? { file: message.file }
        : message.game
          ? { game: message.game }
          : { text: message.text }),
    };
    sealHistoryEntry(meta.hkey, entry)
      .then((payload) =>
        this.relay.request({
          t: 'history_append',
          group: serverId,
          hid: meta.hid,
          ts: tsSecs,
          expires_at: meta.retention ? tsSecs + meta.retention : null,
          payload,
        })
      )
      .catch((e) => console.warn(`history append: ${e.message}`));
  }

  /** Pull new entries from every kept-history channel of `record`, decrypt
      them with the channel keys, and store the ones this device doesn't
      already have (deduplicated by content against live-received MLS
      copies). This is what fills a joiner's or restored device's past. */
  async backfillHistory(record) {
    const chanMeta = record.chanMeta ?? {};
    let restoredTotal = 0;
    for (const [channel, meta] of Object.entries(chanMeta)) {
      if (!meta?.hkey || !meta?.hid) continue;
      const cursor = record.hcursor?.[meta.hid] ?? 0;
      let reply;
      try {
        reply = await this.relay.request({
          t: 'history_fetch',
          group: record.id,
          hid: meta.hid,
          after: cursor,
        });
      } catch (e) {
        console.warn(`history fetch #${channel}: ${e.message}`);
        continue;
      }
      if (!reply.entries?.length) continue;
      const existing = await this.db.msgsFor(record.id, channel);
      const seen = new Set(existing.filter((m) => !m.system).map(messageFingerprint));
      const cutoff = meta.retention ? Date.now() - meta.retention * 1000 : 0;
      let added = 0;
      let maxSeq = cursor;
      for (const e of reply.entries) {
        maxSeq = Math.max(maxSeq, e.seq);
        let entry;
        try {
          entry = await openHistoryEntry(meta.hkey, e.payload);
        } catch {
          continue; // key rotated or blob damaged — skip, don't wedge
        }
        // Whitelist fields: an entry is authored by whoever holds the room
        // key, so it must never override where it lands (server/channel)
        // or dress itself up as a system line.
        const gameRef = entry.game ? normalizeGameRef(entry.game) : null;
        const message = {
          server: record.id,
          channel,
          sender: String(entry.sender ?? ''),
          ts: Number(entry.ts) || 0,
          ...(entry.file
            ? { file: entry.file }
            : gameRef
              ? { game: gameRef }
              : { text: String(entry.text ?? '') }),
          fromHistory: true,
        };
        if (message.ts < cutoff || seen.has(messageFingerprint(message))) continue;
        seen.add(messageFingerprint(message));
        await this.db.msgAdd(message);
        added += 1;
      }
      record.hcursor = { ...(record.hcursor ?? {}), [meta.hid]: maxSeq };
      if (added > 0) {
        restoredTotal += added;
        await this.addSystemMessage(
          record.id,
          `${added} earlier message${added === 1 ? '' : 's'} restored from encrypted history — sealed by the channel key, senders not individually verified`,
          channel
        );
      }
    }
    await this.db.serverPut(record);
    if (restoredTotal > 0) this.dispatch({ type: 'refreshMessages' });
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
    // Joiners have no scrollback: rebroadcast name + channels (and channel
    // settings, incl. history keys) so their placeholder record fills in.
    await this.sendContent(serverId, this.metaContent(record));
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.refreshRoles(serverId);
  }

  // === circle management (rename / remove / leave / delete) ===============

  /** Rename a circle. The new name rides the same meta envelope joiners
      already adopt, so every device picks it up. UI-gated to admins. */
  async renameServer(serverId, name) {
    const record = this.servers.get(serverId);
    const next = String(name ?? '').trim().slice(0, 60);
    if (!record || !next || next === record.name) return;
    record.name = next;
    await this.sendContent(serverId, this.metaContent(record));
    await this.addSystemMessage(serverId, `circle renamed to "${next}" by you`);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  /** Remove a member: the MLS commit re-keys the group so they can read and
      send nothing further (the real boundary), and the relay drops them from
      the ACL so they stop being listed and served. UI-gated to admins. */
  async removeMember(serverId, user) {
    const record = this.servers.get(serverId);
    if (!record || user === this.me) return;
    const { commit, epoch, members, state } = await this.crypto('removeMember', {
      group: serverId,
      name: user,
    });
    await this.persistState(state);
    const sent = await this.relay.request({
      t: 'send',
      group: serverId,
      epoch,
      payload: b64.enc(commit),
    });
    record.lastSeq = Math.max(record.lastSeq, sent.seq);
    record.members = members;
    record.epoch = epoch;
    if (record.roles?.[user]) {
      record.roles = { ...record.roles };
      delete record.roles[user];
    }
    // Revoke the server-side ACL too (best-effort; the MLS re-key already
    // locked them out cryptographically).
    await this.relay
      .request({ t: 'disallow', group: serverId, user })
      .catch((e) => console.warn(`disallow ${user}: ${e.message}`));
    await this.addSystemMessage(serverId, `${user} was removed from the circle by you (epoch ${epoch})`);
    // The epoch moved: any parked invite GroupInfo blob is now stale.
    await this.refreshInvites(record);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.scheduleBackup();
  }

  /** Leave a circle: forget it on this device and drop ourselves from the
      relay ACL. The group's MLS roster still lists us until an admin re-keys
      — a clean self-removal commit isn't ours to make — but nothing about
      the circle remains here. Any member may leave. */
  async leaveServer(serverId) {
    if (!this.servers.get(serverId)) return;
    await this.relay
      .request({ t: 'disallow', group: serverId, user: this.me })
      .catch((e) => console.warn(`leave ${serverId}: ${e.message}`));
    await this.forgetServerLocal(serverId);
  }

  /** Delete a circle: re-key every other member out (each removal commit is
      how their device learns to forget the circle), purge the relay's copy,
      then forget it here. UI-gated to admins. */
  async deleteServer(serverId) {
    const record = this.servers.get(serverId);
    if (!record) return;
    for (const user of (record.members ?? []).filter((m) => m !== this.me)) {
      try {
        const { commit, epoch, members, state } = await this.crypto('removeMember', {
          group: serverId,
          name: user,
        });
        await this.persistState(state);
        const sent = await this.relay.request({
          t: 'send',
          group: serverId,
          epoch,
          payload: b64.enc(commit),
        });
        record.lastSeq = Math.max(record.lastSeq, sent.seq);
        record.members = members;
        record.epoch = epoch;
      } catch (e) {
        console.warn(`delete: removing ${user}: ${e.message}`);
      }
    }
    await this.relay
      .request({ t: 'delete_group', group: serverId })
      .catch((e) => console.warn(`delete_group ${serverId}: ${e.message}`));
    await this.forgetServerLocal(serverId);
  }

  /** Tear down every local trace of a circle: MLS keys, the record, its
      messages, any live call. Shared by leave, delete, and being kicked. */
  async forgetServerLocal(serverId) {
    const wasActiveCall = this.voice?.active?.server === serverId;
    this.servers.delete(serverId);
    try {
      const { state } = await this.crypto('forgetGroup', { group: serverId });
      await this.persistState(state);
    } catch (e) {
      // A restored (read-only) stub has no MLS group to forget — fine.
      console.warn(`forget group ${serverId}: ${e.message}`);
    }
    await this.db.serverDelete(serverId);
    await this.db.msgsDeleteServer(serverId);
    if (wasActiveCall) await this.voice.leave().catch(() => {});
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    // Re-park the backup without this circle so a restore won't resurrect it.
    this.scheduleBackup();
  }

  // === roles ==============================================================

  /** Advisory admin gate for admin-only envelopes (overview, chanset,
      channel create/rename/delete). MLS can't enforce roles; the relay's
      ACL is the source of truth, but our cache of it can lag a promotion —
      an admin's edit arriving just after they were promoted must not be
      silently dropped because this device still has them as "member".
      Fail open while the role is unknown; on a cache that disagrees,
      re-pull the ACL once and re-check before dropping. */
  async senderIsAdmin(record, sender) {
    const cached = record.roles?.[sender];
    if (!cached || cached === 'admin') return true;
    await this.refreshRoles(record.id);
    const fresh = record.roles?.[sender];
    return !fresh || fresh === 'admin';
  }

  /** Pull the relay's roster roles (admin/member) into the local record.
      Best-effort: the ACL is advisory, so failures only affect badges. */
  async refreshRoles(serverId) {
    const record = this.servers.get(serverId);
    if (!record) return;
    try {
      const reply = await this.relay.request({ t: 'members', group: serverId });
      record.roles = Object.fromEntries(reply.members.map((m) => [m.user, m.role]));
      // A restored record has no MLS view of the roster; the relay's ACL
      // is the best available approximation until a re-add arrives.
      if (record.restored) record.members = reply.members.map((m) => m.user);
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

  // === circles backup =====================================================
  //
  // What survives a device change is what the vault carries: the identity.
  // MLS ratchets deliberately don't. This backup parks the *shape* of your
  // circles (names, channels, settings) plus each channel's history key —
  // encrypted under a key derived from the identity bytes, so any device
  // that can sign in can open it and the relay never can. Combined with
  // the history logs, signing in on a new device brings your messages
  // back without touching forward secrecy of no-history channels.

  /** Debounced: many mutations arrive in bursts (joins, meta floods). */
  scheduleBackup() {
    clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      this.uploadBackup().catch((e) => console.warn(`backup upload: ${e.message}`));
    }, 3000);
  }

  async uploadBackup() {
    if (!this.relay?.ready) return;
    const identity = this.identityBytes();
    // Restored stubs are included: their shape (and channel history keys)
    // came from the previous backup, and omitting them here would overwrite
    // that backup with one that has forgotten those circles entirely.
    const servers = [...this.servers.values()]
      .map((r) => ({
        id: r.id,
        name: r.name,
        channels: r.channels,
        voiceChannels: r.voiceChannels ?? ['lounge'],
        chanMeta: r.chanMeta ?? {},
        overview: r.overview ?? null,
        notices: r.notices ?? [],
      }));
    // An empty list must only overwrite a parked backup once this device has
    // actually held circles — so leaving/deleting your last one clears the
    // ghost — never during boot before circles have loaded (which would wipe
    // a good backup) or for an account that simply has none yet.
    if (!servers.length && !this.everHadCircles) return;
    if (servers.length) this.everHadCircles = true;
    const payload = await sealBackup(identity, { v: 1, servers });
    await this.relay.request({ t: 'backup_set', payload });
  }

  /** Fresh sign-in path: no local circles, but maybe a parked backup.
      Restored circles are readable (saved history decrypts with the
      backed-up channel keys) but read-only until someone re-adds this
      device — the MLS ratchets are gone by design. */
  async restoreFromBackup() {
    const reply = await this.relay.request({ t: 'backup_get' });
    if (!reply.payload) return;
    const backup = await openBackup(this.identityBytes(), reply.payload);
    if (backup.v !== 1) throw new Error('unsupported backup version');
    for (const s of backup.servers ?? []) {
      if (this.servers.has(s.id)) continue;
      const record = {
        id: s.id,
        name: s.name,
        channels: s.channels?.length ? s.channels : ['general'],
        voiceChannels: s.voiceChannels ?? ['lounge'],
        chanMeta: s.chanMeta ?? {},
        overview: normalizeOverview(s.overview),
        notices: (Array.isArray(s.notices) ? s.notices : [])
          .map((n) => normalizeNotice(n, n?.author))
          .filter(Boolean),
        members: [],
        epoch: 0,
        lastSeq: 0,
        joinedAt: Date.now(),
        restored: true,
      };
      this.servers.set(s.id, record);
      await this.db.serverPut(record);
      await this.addSystemMessage(
        s.id,
        `restored from your encrypted backup — saved history is readable, but ask to be re-added before you can send`
      );
      this.refreshRoles(s.id);
      await this.backfillHistory(record).catch((e) => console.warn(`history: ${e.message}`));
    }
    if (backup.servers?.length) {
      this.dispatch({ type: 'servers', servers: this.snapshotServers() });
      this.toast('circles restored from your encrypted backup');
    }
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
    // A constant salt (not a random one): PRF output is already unique per
    // credential, and pinning the salt lets usernameless sign-in derive this
    // same wrap key with no prior account lookup. Still stored on the vault so
    // the handle-first path keeps reading it from /params unchanged.
    const prfSalt = VAULT_PRF_SALT;
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

  /** Pre-boot probe: how (if at all) a handle signs in on this relay, so
      the gate can offer only the method that will actually work.
      Returns 'passkey' | 'password', or null when there's no server vault
      for that handle (identity was never secured for cross-device use). */
  async accountKind(user) {
    try {
      const params = await this.accountFetch(`/account/${encodeURIComponent(user)}/params`);
      return params.kind ?? null;
    } catch (e) {
      if (/no such account|no vault|404/i.test(e.message)) return null;
      throw e;
    }
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
    if (!navigator.credentials?.get) throw new Error('this browser has no passkey support');
    const params = await this.accountFetch(`/account/${encodeURIComponent(user)}/params`);
    if (params.kind !== 'passkey') throw new Error(`this account uses ${params.kind} sign-in, not a passkey`);
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

  /** Usernameless sign-in: no handle. The authenticator offers its resident
      passkeys, the relay resolves which account signed, and the vault comes
      back keyed by nothing but the credential. Works only for passkeys sealed
      under the constant PRF salt (i.e. registered by this version onward). */
  async signInWithDiscoverablePasskey() {
    if (!navigator.credentials?.get) throw new Error('this browser has no passkey support');
    const { session, options } = await this.accountFetch('/passkey/discover/challenge', {});
    const assertion = await navigator.credentials.get({
      publicKey: parseRequestOptions(options, VAULT_PRF_SALT),
    });
    const secret = prfSecret(assertion);
    if (!secret) throw new Error('this passkey has no PRF secret — sign in with your handle instead');
    const reply = await this.accountFetch('/passkey/discover/login', {
      session,
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
    const ts = Date.now();
    await this.sendContent(serverId, { k: 'file', ch: channel, file, ts });
    const message = { server: serverId, channel, sender: this.me, file, ts };
    await this.storeMessage(message);
    this.appendHistory(serverId, channel, message);
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
      // Notification clicks route here: land on the circle the push was
      // about instead of wherever the app happened to be.
      if (!this.swMessageBound) {
        this.swMessageBound = true;
        navigator.serviceWorker.addEventListener('message', ({ data }) => {
          if (data?.type === 'open-group' && this.servers.has(data.group)) {
            this.dispatch({ type: 'select', server: data.group, channel: null });
          }
        });
      }
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
    const appKey = b64url.dec(info.pubkey);
    const subscribe = () =>
      this.swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    let subscription;
    try {
      subscription = await subscribe();
    } catch (e) {
      // The browser refuses to create a subscription when one already exists
      // with a *different* applicationServerKey — which is exactly what
      // happens after the relay's VAPID key rotates (e.g. an early ephemeral
      // key, or a redeploy). The stale subscription is dead: the push service
      // rejects everything signed with the new key. Drop it and re-subscribe
      // so this device heals itself instead of staying silently broken.
      const existing = await this.swReg.pushManager.getSubscription();
      if (!existing) throw e;
      await existing.unsubscribe().catch(() => {});
      subscription = await subscribe();
    }
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
    // Already a live member -> nothing to do. A restored (read-only) stub
    // is NOT membership — the invite link is exactly how it comes back to
    // life, so fall through and external-commit.
    if (this.servers.get(reply.group) && !this.servers.get(reply.group).restored) return;
    const groupInfo = await decryptBlob(b64url.dec(key), b64.dec(reply.payload));
    const { group, commit, epoch, members, state } = await this.crypto('joinByExternalCommit', {
      groupInfo,
    });
    await this.persistState(state);
    // Publishing our external commit is what makes the join real for
    // everyone else; its seq is where our log begins.
    const sent = await this.relay.request({ t: 'send', group, epoch, payload: b64.enc(commit) });
    // Merge over a restored stub the same way onWelcome does.
    const prior = this.servers.get(group);
    const record = {
      id: group,
      name: prior?.name ?? group, // placeholder until a member rebroadcasts meta
      channels: prior?.channels ?? ['general'],
      voiceChannels: prior?.voiceChannels,
      chanMeta: prior?.chanMeta ?? {},
      overview: prior?.overview,
      notices: prior?.notices ?? [],
      seen: prior?.seen ?? {},
      hcursor: prior?.hcursor ?? {},
      verified: prior?.verified,
      members,
      epoch,
      lastSeq: sent.seq,
      joinedAt: prior?.joinedAt ?? Date.now(),
      // Same as onWelcome: the log resumes past this join, so let the first
      // meta rebroadcast reconcile a possibly-stale shape rather than union.
      pendingMetaSync: true,
    };
    this.servers.set(group, record);
    await this.db.serverPut(record);
    await this.addSystemMessage(
      group,
      `you joined via invite link — only channels that keep history have a past here`
    );
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.relay.request({ t: 'subscribe', group, after: sent.seq });
    this.refreshRoles(group);
    this.backfillHistory(record).catch((e) => console.warn(`history: ${e.message}`));
    this.scheduleBackup();
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
    // Everything is copied — overview and chanMeta included, since some
    // receive paths patch them in place and a shared reference would let
    // memoized components miss the change.
    return [...this.servers.values()]
      .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
      .map((r) => ({
        ...r,
        channels: [...r.channels],
        voiceChannels: [...(r.voiceChannels ?? ['lounge'])],
        members: [...r.members],
        roles: { ...(r.roles ?? {}) },
        notices: [...(r.notices ?? [])],
        rsvps: { ...(r.rsvps ?? {}) },
        overview: r.overview ? JSON.parse(JSON.stringify(r.overview)) : r.overview,
        chanMeta: JSON.parse(JSON.stringify(r.chanMeta ?? {})),
        // Live only: which game each member says they're in right now.
        presence: { ...(this.livePresence?.get(r.id) ?? {}) },
        // Live only: open rallies — who wants to play what right now.
        wants: { ...(this.liveWants?.get(r.id) ?? {}) },
      }));
  }

  async loadMessages(serverId, channel) {
    // Auto-delete is enforced at read time (and on setting changes) —
    // there is no background process in a browser tab to rely on.
    const record = this.servers.get(serverId);
    if (record) await this.applyRetention(record, channel);
    const messages = await this.db.msgsFor(serverId, channel);
    // Backfilled history lands after live messages in insertion order;
    // present by time.
    return messages.sort((a, b) => a.ts - b.ts);
  }

  toast(text) {
    this.dispatch({ type: 'toast', text });
  }
}

/** A message's timestamp is the sender's clock, carried on the wire, so every
    device orders and dedupes it identically and it matches the kept-history
    copy. Older senders (or a hostile payload) may omit it or send garbage; a
    non-finite/non-positive value falls back to this device's own clock. The
    history log already trusts the sender's ts, so this only makes live
    receipt consistent with it. */
export function messageTs(claimed, now = Date.now()) {
  const t = Number(claimed);
  return Number.isFinite(t) && t > 0 ? t : now;
}

/** A call's conversation thread lives under `voice:<room>` — real E2EE chat
    storage, but stage-scoped: it must never surface as a text room. */
export function isCallChat(channel) {
  return typeof channel === 'string' && channel.startsWith('voice:');
}

export function callChatChannel(room) {
  return `voice:${room}`;
}

/** Human-readable summary of a channel's settings for system messages. */
function describeChanMeta(meta = {}) {
  const parts = [];
  parts.push(meta.hid ? 'history: kept for joiners' : 'history: this-device-only');
  if (meta.retention) parts.push(`auto-delete: ${describeRetention(meta.retention)}`);
  if (meta.topic) parts.push(`topic: “${meta.topic}”`);
  return ` (${parts.join(', ')})`;
}

export function describeRetention(seconds) {
  if (!seconds) return 'off';
  if (seconds % 86400 === 0) {
    const d = seconds / 86400;
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${seconds}s`;
}
