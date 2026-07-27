// Orchestration: worker (crypto) <-> relay (transport) <-> IndexedDB
// (persistence) <-> React (render). The controller owns the canonical
// in-memory server records; React state is a projection of them.
//
// Message content is a JSON envelope INSIDE the MLS plaintext, so channel
// structure and server names are invisible to the relay:
//   {k:'chat', ch, text, reply?}  — a chat message in channel `ch`. `reply`
//                                   (optional) is a quoted snapshot
//                                   {sender, ts, text} of the message being
//                                   answered — denormalized on purpose: a
//                                   joiner has no scrollback, so a bare
//                                   pointer would dangle. A `ch` of the form
//                                   `voice:<room>` is a call's conversation
//                                   thread: same crypto, same storage, but it
//                                   belongs to the voice room's stage, never
//                                   the rooms sidebar
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
//   {k:'edit', ch, to:{ts}, text} — edit one of MY OWN lines. The patch keys
//                                   on (sender, ts) and the sender is the
//                                   authenticated MLS sender, so an edit can
//                                   only ever touch its author's message —
//                                   no separate ACL needed. Not replayed into
//                                   kept history: the sealed original stands
//                                   (stated in the UI), same as reactions
//   {k:'del', ch, to:{ts}}        — tombstone one of MY OWN lines: same
//                                   (sender, ts) self-scoping as edit. A
//                                   tombstone for live/future readers, not a
//                                   redaction — devices that already saw it,
//                                   and the kept-history copy, keep the text
//   {k:'type', ch}                — ephemeral typing signal: the sender is
//                                   composing in channel `ch` right now.
//                                   Same discipline as presence — fanned out
//                                   over MLS, kept only in memory, expired by
//                                   readers (~6s); never persisted, never
//                                   rebroadcast, never push-woken
//   {k:'rsvp', at, going}          — answer to the hub's next-event card,
//                                   keyed to the event's timestamp so stale
//                                   answers die with the old event
//   {k:'game', ch, game}          — "I opened this game from the shelf":
//                                   {id,name,kind} renders as a join card.
//                                   The card resolves against the circle's
//                                   own registry — the payload itself never
//                                   supplies a URL to launch
import { b64, Relay } from './relay.js';
import { applyVerified, applyMismatch, retireMismatch } from './trust.js';
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
  b64url,
  buildInviteUrl,
  decryptBlob,
  encryptBlob,
  generateFragmentKey,
  generateInviteId,
} from './invite.js';
import { sealIdentity } from './link.js';
import { AccountService } from './account.js';
import {
  mergeNotices,
  normalizeNotice,
  normalizeOverview,
  reconcileMeta,
  upsertNotice,
} from './overview.js';
import { freshPresence, normalizeGameRef, normalizePresence, normalizeWant } from './games.js';
import { MIN_QUERY, rankHits } from './search.js';
import { ForkWatch, forkMessage } from './fork.js';
import {
  adminRequirement,
  applyEnvelope,
  DELETED_MAX,
  callChatChannel,
  clearChannelDeleted,
  clearVoiceDeleted,
  describeChanMeta,
  describeRetention,
  ensureChannel,
  isCallChat,
  markChannelDeleted,
  markVoiceDeleted,
  messageTs,
  normalizeReply,
  parseEnvelope,
} from './envelope.js';

// Re-exported so the components and tests that already import these from
// here keep working; they now live beside the reducer that uses them.
export { callChatChannel, describeRetention, isCallChat, messageTs } from './envelope.js';

/** How many superseded kept-history keys a channel carries for reading.
    Each removal adds one; the cap stops the metadata growing without bound
    in a circle with heavy churn, at the cost of the oldest entries becoming
    unreadable — which auto-delete would have reclaimed anyway. */
const MAX_ARCHIVED_HISTORY_KEYS = 8;
const KP_TOPUP = 2; // fresh KeyPackages published per connect
const INVITE_TTL_SECONDS = 7 * 24 * 3600;
// Typing signals: readers treat one as stale ~6s after it was sent, and a
// composing client re-sends every ~3s while the draft grows, so the "is
// typing" line stays lit without a heartbeat on every keystroke. Both live
// only in memory — a typing signal is never logged or persisted.
const TYPING_TTL_MS = 6000;
const TYPING_HEARTBEAT_MS = 3000;
/** True while `entry` (a {ts} typing signal) is still within its live
    window. Reader-side expiry, exactly like presence/rally freshness. */
export function freshTyping(entry, now = Date.now()) {
  return !!entry && now - entry.ts < TYPING_TTL_MS;
}
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
    // §1.1's fourth part: tell a permanently forked circle apart from the
    // ordinary undecryptable blob. In memory on purpose — see fork.js.
    this.forks = new ForkWatch();
    /** Circles we have already warned about, so the notice appears once per
        session rather than on every message from the other branch. */
    this.forkWarned = new Set();
    // Vaults, passkeys and sign-in (plan §2.2). `request` is a function
    // rather than the connection because the socket does not exist yet.
    this.accounts = new AccountService({
      request: (msg) => this.relay.request(msg),
      crypto,
      db,
      dispatch,
      httpBase: () => this.httpBase(),
      identityBytes: () => this.identityBytes(),
    });
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
        // `serverPut` persists whatever is on the record, so a fork verdict
        // written during the last session would come back with it. Drop it
        // and re-earn it from live traffic: a stale "this circle is broken"
        // surviving a successful rejoin is worse than taking a few messages
        // to say it again. See fork.js.
        delete record.outOfSync;
        this.servers.set(record.id, record);
      }
      this.dispatch({ type: 'booted', me: this.me, servers: this.snapshotServers() });
      // Every boot, not just onboarding: a grant can be revoked, and a site
      // refused once may qualify later once the user has engaged with it.
      this.requestPersistentStorage();
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
    await this.requestPersistentStorage();
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
      onAnnounce: (text) => this.dispatch({ type: 'announce', text }),
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
      } else if (content.k === 'type') {
        this.setLiveTyping(msg.group, event.sender, content.ch);
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
      verifiedSn: prior?.verifiedSn,
      mismatched: prior?.mismatched,
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

    // The ratchet snapshot is deliberately NOT written here. These used to
    // be three separate IndexedDB transactions in the order ratchet →
    // message → cursor, so a crash in the middle left the ratchet advanced
    // past a message whose seq was never recorded: the relay replayed it,
    // decryption failed against the moved-on ratchet, and the message was
    // dropped as "undecryptable" — silent, permanent loss.
    //
    // Writing the ratchet LAST inverts which side a crash lands on. A stale
    // snapshot with the message and cursor already durable is recoverable:
    // MLS tolerates the skipped generation, so the next message still
    // decrypts. Order matters more than atomicity here.
    let ratchet = null;
    // Decryption and content handling get SEPARATE catches. They used to
    // share one, so an IndexedDB quota error, a JSON edge case, or a bug in
    // the reaction/edit handler all surfaced as "undecryptable blob seq N" —
    // a line whose own comment says it is expected. That is why storage
    // failures were invisible.
    let event = null;
    try {
      const decrypted = await this.crypto('receive', { bytes: b64.dec(msg.payload) });
      event = decrypted.event;
      ratchet = decrypted.state;
      // Proof the ratchet is still shared with this sender, which is what
      // clears any fork suspicion against them.
      this.forks.succeeded(msg.group, msg.sender);
    } catch (e) {
      // Genuinely expected: our own commits replayed by catch-up, and blobs
      // from an epoch this device never held. `why` separates those from the
      // one shape that means this device is on a branch of its own — see
      // fork.js — so the log says which it was instead of lumping them
      // together under a warning whose own comment calls it expected.
      const why = this.forks.failed(msg.group, {
        sender: msg.sender,
        epoch: msg.epoch,
        me: this.me,
        groupEpoch: record.epoch,
        restored: record.restored,
      });
      console.warn(`undecryptable blob seq ${msg.seq} in ${msg.group} (${why}): ${e.message}`);
      this.noteFork(record);
    }

    try {
      if (!event) {
        // nothing to apply
      } else if (event.kind === 'message') {
        await this.onContent(record, event.sender, event.text);
      } else if (event.kind === 'membershipChange') {
        // Were we the one dropped? A re-key that no longer lists us means we
        // were removed (kicked, or the circle is being deleted). Forget it
        // here and stop — the record is gone, so don't fall through to the
        // serverPut below, which would resurrect it.
        if (!event.members.includes(this.me)) {
          this.toast(`you were removed from "${record.name}"`);
          await this.forgetServerLocal(record.id);
          // Early return, but the ratchet still moved and covers every other
          // group in this snapshot — persist before leaving.
          await this.persistState(ratchet);
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
        // A membership change is when a key can enter or re-enter the group,
        // so re-check every badge against the key it was granted for.
        await this.revalidateVerified(record);
        // Every epoch change kills parked GroupInfo blobs; refresh ours.
        await this.refreshInvites(record);
        this.refreshRoles(record.id);
        // And nobody outside the group keeps a live voice leg.
        this.voice.membershipChanged(record.id, event.members);
      }
    } catch (e) {
      // A decrypted message we then failed to APPLY. Not expected, and not
      // the same as an undecryptable blob: the likely causes are storage
      // (quota, eviction) or a defect in a content handler. Surface it.
      console.error(`failed to apply seq ${msg.seq} in ${msg.group}: ${e.message}`);
      this.toast(`a message could not be saved: ${e.message}`);
    }
    // Cursor first, ratchet second — see the note above.
    await this.db.serverPut(record);
    await this.persistState(ratchet);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /**
   * One authenticated envelope, applied.
   *
   * Split in two on purpose (plan §2.2). `applyEnvelope` decides what the
   * envelope *means* and returns effect descriptors; `runEffects` is the only
   * part that touches the database, the voice manager or the UI. The rules
   * that used to need a relay, a worker and a database to exercise are now
   * reachable from a plain object — see `test/envelope.test.mjs`.
   */
  async onContent(record, sender, raw) {
    const content = parseEnvelope(raw);

    // The admin answer is resolved here rather than inside the reducer:
    // `senderIsAdmin` can consult the relay's ACL, and an async reducer is
    // not a reducer. Resolved only for the kinds that need it, so ordinary
    // chat traffic does not pay for a check it never uses.
    const need = adminRequirement(content);
    const isAdmin = need ? await this.senderIsAdmin(record, sender, need) : null;

    const { effects } = applyEnvelope(record, sender, content, {
      isAdmin,
      inCall: this.voice?.active
        ? { server: this.voice.active.server, channel: this.voice.active.channel }
        : null,
    });
    await this.runEffects(record, effects);
  }

  /** Carry out what `applyEnvelope` decided, in order. The order matters:
      a rename must move the stored rows before the system message that
      announces it, and the backup is rescheduled last. */
  async runEffects(record, effects) {
    for (const e of effects) {
      switch (e.t) {
        case 'storeMessage':
          await this.storeMessage(e.message);
          break;
        case 'systemMessage':
          await this.addSystemMessage(e.server, e.text, e.channel);
          break;
        case 'reaction':
          await this.applyReaction(e.server, e.channel, e.target, e.emo, e.op, e.by);
          break;
        case 'editMessage':
          await this.db.msgPatch(e.server, e.channel, e.sender, e.ts, (m) =>
            m.deleted ? m : { ...m, text: e.text, edited: true }
          );
          break;
        case 'deleteMessage':
          // Strip the body to a tombstone; reactions go with it.
          await this.db.msgPatch(e.server, e.channel, e.sender, e.ts, (m) => ({
            sender: m.sender,
            server: m.server,
            channel: m.channel,
            ts: m.ts,
            deleted: true,
          }));
          break;
        case 'renameMessages':
          await this.db.msgsRename(e.server, e.from, e.to);
          break;
        case 'deleteMessages':
          await this.db.msgsDelete(e.server, e.channel);
          break;
        case 'applyRetention':
          await this.applyRetention(record, e.channel);
          break;
        case 'refreshMessages':
          this.dispatch({ type: 'refreshMessages' });
          break;
        case 'refreshRoles':
          this.refreshRoles(e.server);
          break;
        case 'clearTyping':
          this.clearTyping(e.server, e.sender);
          break;
        case 'presence':
          this.setLivePresence(e.server, e.sender, e.value);
          break;
        case 'want':
          this.setLiveWant(e.server, e.sender, e.value);
          break;
        case 'typing':
          this.setLiveTyping(e.server, e.sender, e.channel);
          break;
        case 'leaveVoice':
          await this.voice.leave();
          break;
        case 'backfillHistory':
          // Fire-and-forget by design: a history fetch must never hold up
          // applying the rest of the log.
          this.backfillHistory(record).catch((err) => console.warn(`history: ${err.message}`));
          break;
        case 'backup':
          this.scheduleBackup();
          break;
        default:
          // A descriptor with no interpreter is a bug in this file, not bad
          // input — the reducer is the only thing that produces them.
          console.warn(`unhandled effect: ${e.t}`);
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
  // Kept as a re-export rather than a second literal: the bound is enforced
  // in envelope.js, and two copies of a number is how they drift apart.
  static DELETED_MAX = DELETED_MAX;

  /** Surface an unknown channel for an incoming message, unless it is a call
      thread or a room we have seen deleted. */
  // Thin delegates: the implementations moved to envelope.js so the reducer
  // can use them without reaching into a Controller instance. The user-action
  // methods further down still call them through `this`.
  ensureChannel(record, ch) {
    ensureChannel(record, ch);
  }

  markChannelDeleted(record, ch) {
    markChannelDeleted(record, ch);
  }

  clearChannelDeleted(record, ch) {
    clearChannelDeleted(record, ch);
  }

  /** Voice rooms get the same tombstone treatment as text channels, so the
      meta union (now rebroadcast on every connect to heal divergence) can't
      resurrect a room this device has seen deleted. */
  markVoiceDeleted(record, ch) {
    markVoiceDeleted(record, ch);
  }

  clearVoiceDeleted(record, ch) {
    clearVoiceDeleted(record, ch);
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
    // Message ts is the *sender's* clock. Taking max(now, atLeastTs) alone
    // handled a FAST sender clock but broke the slow one: stamping `now`
    // meant every later message from a device minutes behind us arrived
    // already "seen" and never counted unread. Anchor on the newest message
    // this channel actually holds, falling back to now for an empty room.
    const newest = (await this.db.msgsFor(record.id, channel))
      .filter((m) => !m.system)
      .reduce((max, m) => Math.max(max, Number(m.ts) || 0), 0);
    const anchor = newest || Date.now();
    record.seen = { ...(record.seen ?? {}), [channel]: Math.max(anchor, atLeastTs) };
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
      const unread = countUnread(msgs, seenFloor(record, channel), this.me);
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

  /** Unread totals per circle, for the rail. Without this the rail is pure
      identity: nothing on screen says a circle you are not looking at has
      moved, so anyone in more than two circles has to click through them to
      find out — which is what made the multi-circle model unusable.

      One pass over every circle rather than one call per tile: the read is
      device-local IndexedDB, but it is O(channels) transactions and the
      callers refresh it on every arriving message. */
  async circleUnreads() {
    const out = {};
    for (const record of this.servers.values()) {
      let unread = 0;
      for (const channel of record.channels) {
        unread += countUnread(await this.db.msgsFor(record.id, channel), seenFloor(record, channel), this.me);
      }
      out[record.id] = unread;
    }
    return out;
  }

  /** Search every message this device holds, across every circle.
      Necessarily device-local: the relay stores ciphertext and cannot index
      it, so the answer is exactly what this device has decrypted and kept —
      a phone that joined last week will not find last year. That limit is
      stated in the UI rather than hidden.

      A linear scan, deliberately: an inverted index would have to live in
      the same IndexedDB as the plaintext it indexes, buying speed at the
      cost of a second copy of every message to keep consistent and to purge
      on retention and on leave. At the scale this app is for, the scan is
      the cheaper correctness story. */
  async searchMessages(query, opts = {}) {
    if (String(query ?? '').trim().length < MIN_QUERY) return { hits: [], truncated: false };
    const rows = [];
    for (const record of this.servers.values()) {
      for (const channel of record.channels) {
        for (const message of await this.db.msgsFor(record.id, channel)) {
          rows.push({ server: record.id, channel, message });
        }
      }
    }
    const { hits, truncated } = rankHits(rows, query, opts);
    // The palette shows circle and room names, not ids.
    return {
      hits: hits.map((h) => ({ ...h, serverName: this.servers.get(h.server)?.name ?? h.server })),
      truncated,
    };
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

  async sendChat(serverId, channel, text, reply) {
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
    const quote = normalizeReply(reply);
    await this.storeMessage({
      server: serverId,
      channel,
      sender: this.me,
      text,
      ts,
      pending: true,
      ...(quote ? { reply: quote } : {}),
    });
    // Sending a line means I've stopped composing — drop my own typing
    // signal so a peer's "is typing" clears the instant the message lands.
    await this.deliverChat(serverId, channel, text, ts, quote);
  }

  /** Network half of sendChat; also the retry path for a failed line. */
  async deliverChat(serverId, channel, text, ts, reply) {
    const quote = normalizeReply(reply);
    try {
      await this.sendContent(serverId, {
        k: 'chat',
        ch: channel,
        text,
        ts,
        ...(quote ? { reply: quote } : {}),
      });
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
    this.appendHistory(serverId, channel, {
      server: serverId,
      channel,
      sender: this.me,
      text,
      ts,
      ...(quote ? { reply: quote } : {}),
    });
  }

  /** Retry a message that failed to send (still stored locally). */
  async retryMessage(serverId, channel, message) {
    await this.db.msgPatch(serverId, channel, this.me, message.ts, (m) => ({
      ...m,
      pending: true,
      failed: false,
    }));
    this.dispatch({ type: 'refreshMessages' });
    await this.deliverChat(serverId, channel, message.text, message.ts, message.reply);
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

  /** Announce that I'm composing in `channel`. Ephemeral to the bone — same
      no-log fan-out as presence, never persisted, never push-woken (a typing
      blip must not wake a closed app). Throttled to one signal per heartbeat
      so a fast typist doesn't flood the group; the reader-side TTL keeps the
      indicator lit between beats and lets it fade on its own if I stop. */
  async typing(serverId, channel) {
    if (!this.servers.get(serverId)) return;
    if (!this._typingSentAt) this._typingSentAt = new Map();
    const key = `${serverId}/${channel}`;
    const now = Date.now();
    const last = this._typingSentAt.get(key) ?? 0;
    if (now - last < TYPING_HEARTBEAT_MS) return;
    this._typingSentAt.set(key, now);
    // Best-effort: a dropped typing signal is a non-event, so never surface
    // it — the draft the user is writing matters, this hint doesn't.
    await this.sendEphemeral(serverId, { k: 'type', ch: channel }).catch(() => {});
  }

  setLiveTyping(serverId, handle, channel) {
    if (handle === this.me) return; // never show my own typing back to me
    if (!this.liveTyping) this.liveTyping = new Map();
    const map = this.liveTyping.get(serverId) ?? {};
    map[handle] = { channel: String(channel ?? ''), ts: Date.now() };
    this.liveTyping.set(serverId, map);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Drop a member's typing signal outright — called when a line of theirs
      lands (they've clearly stopped) so the indicator clears without waiting
      out the TTL. */
  clearTyping(serverId, handle) {
    const map = this.liveTyping?.get(serverId);
    if (!map || !(handle in map)) return;
    delete map[handle];
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

  /** Edit one of my own lines. Optimistic: patch locally, then fan out an
      `edit` envelope keyed on the message ts. Only text messages are
      editable (a file/game card has nothing to retype). Kept history is
      left alone — the sealed original stands, and the UI says so. */
  async editMessage(serverId, channel, message, text) {
    const record = this.servers.get(serverId);
    if (!record || message.sender !== this.me) return;
    const next = String(text ?? '').trim();
    if (!next || next === message.text) return;
    await this.db.msgPatch(serverId, channel, this.me, message.ts, (m) =>
      m.deleted ? m : { ...m, text: next, edited: true }
    );
    this.dispatch({ type: 'refreshMessages' });
    await this.sendContent(serverId, { k: 'edit', ch: channel, to: { ts: message.ts }, text: next });
  }

  /** Delete one of my own lines — a tombstone, not a redaction. Patches the
      local copy to a stub and fans out a `del`; devices that already have
      the line, and the kept-history copy, are untouched (the UI is explicit
      that a delete can't reach back). */
  async deleteMessage(serverId, channel, message) {
    const record = this.servers.get(serverId);
    if (!record || message.sender !== this.me) return;
    await this.db.msgPatch(serverId, channel, this.me, message.ts, (m) => ({
      sender: m.sender,
      server: m.server,
      channel: m.channel,
      ts: m.ts,
      deleted: true,
    }));
    this.dispatch({ type: 'refreshMessages' });
    await this.sendContent(serverId, { k: 'del', ch: channel, to: { ts: message.ts } });
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
      // A reply's quote rides into kept history too, so a joiner reading the
      // channel back sees what each answer was answering.
      ...(message.reply ? { reply: message.reply } : {}),
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
      // Also key by (sender, ts): a line that was edited or deleted locally
      // has a different body than its sealed original, so a content-only
      // dedup would re-add that original from history — resurrecting a
      // deleted line, or duplicating an edited one. The identity key blocks
      // both; the edited/tombstoned local copy is the one that stands.
      const known = new Set(existing.filter((m) => !m.system).map((m) => `${m.sender}:${m.ts}`));
      const cutoff = meta.retention ? Date.now() - meta.retention * 1000 : 0;
      let added = 0;
      let maxSeq = cursor;
      for (const e of reply.entries) {
        maxSeq = Math.max(maxSeq, e.seq);
        let entry;
        // Current key first, then keys superseded by a removal — entries
        // parked before a rotation are still legitimately readable.
        for (const key of [meta.hkey, ...(meta.hkeys ?? [])]) {
          try {
            entry = await openHistoryEntry(key, e.payload);
            break;
          } catch {
            /* try the next key */
          }
        }
        if (!entry) continue; // no key opens it — damaged, or rotated past the cap
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
          ...(normalizeReply(entry.reply) ? { reply: normalizeReply(entry.reply) } : {}),
          fromHistory: true,
        };
        const id = `${message.sender}:${message.ts}`;
        if (message.ts < cutoff || seen.has(messageFingerprint(message)) || known.has(id)) continue;
        seen.add(messageFingerprint(message));
        known.add(id);
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
    // The relay serves both halves, so make it commit to a consistent story:
    // the KeyPackage's credential must name `user` and carry the signature
    // key pinned for that handle. Without this the relay can hand back a
    // KeyPackage it minted itself and join the group as "user". Refuse
    // outright if the relay declines to state a key — an add is not urgent
    // enough to do blind.
    if (!reply.pubkey) {
      throw new Error(
        `the relay did not provide an identity key for ${user}; refusing to add them unverified`
      );
    }
    const { commit, welcome, epoch, state } = await this.crypto('addMember', {
      group: serverId,
      keyPackage: b64.dec(reply.payload),
      expectIdentity: user,
      expectKey: b64.dec(reply.pubkey),
    });
    await this.persistState(state);
    const sent = await this.publishCommit(record, epoch, commit);
    const { members } = await this.crypto('mergeStagedCommit', { group: serverId });
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

  /** Publish a staged commit and let the relay's ordered log decide whether
      it wins its epoch.

      Commits used to be merged locally the moment they were built, before
      the relay had seen them. Two admins acting in the same second each
      merged their own commit, so each held a different epoch N+1 and could
      never decrypt the other again — the group forked permanently, silently,
      with the failures swallowed as "undecryptable blob".

      Now the commit is staged; the relay compare-and-swaps on the epoch and
      accepts exactly one. On acceptance the caller merges. On `EpochConflict`
      we drop the staged commit and stay where we were, so the commit that did
      win arrives over the normal subscription and is processed like anyone
      else's. The caller's operation is not applied — it is reported as
      retryable, because re-deriving intent (which member, which role) against
      the new epoch is the caller's business, not this function's. */
  async publishCommit(record, epoch, commit) {
    try {
      return await this.relay.request({
        t: 'send',
        group: record.id,
        epoch,
        payload: b64.enc(commit),
        commit: true,
      });
    } catch (e) {
      const conflict = /epoch conflict/i.test(e.message ?? '');
      try {
        // Persist the rolled-back MLS state too, so a reload cannot
        // resurrect the commit we just abandoned.
        const { state } = await this.crypto('discardStagedCommit', { group: record.id });
        await this.persistState(state);
      } catch (inner) {
        // Staging state is now ambiguous; say so rather than pretending.
        console.error(`could not discard the staged commit for ${record.id}: ${inner.message}`);
        throw e;
      }
      throw new Error(
        conflict
          ? 'someone else changed this circle at the same moment — nothing was applied, try again'
          : e.message
      );
    }
  }

  /** Mint a fresh kept-history key for every channel that has one, keeping
      the old keys for reading.

      Removing someone re-keys MLS, so they can decrypt no further *messages*.
      The per-channel history key was a separate story: it was minted once
      when history was switched on and never rotated, so a removed member
      kept a valid key for that channel's future entries too. Only the
      relay's ACL stood in the way, and the ACL is the deliberately weak
      boundary — cached ciphertext or a hostile relay defeated it.

      Old keys are archived rather than discarded: the removed member was
      present for those entries anyway, so destroying them would punish the
      members who stayed without denying the leaver anything. Rotation is
      about the future, which is exactly what post-compromise security means.
      Returns the channels that rotated. */
  rotateHistoryKeys(record) {
    const rotated = [];
    for (const [channel, meta] of Object.entries(record.chanMeta ?? {})) {
      if (!meta?.hid || !meta?.hkey) continue;
      const archive = [meta.hkey, ...(meta.hkeys ?? [])].slice(0, MAX_ARCHIVED_HISTORY_KEYS);
      record.chanMeta = {
        ...record.chanMeta,
        [channel]: { ...meta, hkey: generateHistoryKey(), hkeys: archive },
      };
      rotated.push(channel);
    }
    return rotated;
  }

  /** Kill every invite link parked for this circle.

      An invite is a bearer token: `redeem_invite` grants relay membership to
      whoever presents the id, with no check against who was removed. Worse,
      removal *refreshes* the parked blob to the new epoch, so a link the
      removed member still holds keeps working — they can walk straight back
      in. Any link in circulation has to die with them.

      This also invalidates links held by people who were legitimately about
      to join; there is no way to tell the two apart, so it takes the safe
      side and says so out loud. */
  async revokeAllInvites(record) {
    const invites = record.invites ?? [];
    if (!invites.length) return 0;
    let revoked = 0;
    for (const invite of invites) {
      try {
        await this.relay.request({ t: 'revoke_invite', invite: invite.id });
        revoked += 1;
      } catch (e) {
        console.warn(`revoke invite ${invite.id}: ${e.message}`);
      }
    }
    record.invites = [];
    return revoked;
  }

  /** Remove a member: the MLS commit re-keys the group so they can read and
      send nothing further (the real boundary), and the relay drops them from
      the ACL so they stop being listed and served. UI-gated to admins. */
  async removeMember(serverId, user) {
    const record = this.servers.get(serverId);
    if (!record || user === this.me) return;
    const { commit, epoch, state } = await this.crypto('removeMember', {
      group: serverId,
      name: user,
    });
    await this.persistState(state);
    const sent = await this.publishCommit(record, epoch, commit);
    const { members } = await this.crypto('mergeStagedCommit', { group: serverId });
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

    // Removal has to close every door, not just the MLS one.
    const rotated = this.rotateHistoryKeys(record);
    // Do NOT refreshInvites here: re-parking the blob under the same id is
    // what kept a removed member's link alive. Revoke instead.
    const revoked = await this.revokeAllInvites(record);
    if (rotated.length || revoked) {
      // Members need the new history keys; this is also what tells them the
      // rotation happened at all.
      await this.sendContent(serverId, this.metaContent(record));
    }
    if (rotated.length) {
      await this.addSystemMessage(
        serverId,
        `new history key for ${rotated.map((c) => `#${c}`).join(', ')} — ${user} cannot read anything kept from here on`
      );
    }
    if (revoked) {
      await this.addSystemMessage(
        serverId,
        `${revoked} invite link${revoked === 1 ? '' : 's'} revoked, in case ${user} still held one — share a new link to invite anyone else`
      );
    }
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
  /**
   * Surface a fork once we believe in it.
   *
   * Deliberately not a silent flag. A forked circle looks *fine* — messages
   * you send appear to go out, the member list is right, and the other
   * branch's messages simply never arrive. Without a notice the user
   * concludes the circle went quiet, which is the failure mode §1.1 called
   * "no detection and no recovery path".
   *
   * There is no repair to offer from here. Rejoining needs a current
   * GroupInfo, and the only one this client can get comes from an invite
   * blob — our own parked invites were re-encrypted from our own broken
   * branch. So the notice asks for a link from someone whose circle works,
   * which is the existing external-commit rejoin, and the record is marked
   * so the UI can keep saying so after the toast is gone.
   */
  noteFork(record) {
    const verdict = this.forks.verdict(record.id);
    const text = forkMessage(verdict, record.name ?? record.id);
    if (!text) return;
    // The record flag tracks the live verdict either way; only the toast is
    // once-per-session, because repeating it on every blob from the other
    // branch would be its own kind of broken.
    const wasOut = record.outOfSync === true;
    record.outOfSync = verdict.outOfSync;
    if (wasOut !== record.outOfSync) {
      this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    }
    const key = `${record.id}:${verdict.outOfSync ? 'self' : verdict.stranded.join(',')}`;
    if (this.forkWarned.has(key)) return;
    this.forkWarned.add(key);
    console.error(`fork detected in ${record.id}: ${text}`);
    this.toast(text);
    this.addSystemMessage(record.id, text).catch(() => {});
  }

  async forgetServerLocal(serverId) {
    const wasActiveCall = this.voice?.active?.server === serverId;
    this.servers.delete(serverId);
    // A rejoin must start from a clean slate, or the old branch's evidence
    // would immediately re-condemn the new membership.
    this.forks.clear(serverId);
    for (const key of [...this.forkWarned]) {
      if (key.startsWith(`${serverId}:`)) this.forkWarned.delete(key);
    }
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

  /** Admin gate for admin-only envelopes (overview, chanset, channel
      create/rename/delete). MLS can't enforce roles; the relay's ACL is the
      source of truth, but our cache of it can lag a promotion — an admin's
      edit arriving just after they were promoted must not be silently
      dropped because this device still has them as "member". So a sender we
      don't have as an admin always costs one ACL re-pull before we decide.

      When that re-pull still leaves the role unknown (the fetch failed, or
      the sender isn't in the roster yet) the two classes of envelope are
      NOT symmetric, so `destructive` picks the safe direction:

      - Additive envelopes (create a channel, edit the home base) fail
        *open*. A wrong guess leaves a stray channel, and the meta snapshot
        that trails these repairs the opposite error anyway.
      - Destructive envelopes fail *closed*. `chan-del` reaches
        `db.msgsDelete` and irreversibly drops this device's only copy of a
        room's history — in an E2EE app with no server-side backup, no later
        role sync can undo that. `chanset` counts as destructive too: it
        carries the kept-history and retention switches, so applying one
        from an unverified sender is a forward-secrecy downgrade. */
  async senderIsAdmin(record, sender, { destructive = false } = {}) {
    const cached = record.roles?.[sender];
    if (cached === 'admin') return true;
    await this.refreshRoles(record.id);
    const fresh = record.roles?.[sender];
    if (fresh === 'admin') return true;
    if (fresh) return false; // authoritative: in the roster, not an admin
    if (destructive) {
      console.warn(
        `dropped a destructive envelope from ${sender} in ${record.id}: role still unknown after an ACL refresh`
      );
      return false;
    }
    return true;
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
  // The work lives in `AccountService` (plan §2.2). These stay as the
  // controller's surface because the UI calls them, and because the two
  // sign-in paths finish with something only the controller can do: adopting
  // an identity and booting on it.

  checkVault() {
    return this.accounts.status();
  }

  markSecuredLocal() {
    return this.accounts.markSecuredLocal();
  }

  identityBytes() {
    const stored = this.identityKeyString();
    if (!stored) throw new Error('no identity on this device');
    return b64.dec(stored);
  }

  secureWithPassword(password) {
    return this.accounts.secureWithPassword(password);
  }

  secureWithPasskey() {
    return this.accounts.secureWithPasskey();
  }

  enrollDevicePasskey(label) {
    return this.accounts.enrollDevicePasskey(label);
  }

  listDevices() {
    return this.accounts.listDevices();
  }

  revokeDevice(credId) {
    return this.accounts.revokeDevice(credId);
  }

  accountKind(user) {
    return this.accounts.accountKind(user);
  }

  accountFetch(path, body) {
    return this.accounts.fetch(path, body);
  }

  /** Unlocking a vault yields an identity; adopting it is the irreversible
      half, and it stays here beside the rest of boot. */
  async adoptIdentity(identity) {
    await this.restoreIdentity(identity);
    await this.completeOnboarding(true);
  }

  async signInWithPassword(user, password) {
    await this.adoptIdentity(await this.accounts.unlockWithPassword(user, password));
  }

  async signInWithPasskey(user) {
    await this.adoptIdentity(await this.accounts.unlockWithPasskey(user));
  }

  async signInWithDiscoverablePasskey(opts) {
    await this.adoptIdentity(await this.accounts.unlockWithDiscoverablePasskey(opts));
  }

  // === attachments ========================================================

  httpBase() {
    return this.relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  }

  // === device linking =====================================================
  // The relay's blob store doubles as a blind rendezvous: the new device
  // polls a random id, the signed-in device seals its identity to the new
  // device's public key and PUTs it there. The relay only holds ciphertext.

  /** New device: fetch the sealed hand-off, or null until it's been sent. */
  async linkPoll(blobId) {
    const res = await fetch(`${this.httpBase()}/blobs/${encodeURIComponent(blobId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`link fetch failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Signed-in device: seal this identity to the offer and park it at the
      rendezvous. Returns the check code to show alongside the other device. */
  async sendIdentityToDevice(blobId, pubRaw) {
    const { payload, code } = await sealIdentity(pubRaw, this.identityBytes());
    const res = await fetch(`${this.httpBase()}/blobs/${encodeURIComponent(blobId)}`, {
      method: 'PUT',
      body: payload,
    });
    if (!res.ok) throw new Error(`link send failed: HTTP ${res.status}`);
    return code;
  }

  async sendFile(serverId, channel, fileHandle) {
    if (fileHandle.size > 20 * 1024 * 1024) throw new Error('attachment too large (20 MB max)');
    const data = new Uint8Array(await fileHandle.arrayBuffer());
    // Random AES-GCM key per file; the relay sees only ciphertext under a
    // random capability id. The key rides inside the MLS message.
    const key = generateFragmentKey();
    const encrypted = await encryptBlob(key, data);
    const blobId = b64url.enc(crypto.getRandomValues(new Uint8Array(18)));
    // The PUT route is unauthenticated by design (it carries opaque bytes
    // and no session), so authorize this one upload over the authenticated
    // socket first. Without it, anyone could write to the relay's disk.
    const { ticket } = await this.relay.request({ t: 'blob_ticket', id: blobId });
    const res = await fetch(`${this.httpBase()}/blobs/${blobId}`, {
      method: 'PUT',
      headers: { 'x-upload-ticket': ticket },
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

  /** Verification is stored against the *key* it was performed on, not the
      handle. `record.verifiedSn` maps peer -> the safety number the user
      actually compared out of band; `record.verified` stays the plain array
      the roster renders from, derived from it.

      The safety number is a collision-resistant function of both parties'
      MLS identity keys (crypto-core `safety_number`), so it is already the
      binding we need: if the peer's key is ever replaced — a remove/re-add,
      or a relay substituting a KeyPackage — the number no longer matches what
      was checked, and `revalidateVerified` drops the badge. Storing only the
      handle, as this did before, left a ✓ that survived a key change and so
      certified nothing. */
  async markVerified(serverId, peer) {
    const record = this.servers.get(serverId);
    const sn = await this.safetyNumber(serverId, peer);
    applyVerified(record, peer, sn);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Record that a comparison came back *wrong*.

      A dialog whose only button grants trust is a consent funnel: the user who
      does the work correctly and finds a mismatch has nothing to click and no
      trace of what they found. `record.mismatched` maps peer -> the safety
      number that failed, so a later key change can clear it the same way
      `verifiedSn` is cleared.

      Device-local, and deliberately not in the encrypted backup — for the same
      reason `verifiedSn` isn't. This is the user's own judgement about a
      comparison they made in person, and it does not transfer to a device that
      never made it. */
  async markMismatch(serverId, peer) {
    const record = this.servers.get(serverId);
    const sn = await this.safetyNumber(serverId, peer);
    applyMismatch(record, peer, sn);
    await this.db.serverPut(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Re-derive every stored safety number and clear the ones that moved.
      Runs on each membership change, which is when a key can enter the group.

      Records written before verification was key-bound carry a `verified`
      array with no `verifiedSn`. Those are dropped rather than adopted: the
      user did compare digits at some point, but nothing recorded against
      what, so a substitution that happened after that check would be
      indistinguishable from a clean history. Re-verifying is cheap; a ✓ that
      might certify the wrong key is not. */
  async revalidateVerified(record) {
    const legacy = !record.verifiedSn && record.verified?.length;
    if (legacy) {
      record.verifiedSn = {};
      record.verified = [];
      await this.addSystemMessage(
        record.id,
        'verification badges were reset — safety numbers are now checked against the key that was verified. Please re-check the members you trust.'
      );
      return true;
    }
    // A recorded mismatch is about the key that was in front of the user when
    // they compared. If that key is gone, the finding is spent: keeping it
    // would badge a member over a comparison nobody ever made against the key
    // they now hold. Cleared quietly — the mismatch already had its say.
    let changed = false;
    for (const [peer, was] of Object.entries(record.mismatched ?? {})) {
      let now;
      try {
        now = await this.safetyNumber(record.id, peer);
      } catch {
        continue;
      }
      if (retireMismatch(record, peer, now)) {
        changed = true;
        await this.addSystemMessage(
          record.id,
          `${peer}'s key changed since you found a mismatch — the warning is cleared, but nothing has been verified. Compare again before trusting them.`
        );
      }
    }

    const stored = record.verifiedSn;
    if (!stored || !Object.keys(stored).length) return changed;

    for (const [peer, was] of Object.entries(stored)) {
      // Someone who has left the group keeps their entry: if they are ever
      // re-added the check below runs against the new key and catches it.
      if (!record.members?.includes(peer)) continue;
      let now;
      try {
        now = await this.safetyNumber(record.id, peer);
      } catch {
        continue; // no MLS view of this peer right now; decide next time
      }
      if (now !== was) {
        delete stored[peer];
        changed = true;
        await this.addSystemMessage(
          record.id,
          `${peer}'s safety number changed — verification cleared. Check it again before trusting this device.`
        );
      }
    }
    if (changed) record.verified = Object.keys(stored);
    return changed;
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
        // A deploy swaps the shell underneath a running page: the worker
        // calls skipWaiting, so the new cache takes over while this tab is
        // still executing the previous bundle. Anything it loads lazily from
        // here on is a chunk the new shell no longer has.
        //
        // Say so rather than reloading. A tab reloading itself mid-sentence
        // is a worse outcome than a stale one, and only the person typing
        // can judge when it is safe.
        if (updatePrompt(navigator.serviceWorker.controller)) {
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            this.dispatch({ type: 'toast', text: UPDATE_TEXT });
          });
        }
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
    // An external commit advances the epoch like any other, so it takes
    // part in the same compare-and-swap. If it loses, the group changed
    // under us mid-join: drop the half-built local group and let the user
    // retry the link rather than leaving an unusable stub behind.
    const sent = await this.relay
      .request({ t: 'send', group, epoch, payload: b64.enc(commit), commit: true })
      .catch(async (e) => {
        await this.crypto('forgetGroup', { group }).catch(() => {});
        throw new Error(
          /epoch conflict/i.test(e.message ?? '')
            ? 'the circle changed while you were joining — open the invite link again'
            : e.message
        );
      });
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
      verifiedSn: prior?.verifiedSn,
      mismatched: prior?.mismatched,
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

  /** Ask the browser not to evict our storage, and say so when it refuses.

      This used to run once, during onboarding, with its result discarded.
      That is the worst possible handling on WebKit: Safari does not
      implement persist() at all, so the optional chain silently no-ops, and
      script-writable storage for a site the user has not installed is
      cleared after 7 days of no interaction. The identity key mirror in
      localStorage goes in the same sweep. A user who follows the README —
      open the link in Safari, use it — is on an undisclosed timer to losing
      their account and every group ratchet, with nothing on screen.

      Run on every boot (grants can be revoked, and a site that was denied
      once may qualify later once the user engages with it), check the
      answer, and surface it. Returns true when storage is durable. */
  async requestPersistentStorage() {
    let persisted = false;
    try {
      // Already granted? Do not re-prompt.
      persisted = (await navigator.storage?.persisted?.()) ?? false;
      if (!persisted) persisted = (await navigator.storage?.persist?.()) ?? false;
    } catch {
      persisted = false;
    }
    this.storagePersisted = persisted;
    if (!persisted) {
      // Distinguish "the browser said no" from "the browser has no opinion":
      // only the former is a countdown we can name.
      const evicts = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent ?? '');
      this.dispatch({
        type: 'storageAtRisk',
        evicts,
      });
      console.warn(
        `storage is not persistent${evicts ? ' — WebKit clears it after 7 days without interaction' : ''}`
      );
    }
    return persisted;
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
        verified: [...(r.verified ?? [])],
        verifiedSn: { ...(r.verifiedSn ?? {}) },
        mismatched: { ...(r.mismatched ?? {}) },
        notices: [...(r.notices ?? [])],
        rsvps: { ...(r.rsvps ?? {}) },
        overview: r.overview ? JSON.parse(JSON.stringify(r.overview)) : r.overview,
        chanMeta: JSON.parse(JSON.stringify(r.chanMeta ?? {})),
        // Live only: which game each member says they're in right now.
        presence: { ...(this.livePresence?.get(r.id) ?? {}) },
        // Live only: open rallies — who wants to play what right now.
        wants: { ...(this.liveWants?.get(r.id) ?? {}) },
        // Live only: who is composing right now, per channel. Reader-expired.
        typing: { ...(this.liveTyping?.get(r.id) ?? {}) },
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


export const UPDATE_TEXT = 'a new version is ready — reload when you get a moment';

/**
 * Should a controller change be announced as an update?
 *
 * Only when this page was *already* controlled. The very first visit takes
 * control for the first time, which fires the same event and is not an
 * update — announcing it would greet every new install with a notice about a
 * version they just installed.
 */
export function updatePrompt(currentController) {
  return currentController != null;
}

/** How far back "unread" reaches in a room this device has never opened.
    Falling back to 0 would count a circle's entire backfilled history as
    unread the moment you join it; `joinedAt` scopes it to what arrived after
    you did. */
export function seenFloor(record, channel) {
  return record?.seen?.[channel] ?? record?.joinedAt ?? 0;
}

/** Messages that arrived after this device last looked. Your own messages
    never count — they are read by definition, and a sender clock running
    ahead of the device that sent them would otherwise leave them unread
    forever. `system` chips are chrome, not conversation. */
export function countUnread(msgs, seen, me) {
  let n = 0;
  for (const m of msgs ?? []) {
    if (m.system || m.sender === me) continue;
    if ((Number(m.ts) || 0) > seen) n += 1;
  }
  return n;
}



