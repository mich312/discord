// Orchestration: worker (crypto) <-> relay (transport + circle storage)
// <-> IndexedDB (this device's keys and cursors) <-> React (render). The
// controller owns the canonical in-memory server records; React state is a
// projection of them.
//
// Where those records come from changed. They used to be read from
// IndexedDB at boot and written back on every mutation, with a backup
// parked on the relay as a fallback for a fresh sign-in. The relay's blob
// is now the only copy: circles load from it on connect and every change
// is written back to it. See circles.js for which fields go where, and
// db.js for what is left on the device.
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
//                                   no separate ACL needed. The live half of
//                                   a log entry the sender also writes, and
//                                   carries that entry's own `ts` so the two
//                                   are one event rather than two
//   {k:'del', ch, to:{ts}}        — tombstone one of MY OWN lines: same
//                                   (sender, ts) self-scoping as edit. The
//                                   tombstone is what readers fold over the
//                                   line; removing the original entry from
//                                   the relay is a separate authorized
//                                   request. Neither reaches a device that
//                                   already read it
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
  openBackup,
  openLogEntry,
  sealBackup,
  sealLogEntry,
  verifyEntries,
} from './history.js';
import {
  addEntries,
  addLocalEntry,
  addSystemMessage,
  createChannelLog,
  messageId,
  pruneLog,
  renderLog,
} from './log.js';
import { keyDirectory, mergeKeyDirectory } from './keys.js';
import { deviceHalf, hydrate, mergeBackups, sharedHalf } from './circles.js';
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

/** Superseded room keys a channel carries for reading.
    Every removal mints a new key and archives the old one. There is no cap:
    when the relay's log was a convenience copy, dropping the ninth-oldest
    key cost a little scrollback nobody was promised. It is now the only
    copy of the conversation, so forgetting a key destroys the messages it
    opens — a circle with heavy churn would silently lose its own past.
    Keys are 32 bytes; a hundred removals is three kilobytes of backup. */
const HISTORY_PAGE = 50;
/** Cache key for one channel's working copy. The separator cannot occur in
    either half — channel names are slugged and circle ids are base64url. */
const LOG_SEP = '\u0000';
const logKey = (serverId, channel) => `${serverId}${LOG_SEP}${channel}`;

/** Every key that might open an entry in this channel: the current one,
    the ones a removal superseded, and any alternate log's. Reads try them
    all — see `mergeChanKeys` for why a channel can have more than one. */
const channelKeys = (meta) =>
  [meta?.hkey, ...(meta?.hkeys ?? []), ...(meta?.alts ?? []).map((a) => a?.hkey)].filter(Boolean);
const KP_TOPUP = 2; // fresh KeyPackages published per connect
/** Wire version of the parked circles blob.
    v1 carried a circle's shape and room keys as a fallback for a fresh
    sign-in. v2 is the same blob promoted to the only copy, so it also
    carries what the local record used to hold alone: invite fragment keys
    (a link stops being refreshed without them), deletion tombstones (a
    deleted room comes back without them), and RSVPs. v1 opens unchanged —
    it is a subset — and is rewritten as v2 by the first change. */
const BACKUP_VERSION = 2;
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
    // circle id -> this device's half of it (cursors, read markers,
    // verifications). Loaded from IndexedDB at boot; see circles.js.
    this.deviceState = {};
    this.me = null;
    // `${server}\u0000${channel}` -> channel log. In memory for the
    // session and never written to disk: the relay's log is the
    // conversation, and this is the working copy of the pages we have
    // fetched. A reload re-reads it, which is what makes a fresh device
    // and a two-year-old one show the same room.
    this.logs = new Map();
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
      await this.loadDeviceState();
      // No circles yet: they live on the relay now, so they arrive with the
      // connection rather than with the database. The rail says it is
      // loading until `loadCircles` answers, which is the honest report —
      // an empty rail would read as "you are in no circles".
      this.dispatch({ type: 'booted', me: this.me, servers: [] });
      this.dispatch({ type: 'circlesLoading', loading: true });
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
    await this.loadDeviceState();
    this.dispatch({ type: 'booted', me: this.me, servers: this.snapshotServers() });
    // A brand-new identity has nothing parked, but a sign-in on a new
    // device does — and this is the path it takes. Say "loading" either
    // way; `loadCircles` clears it the moment it knows.
    this.dispatch({ type: 'circlesLoading', loading: true });
    this.connectRelay();
    this.setupServiceWorker();
  }

  // === persistence ========================================================
  //
  // Two seams, and which one a mutation uses is the same question circles.js
  // asks: did the circle change, or did only this device's view of it?
  //
  //   persistCircle — the shape moved (a room, a setting, a room key, the
  //                   home base). Writes this device's half too, then parks
  //                   a new backup blob.
  //   persistDevice — only a cursor, a read marker or a verification moved.
  //                   Never touches the relay, because no other device of
  //                   this account is entitled to that answer.
  //
  // Nothing writes a circle record to IndexedDB any more. There is no
  // `servers` store to write it to.

  /** Load this device's per-circle state (cursors, read markers,
      verifications) — the half of a record that is not in the backup. */
  async loadDeviceState() {
    this.deviceState = (await this.db.kvGet('deviceState')) ?? {};
    return this.deviceState;
  }

  /** Persist the device half of `record`, leaving the relay alone. */
  async persistDevice(record) {
    if (!record?.id) return;
    this.deviceState = { ...(this.deviceState ?? {}), [record.id]: deviceHalf(record) };
    await this.db.kvPut('deviceState', this.deviceState);
  }

  /** Persist both halves: the device's, and — via the debounced upload —
      the circle's, on the relay. */
  async persistCircle(record) {
    await this.persistDevice(record);
    await this.persistCircleNames();
    this.scheduleBackup();
  }

  /**
   * The one piece of circle content still written to this device: a map of
   * circle id to display name, for the service worker.
   *
   * Kept deliberately, and deliberately small. A push carries a group id
   * and a kind — never content — and the worker turns that into "new
   * message in Sunday Cyclists" using what the device knows. It cannot use
   * the circles blob: opening that needs the identity bundle from
   * localStorage, which a service worker has no access to, and the worker
   * runs exactly when the page that could open it is closed.
   *
   * So the choice is a name cache or notifications that cannot say which
   * circle they are about. This is the cache, and it is the only exception
   * to circles living on the relay.
   */
  async persistCircleNames() {
    const names = {};
    for (const record of this.servers.values()) names[record.id] = record.name;
    await this.db.kvPut('circleNames', names);
  }

  /** Drop every trace of a circle from this device's state. */
  async forgetDeviceState(serverId) {
    if (!this.deviceState?.[serverId]) return;
    this.deviceState = { ...this.deviceState };
    delete this.deviceState[serverId];
    await this.db.kvPut('deviceState', this.deviceState);
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
        // The circles themselves come from the relay, so this is the first
        // moment they can exist at all. Everything below operates on what
        // it returns — which is why it is awaited rather than kicked off
        // alongside the subscriptions.
        await this.loadCircles().catch((e) => {
          // A failure here is not "you have no circles", and must never be
          // allowed to look like one: the guard inside `uploadBackup`
          // refuses to park a blob until a load has succeeded, so a relay
          // that is up enough to talk but not to serve the backup cannot
          // get us to overwrite it with nothing.
          console.warn(`loading circles: ${e.message}`);
          this.toast(`your circles could not be loaded: ${e.message}`);
          // Stop saying "loading" for something that has stopped loading.
          // An empty rail is the wrong answer here, but a placeholder that
          // never resolves is a worse one — the toast is what carries the
          // reason, and a reconnect retries.
          this.dispatch({ type: 'circlesLoading', loading: false });
        });
        // Re-subscribe everything from where we left off, then top up
        // the KeyPackage store so others can add us while we're away.
        // Restored records (no MLS state on this device) have nothing to
        // decrypt with — they stay read-only until a re-add arrives.
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
          // The roster is the only trustworthy source for who holds which
          // key, and it is what log-entry signatures are checked against.
          this.refreshKeyDirectory(record).catch((e) =>
            console.warn(`key directory ${record.id}: ${e.message}`)
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
          this.catchUpLogs(record).catch((e) =>
            console.warn(`log catch-up ${record.id}: ${e.message}`)
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
    await this.persistCircle(record);
    await this.addSystemMessage(
      group,
      prior?.restored
        ? `you were re-added — this device can send again`
        : `you joined — history before this point does not exist for you`
    );
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.relay.request({ t: 'subscribe', group, after: msg.after });
    this.refreshRoles(group);
    this.catchUpLogs(record).catch((e) => console.warn(`log catch-up: ${e.message}`));
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
        // so re-check every badge against the key it was granted for — and
        // pick up the joiner's key, so their log entries can be attributed.
        await this.revalidateVerified(record);
        await this.refreshKeyDirectory(record);
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
    await this.persistDevice(record);
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
        // The live half of the log. Every one of these is the same event
        // the sender also wrote to the relay, carrying the same author and
        // the same timestamp — so when the log page for it arrives later,
        // the fold collapses the two into one rather than applying it
        // twice. MLS already authenticated the sender, which is why these
        // enter the fold as 'signed' without a second signature check.
        case 'storeMessage':
          this.applyLiveEntry(e.message.server, e.message.channel, {
            k: e.message.file ? 'file' : e.message.game ? 'game' : 'chat',
            sender: e.message.sender,
            ts: e.message.ts,
            ...(e.message.file
              ? { file: e.message.file }
              : e.message.game
                ? { game: e.message.game }
                : { text: e.message.text }),
            ...(e.message.reply ? { reply: e.message.reply } : {}),
          });
          this.dispatch({ type: 'newMessage', message: e.message });
          break;
        case 'systemMessage':
          this.addSystemMessage(e.server, e.text, e.channel);
          break;
        case 'reaction':
          this.applyLiveEntry(e.server, e.channel, {
            k: 'react',
            sender: e.by,
            ts: e.at,
            to: e.target,
            emo: e.emo,
            op: e.op === 'del' ? 'del' : 'add',
          });
          break;
        case 'editMessage':
          this.applyLiveEntry(e.server, e.channel, {
            k: 'edit',
            sender: e.sender,
            ts: e.at,
            to: { ts: e.ts },
            text: e.text,
          });
          break;
        case 'deleteMessage':
          this.applyLiveEntry(e.server, e.channel, {
            k: 'del',
            sender: e.sender,
            ts: e.at,
            to: { ts: e.ts },
          });
          break;
        case 'renameMessages':
          this.renameChannelLog(e.server, e.from, e.to);
          break;
        case 'deleteMessages':
          this.forgetChannelLog(e.server, e.channel);
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
          // Fire-and-forget by design: a log fetch must never hold up
          // applying the rest of the MLS stream.
          this.catchUpLogs(record).catch((err) => console.warn(`log catch-up: ${err.message}`));
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
    // Every channel has a room key from the moment it exists — there is no
    // other place its messages could live.
    this.ensureChannelKeys(record, 'general');
    this.servers.set(id, record);
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    // Mint the room key with the room, so the first message written into it
    // has somewhere to live. Doing it here rather than lazily also means one
    // author, so no two members can mint competing keys for a new channel.
    this.ensureChannelKeys(record, ch);
    await this.sendContent(serverId, { k: 'chan', ch });
    await this.sendContent(serverId, { k: 'chanset', ch, meta: record.chanMeta[ch] });
    // The `chan` event above is dropped by any peer that doesn't yet see us
    // as an admin (stale role cache, or a global admin who is only a circle
    // member). Follow it with a meta snapshot so the ungated union repairs
    // them — otherwise the room shows for us and never for them.
    await this.sendContent(serverId, this.metaContent(record));
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Change a channel's settings: topic and auto-delete (retention, in
      seconds). The UI gates this to admins; inside the group it is a
      visible, announced change like channel creation — MLS can't enforce
      roles, so the roster's own eyes are the enforcement.

      There is no longer a switch for whether the channel keeps history.
      Every channel does: the relay's log is where messages live, so a
      channel without a room key would be one nobody could read tomorrow.
      Retention is the lever that remains, and it is the real one — it is
      what bounds how far back a leaked room key ever reaches. */
  async setChannelSettings(serverId, channel, { topic, retention }) {
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
    if (!meta.hid || !meta.hkey) {
      meta.hid = meta.hid ?? generateHistoryId();
      meta.hkey = meta.hkey ?? generateHistoryKey();
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
    this.applyRetention(record, channel);
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.dispatch({ type: 'refreshMessages' });
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  /** Unpin a note (the UI offers this to the author and to admins; the
      receive side re-checks the same rule). */
  async removeNotice(serverId, id) {
    const record = this.servers.get(serverId);
    record.notices = (record.notices ?? []).filter((n) => n.id !== id);
    await this.sendContent(serverId, { k: 'notice', op: 'del', id });
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    const log = this.logs.get(logKey(record.id, channel));
    const newest = renderLog(log ?? createChannelLog())
      .filter((m) => !m.system)
      .reduce((max, m) => Math.max(max, Number(m.ts) || 0), 0);
    const anchor = newest || Date.now();
    record.seen = { ...(record.seen ?? {}), [channel]: Math.max(anchor, atLeastTs) };
    await this.persistDevice(record);
  }

  /**
   * How many entries each of a circle's logs has gained since this device
   * last looked, asked of the relay rather than counted locally.
   *
   * The relay already knows how many entries a log holds, when each landed
   * and who appended it — that is the metadata it cannot help seeing. So
   * counting them there costs no privacy that was not already spent, and
   * it is the only way a device that holds no messages can render an
   * unread badge without downloading and decrypting every channel first.
   * Your own entries never count: they are read by definition.
   */
  async fetchUnread(record) {
    const logs = [];
    for (const channel of record.channels ?? []) {
      const meta = record.chanMeta?.[channel];
      if (!meta?.hid) continue;
      logs.push({
        channel,
        hid: meta.hid,
        after_ts: Math.floor(seenFloor(record, channel) / 1000),
      });
    }
    if (!logs.length) return {};
    try {
      const reply = await this.relay.request({
        t: 'history_counts',
        group: record.id,
        logs: logs.map(({ hid, after_ts }) => ({ hid, after_ts })),
      });
      const byHid = Object.fromEntries((reply.counts ?? []).map((c) => [c.hid, c.n]));
      return Object.fromEntries(logs.map((l) => [l.channel, byHid[l.hid] ?? 0]));
    } catch (e) {
      console.warn(`unread ${record.id}: ${e.message}`);
      return {};
    }
  }

  /** Per-room digest for the home base: unread-since-last-look, and the
      latest line for the rooms whose pages this session has already read.
      The count comes from the relay; the preview needs the room key, so a
      room this device has not opened yet shows a count without a quote. */
  async channelDigest(serverId) {
    const record = this.servers.get(serverId);
    if (!record) return [];
    const unreads = await this.fetchUnread(record);
    return record.channels.map((channel) => {
      const log = this.logs.get(logKey(serverId, channel));
      const msgs = log ? renderLog(log).filter((m) => !m.system) : [];
      const last = msgs.at(-1);
      return {
        channel,
        unread: unreads[channel] ?? 0,
        last: last
          ? {
              sender: last.sender,
              text: last.file ? `sent ${last.file.name}` : last.text,
              ts: last.ts,
            }
          : null,
      };
    });
  }

  /** Unread totals per circle, for the rail. Without this the rail is pure
      identity: nothing on screen says a circle you are not looking at has
      moved, so anyone in more than two circles has to click through them to
      find out — which is what made the multi-circle model unusable. */
  async circleUnreads() {
    const out = {};
    for (const record of this.servers.values()) {
      const per = await this.fetchUnread(record);
      out[record.id] = Object.values(per).reduce((n, v) => n + v, 0);
    }
    return out;
  }

  /**
   * Search the messages this session has loaded, across every circle.
   *
   * Necessarily client-side: the relay holds ciphertext and cannot index
   * it. What changed with the log is the *scope* — this used to search
   * everything the device had ever kept, and now it searches what has been
   * read back into memory, which is a room's most recent page until you
   * scroll further. Narrower, and the UI says so rather than implying the
   * whole archive was consulted.
   */
  async searchMessages(query, opts = {}) {
    if (String(query ?? '').trim().length < MIN_QUERY) return { hits: [], truncated: false };
    const rows = [];
    for (const record of this.servers.values()) {
      for (const channel of record.channels) {
        const log = this.logs.get(logKey(record.id, channel));
        if (!log) continue;
        for (const message of renderLog(log)) {
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

  /** Reader half of auto-delete: drop what is past retention from the
      working copy. The relay enforces the same expiry on the log itself,
      which is where it actually bites — this only stops a page fetched
      before the cutoff from lingering on screen. */
  applyRetention(record, channel) {
    const retention = record.chanMeta?.[channel]?.retention;
    if (!retention) return 0;
    const log = this.logs.get(logKey(record.id, channel));
    return log ? pruneLog(log, Date.now() - retention * 1000) : 0;
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    this.renameChannelLog(serverId, from, ch);
    await this.sendContent(serverId, { k: 'chan-ren', ch: from, to: ch });
    await this.addSystemMessage(serverId, `#${from} renamed to #${ch}`, ch);
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    this.dispatch({ type: 'refreshMessages' });
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
    this.forgetChannelLog(serverId, channel);
    await this.sendContent(serverId, { k: 'chan-del', ch: channel });
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
  }

  async sendChat(serverId, channel, text, reply) {
    // The timestamp is the sender's, carried on the wire, so every device —
    // and the channel log — stamps this message identically. Otherwise each
    // recipient's own receive-clock ts would (a) order messages differently
    // per member and (b) defeat the dedup between the live MLS copy and the
    // log entry, which keys on (sender, ts). See `messageTs`.
    const ts = Date.now();
    const quote = normalizeReply(reply);
    await this.deliverChat(serverId, channel, text, ts, quote);
  }

  /** Network half of sendChat; also the retry path for a failed line.
      Two writes, deliberately: the log entry is the message (it is what
      every later reader gets), the MLS send is what makes it arrive now. */
  async deliverChat(serverId, channel, text, ts, reply) {
    const quote = normalizeReply(reply);
    const seq = await this.appendLog(serverId, channel, {
      k: 'chat',
      ts,
      text,
      ...(quote ? { reply: quote } : {}),
    });
    this.markLocalState(serverId, channel, ts, { failed: seq === null });
    if (seq === null) throw new Error('the message could not be written to the circle');
    await this.sendContent(serverId, {
      k: 'chat',
      ch: channel,
      text,
      ts,
      ...(quote ? { reply: quote } : {}),
    }).catch((e) => {
      // The log has it, so it is not lost and everyone will see it on their
      // next read — only the instant delivery failed. Not worth a retry
      // affordance that would double-write the log.
      console.warn(`live send #${channel}: ${e.message}`);
    });
  }

  /** Flag a line this device wrote — failed, pending — on the working copy.
      Presentation only: the log entry itself carries no such field. */
  markLocalState(serverId, channel, ts, patch) {
    const log = this.logs.get(logKey(serverId, channel));
    const message = log?.base.get(messageId(this.me, ts));
    if (!message) return;
    Object.assign(message, patch);
    this.dispatch({ type: 'refreshMessages' });
  }

  /** Retry a line whose log append failed. */
  async retryMessage(serverId, channel, message) {
    this.markLocalState(serverId, channel, message.ts, { failed: false });
    await this.deliverChat(serverId, channel, message.text, message.ts, message.reply);
  }

  /** Announce a game launch as a first-class message: renders as a join
      card for everyone in the room. Only a reference travels — id, name,
      kind — never a URL; joining resolves against the shelf. */
  async sendGameCard(serverId, channel, game) {
    const ref = normalizeGameRef(game);
    if (!ref) return;
    const ts = Date.now();
    await this.appendLog(serverId, channel, { k: 'game', ts, game: ref });
    await this.sendContent(serverId, { k: 'game', ch: channel, game: ref, ts });
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

  /** Toggle my reaction on one message. Written to the log like anything
      else: a reaction that lived only on the devices that were online would
      disappear on reload now that the log is the conversation. */
  async react(serverId, channel, target, emo) {
    const record = this.servers.get(serverId);
    if (!record) return;
    const log = this.channelLog(serverId, channel);
    const current = renderLog(log).find(
      (m) => m.sender === target.sender && m.ts === target.ts
    );
    const mine = !current?.reacts?.[emo]?.includes(this.me);
    const op = mine ? 'add' : 'del';
    const at = Date.now();
    await this.appendLog(serverId, channel, {
      k: 'react',
      ts: at,
      to: { sender: target.sender, ts: target.ts },
      emo,
      op,
    });
    await this.sendContent(serverId, {
      k: 'react',
      ch: channel,
      to: { sender: target.sender, ts: target.ts },
      emo,
      op,
      ts: at,
    });
  }

  /** Edit one of my own lines. Only text messages are editable (a file or
      game card has nothing to retype). The edit is an entry in the log, so
      it survives a reload and reaches a device that was not online for it —
      the sealed original stays in place beneath it, and readers fold the
      newer entry over it. */
  async editMessage(serverId, channel, message, text) {
    const record = this.servers.get(serverId);
    if (!record || message.sender !== this.me) return;
    const next = String(text ?? '').trim();
    if (!next || next === message.text) return;
    const at = Date.now();
    await this.appendLog(serverId, channel, {
      k: 'edit',
      ts: at,
      to: { ts: message.ts },
      text: next,
    });
    await this.sendContent(serverId, {
      k: 'edit',
      ch: channel,
      to: { ts: message.ts },
      text: next,
      ts: at,
    });
  }

  /**
   * Delete one of my own lines.
   *
   * Two things happen, and they do different jobs. The tombstone entry is
   * what every reader folds over the original, so the line reads as deleted
   * everywhere. The redaction asks the relay to drop the original entry's
   * ciphertext, so somebody who joins tomorrow cannot simply read it with
   * the room key — which a tombstone alone would not prevent, because the
   * original would still be sitting in the log.
   *
   * The relay authorizes the redaction against the author it recorded when
   * the entry was appended. What it cannot reach is a device that already
   * fetched the line; the UI says so at the button.
   */
  async deleteMessage(serverId, channel, message) {
    const record = this.servers.get(serverId);
    if (!record || message.sender !== this.me) return;
    const at = Date.now();
    await this.appendLog(serverId, channel, { k: 'del', ts: at, to: { ts: message.ts } });
    const hid = record.chanMeta?.[channel]?.hid;
    if (hid && Number.isFinite(message.seq)) {
      await this.relay
        .request({ t: 'history_redact', group: serverId, hid, seq: message.seq })
        .catch((e) => console.warn(`redact #${channel}: ${e.message}`));
    }
    await this.sendContent(serverId, { k: 'del', ch: channel, to: { ts: message.ts }, ts: at });
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.sendContent(serverId, { k: 'rsvp', at, going: !!going });
  }

  // === the channel log ====================================================
  //
  // The relay's per-channel log is the conversation. Everything below either
  // writes an entry to it, reads a page back, or keeps the in-memory working
  // copy in step. Nothing here touches IndexedDB: what a device holds is a
  // cache of what the relay already has, and it dies with the tab.

  /** The in-memory working copy of one channel, created on first touch. */
  channelLog(serverId, channel) {
    const key = logKey(serverId, channel);
    let log = this.logs.get(key);
    if (!log) {
      log = createChannelLog();
      this.logs.set(key, log);
    }
    return log;
  }

  forgetChannelLog(serverId, channel) {
    this.logs.delete(logKey(serverId, channel));
  }

  forgetCircleLogs(serverId) {
    for (const key of [...this.logs.keys()]) {
      if (key.startsWith(`${serverId}${LOG_SEP}`)) this.logs.delete(key);
    }
  }

  /** Sign log-entry bytes with this device's MLS identity key. */
  async signEntry(bytes) {
    return new Uint8Array(await this.crypto('sign', { bytes }));
  }

  /** Batch-verify entry signatures in the worker. */
  verifyBatch = (items) => this.crypto('verifyEntries', { items });

  /**
   * Give `channel` a room key if it has none.
   *
   * Every channel has one now — the log is where messages live, so a
   * channel without a key would be a channel nobody can read tomorrow.
   * Minting is idempotent-ish rather than coordinated: two admins racing
   * produce two keys, both of which readers keep (see `chanset` merging),
   * so the loser's entries stay readable instead of being lost.
   */
  ensureChannelKeys(record, channel) {
    const meta = record.chanMeta?.[channel];
    if (meta?.hid && meta?.hkey) return null;
    const next = {
      ...(meta ?? {}),
      hid: meta?.hid ?? generateHistoryId(),
      hkey: meta?.hkey ?? generateHistoryKey(),
    };
    record.chanMeta = { ...(record.chanMeta ?? {}), [channel]: next };
    return next;
  }

  /**
   * Write one entry to a channel's log, and show it locally at once.
   *
   * The MLS message that carries the same content to whoever is online is
   * sent separately: it is what makes the room feel live. This is what
   * makes it durable, and it is the copy every later reader gets.
   */
  async appendLog(serverId, channel, entry) {
    const record = this.servers.get(serverId);
    if (!record) return;
    const minted = this.ensureChannelKeys(record, channel);
    const meta = record.chanMeta[channel];
    if (minted) {
      // A freshly minted key is no use to anyone who cannot read it: tell
      // the roster before the first entry sealed under it lands.
      await this.sendContent(serverId, { k: 'chanset', ch: channel, meta }).catch((e) =>
        console.warn(`announce room key #${channel}: ${e.message}`)
      );
      await this.persistCircle(record);
    }
    const full = { sender: this.me, ...entry };
    addLocalEntry(this.channelLog(serverId, channel), full, { server: serverId, channel });
    this.dispatch({ type: 'refreshMessages' });
    const tsSecs = Math.floor(full.ts / 1000);
    try {
      const payload = await sealLogEntry(meta.hkey, serverId, meta.hid, full, (bytes) =>
        this.signEntry(bytes)
      );
      const sent = await this.relay.request({
        t: 'history_append',
        group: serverId,
        hid: meta.hid,
        ts: tsSecs,
        expires_at: meta.retention ? tsSecs + meta.retention : null,
        payload,
      });
      return sent.seq;
    } catch (e) {
      // The line is on screen but not in the log, which means it is not in
      // the conversation. Say so rather than letting it look delivered.
      console.warn(`log append #${channel}: ${e.message}`);
      this.toast(`a message could not be saved to the circle: ${e.message}`);
      return null;
    }
  }

  /**
   * Decrypt and authenticate a page of raw log entries.
   *
   * Two independent checks, in order. The room key says the entry belongs
   * to this channel and nobody outside the roster wrote it; the signature
   * says which member did. An entry that fails the first is skipped (a
   * superseded key, or damage); one that fails the second is dropped
   * outright by the fold — that is somebody with the room key writing in
   * another member's name.
   */
  async openPage(record, channel, entries, hid = null) {
    const meta = record.chanMeta?.[channel];
    if (!meta?.hid) return [];
    const keys = channelKeys(meta);
    const opened = [];
    for (const e of entries) {
      let entry = null;
      // Current key first, then keys superseded by a removal, then any
      // alternate log's — entries parked before a rotation, or in a log
      // this device does not write to, are still legitimately readable.
      for (const key of keys) {
        try {
          entry = await openLogEntry(key, e.payload);
          break;
        } catch {
          /* try the next key */
        }
      }
      if (entry) opened.push({ seq: e.seq, entry });
    }
    const auths = await verifyEntries(
      record.id,
      hid ?? meta.hid,
      opened.map((o) => o.entry),
      keyDirectory(record),
      this.verifyBatch
    );
    return opened.map((o, i) => ({ ...o, auth: auths[i] }));
  }

  /** One page of a channel, folded into the working copy. Returns how many
      entries were new, and whether the log's start has been reached. */
  async fetchPage(record, channel, { before, after = 0, limit = HISTORY_PAGE } = {}) {
    const meta = record.chanMeta?.[channel];
    if (!meta?.hid || !meta?.hkey) return { added: 0, complete: true };
    const log = this.channelLog(record.id, channel);
    let reply;
    try {
      reply = await this.relay.request({
        t: 'history_fetch',
        group: record.id,
        hid: meta.hid,
        after,
        before: before ?? null,
        limit,
      });
    } catch (e) {
      console.warn(`log fetch #${channel}: ${e.message}`);
      return { added: 0, complete: false };
    }
    const opened = await this.openPage(record, channel, reply.entries ?? []);
    const added = addEntries(log, opened, { server: record.id, channel });
    if (before !== undefined && reply.complete) log.complete = true;
    return { added, complete: !!reply.complete };
  }

  /**
   * Drain any alternate logs this channel has.
   *
   * A channel ends up with more than one log only when two members minted
   * a key for it at the same moment (see `mergeChanKeys`), so this is
   * normally a no-op. When it is not, the alternate holds real messages
   * that would otherwise be invisible, so it is read once, whole, and
   * folded in beside the primary — page cursors track the primary only.
   */
  async drainAlternateLogs(record, channel) {
    const alts = record.chanMeta?.[channel]?.alts ?? [];
    if (!alts.length) return;
    const log = this.channelLog(record.id, channel);
    for (const alt of alts) {
      if (!alt?.hid) continue;
      let after = 0;
      for (let page = 0; page < 20; page++) {
        let reply;
        try {
          reply = await this.relay.request({
            t: 'history_fetch',
            group: record.id,
            hid: alt.hid,
            after,
            before: null,
            limit: HISTORY_PAGE,
          });
        } catch (e) {
          console.warn(`alternate log #${channel}: ${e.message}`);
          break;
        }
        const entries = reply.entries ?? [];
        if (!entries.length) break;
        const opened = await this.openPage(record, channel, entries, alt.hid);
        // Alternate entries keep the relay's seq for decryption but must
        // not move the primary log's cursors, which page a different log.
        addEntries(
          log,
          opened.map((o) => ({ ...o, seq: undefined })),
          { server: record.id, channel }
        );
        after = entries.at(-1).seq;
      }
    }
  }

  /** Forward catch-up across every channel of a circle: what landed while
      this device was away, for the rooms it already has open. */
  async catchUpLogs(record) {
    let total = 0;
    for (const channel of record.channels ?? []) {
      const log = this.logs.get(logKey(record.id, channel));
      // Never opened: it loads on demand, whole, when someone looks at it.
      if (!log?.loaded) continue;
      const { added } = await this.fetchPage(record, channel, { after: log.newest });
      total += added;
    }
    if (total > 0) this.dispatch({ type: 'refreshMessages' });
  }

  /** Fold an entry that arrived live over MLS into the working copy.
      MLS authenticated the sender, so it enters as 'signed'; it is marked
      local so the relay's copy — which carries the real seq, and so is what
      a redaction can name — supersedes it when the page arrives. */
  applyLiveEntry(serverId, channel, entry) {
    if (!entry.sender || !entry.ts) return;
    addLocalEntry(this.channelLog(serverId, channel), entry, { server: serverId, channel });
    this.dispatch({ type: 'refreshMessages' });
  }

  /** Move a channel's working copy when the channel is renamed. */
  renameChannelLog(serverId, from, to) {
    const log = this.logs.get(logKey(serverId, from));
    if (!log) return;
    for (const m of log.base.values()) m.channel = to;
    this.logs.delete(logKey(serverId, from));
    this.logs.set(logKey(serverId, to), log);
  }

  /** Rebuild this circle's key directory — and its member list — from the
      MLS roster, the only source for either that does not require trusting
      the relay.

      The member list is derived here rather than stored because the ratchet
      tree already answers it, and a stored copy could only be staler. That
      was true before too, but the local record was carrying one, so a
      circle survived a reload with whatever roster it last wrote down. With
      the record loaded from the relay there is no such copy — which is
      correct, and makes this the one place the roster is re-earned. */
  async refreshKeyDirectory(record) {
    if (record.restored) return; // no MLS state to ask
    try {
      const roster = await this.crypto('memberKeys', { group: record.id });
      const { changed, conflicts } = mergeKeyDirectory(record, roster);
      for (const handle of conflicts) {
        console.warn(`${handle} presents a different identity key than we had recorded`);
      }
      const members = Object.keys(roster ?? {});
      if (members.length) {
        record.members = members;
        this.dispatch({ type: 'servers', servers: this.snapshotServers() });
      }
      if (changed) {
        await this.persistCircle(record);
      }
    } catch (e) {
      console.warn(`key directory ${record.id}: ${e.message}`);
    }
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
    await this.persistDevice(record);
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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

  /** Mint a fresh room key for every channel, keeping the old ones for
      reading.

      Removing someone re-keys MLS, so they can decrypt no further *live*
      messages. The room key is a separate story: without rotation a removed
      member would keep a valid key for everything written into that channel
      afterwards — and since the log is now where messages live, that is the
      whole conversation, not a copy of it. Only the relay's ACL would stand
      in the way, and the ACL is the deliberately weak boundary — cached
      ciphertext or a hostile relay defeats it.

      Old keys are archived rather than discarded: the removed member was
      present for those entries anyway, so destroying them would punish the
      members who stayed without denying the leaver anything. Rotation is
      about the future, which is exactly what post-compromise security means.
      Returns the channels that rotated. */
  rotateHistoryKeys(record) {
    const rotated = [];
    for (const [channel, meta] of Object.entries(record.chanMeta ?? {})) {
      if (!meta?.hid || !meta?.hkey) continue;
      // Every superseded key is kept. The entries it opens are the only
      // copy of those messages, so dropping one destroys a stretch of the
      // circle's own past rather than trimming a cache.
      const archive = [meta.hkey, ...(meta.hkeys ?? [])];
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
    await this.persistCircle(record);
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
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
    this.addSystemMessage(record.id, text);
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
    await this.forgetDeviceState(serverId);
    // Drop the name too, or a push for a circle you just left still names it.
    await this.persistCircleNames();
    this.forgetCircleLogs(serverId);
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
      - Destructive envelopes fail *closed*. `chan-del` drops the room
        from the circle's shape and its working copy with it, and `chanset`
        carries retention — which the relay enforces by deleting log
        entries, so applying one from an unverified sender destroys the
        circle's messages for everyone, not just here. */
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
      // Nothing to persist: both of these are re-read on every connect, and
      // a stored copy could only ever be a staler answer than the ACL's.
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

  // === circles on the relay ===============================================
  //
  // This blob is the circles. Not a backup of them — the only copy. It
  // carries each circle's shape (name, rooms, settings, home base, pinned
  // notes), the room keys that open their logs, and the key directory that
  // says who wrote what, sealed under a key derived from the identity
  // bytes. Any device that can sign in can open it; the relay never can.
  //
  // What is deliberately NOT in it is the MLS ratchet, which is why a
  // device that loads these circles can read them and not yet send: keys
  // to the conversation are account data, the ratchet is not.
  //
  // Writes compare-and-swap on a version the relay keeps beside the blob.
  // A whole-blob overwrite from a second signed-in device is how a circle
  // silently disappears, and that is the one failure this must not have.

  /** Debounced: many mutations arrive in bursts (joins, meta floods). */
  scheduleBackup() {
    clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      this.uploadBackup().catch((e) => console.warn(`backup upload: ${e.message}`));
    }, 3000);
  }

  /**
   * Park the current circles.
   *
   * Refuses to write until a load has succeeded. Without that guard a
   * relay that answers the handshake but fails `backup_get` would leave
   * this device holding zero circles and perfectly willing to say so
   * authoritatively — one debounce later, the account's circles are gone.
   * A device that has never successfully read cannot write.
   */
  async uploadBackup() {
    if (!this.relay?.ready || !this.circlesLoaded) return;
    let servers = [...this.servers.values()].map(sharedHalf);
    let payload = await sealBackup(this.identityBytes(), { v: BACKUP_VERSION, servers });
    try {
      const ok = await this.relay.request({
        t: 'backup_set',
        payload,
        version: this.backupVersion ?? 0,
      });
      this.backupVersion = ok.version ?? this.backupVersion;
      return;
    } catch (e) {
      if (!/backup conflict/i.test(e.message ?? '')) throw e;
    }
    // Another device wrote between our read and our write. Re-read, fold
    // our circles over theirs (see `mergeBackups` for which side wins
    // what), and try once more. One retry: if we lose the swap twice, two
    // devices are writing in a tight loop and a third attempt would not
    // settle it either — the next mutation reschedules anyway.
    const parked = await this.fetchBackup();
    this.backupVersion = parked.version;
    servers = mergeBackups(servers, parked.servers);
    payload = await sealBackup(this.identityBytes(), { v: BACKUP_VERSION, servers });
    const ok = await this.relay.request({
      t: 'backup_set',
      payload,
      version: this.backupVersion ?? 0,
    });
    this.backupVersion = ok.version ?? this.backupVersion;
    // Adopt anything the merge brought in, so this device shows the circle
    // it just declined to delete rather than waiting for the next boot.
    this.adoptCircles(servers);
  }

  /** Read and open the parked blob. Returns the circles and the version
      they are at; an account with nothing parked reads as an empty list at
      version 0, which is what a first write must swap against. */
  async fetchBackup() {
    const reply = await this.relay.request({ t: 'backup_get' });
    const version = reply.version ?? 0;
    if (!reply.payload) return { servers: [], version };
    const backup = await openBackup(this.identityBytes(), reply.payload);
    // v1 predates room keys being the only copy of a conversation; it is a
    // strict subset of v2, so it opens as-is and is rewritten in v2 shape
    // by the first change. Anything newer was written by a client this one
    // does not understand — refusing is the only safe answer, since
    // writing over it would destroy whatever it knows that this does not.
    if (backup.v > BACKUP_VERSION) {
      throw new Error(
        `these circles were parked by a newer version of the app — reload before changing anything`
      );
    }
    return { servers: backup.servers ?? [], version };
  }

  /**
   * Load this account's circles from the relay.
   *
   * Runs on every connect, not just a fresh sign-in. The blob is where
   * circles live, so this is not a recovery path — it is how the app gets
   * its own state, and a device that skipped it would be running on
   * whatever it happened to remember.
   */
  async loadCircles() {
    const { servers, version } = await this.fetchBackup();
    this.backupVersion = version;
    // Set before adopting: a circle arriving here can trigger a write (a
    // freshly minted room key, a meta heal), and that write must be
    // allowed to proceed rather than being caught by the no-load guard.
    this.circlesLoaded = true;
    const fresh = this.adoptCircles(servers);
    await this.persistCircleNames();
    this.dispatch({ type: 'circlesLoading', loading: false });
    if (fresh.length) {
      for (const record of fresh) {
        if (record.restored) {
          this.addSystemMessage(
            record.id,
            `loaded from your circles on the relay — the messages are readable, but ask to be re-added before you can send`
          );
        }
      }
      this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    }
    return fresh;
  }

  /** Fold a list of shared circle halves into the in-memory records,
      pairing each with this device's own state for it. Returns the ones
      this device did not already hold. */
  adoptCircles(servers) {
    const fresh = [];
    for (const s of servers ?? []) {
      if (!s?.id || this.servers.has(s.id)) continue;
      const record = hydrate(s, this.deviceState?.[s.id]);
      // Normalizing on the way in rather than trusting the blob: it is our
      // own ciphertext, but it was written by a build that may have had a
      // different idea of what a valid overview or notice looks like.
      record.overview = normalizeOverview(s.overview);
      record.notices = (Array.isArray(s.notices) ? s.notices : [])
        .map((n) => normalizeNotice(n, n?.author))
        .filter(Boolean);
      this.servers.set(s.id, record);
      fresh.push(record);
    }
    return fresh;
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
    await this.appendLog(serverId, channel, { k: 'file', ts, file });
    await this.sendContent(serverId, { k: 'file', ch: channel, file, ts });
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
    await this.persistDevice(record);
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
    await this.persistDevice(record);
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
    await this.persistCircle(record);
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
    await this.persistCircle(record);
    await this.addSystemMessage(
      group,
      `you joined via invite link — only channels that keep history have a past here`
    );
    this.dispatch({ type: 'servers', servers: this.snapshotServers() });
    await this.relay.request({ t: 'subscribe', group, after: sent.seq });
    this.refreshRoles(group);
    this.catchUpLogs(record).catch((e) => console.warn(`log catch-up: ${e.message}`));
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
    await this.persistDevice(record);
    return sent.seq;
  }

  /** A device-local notice in a room's stream. Session-lived: it is derived
      from something this device watched happen, and writing it to the log
      would give every member their own copy of the same line. */
  addSystemMessage(serverId, text, channel = 'general') {
    const message = {
      server: serverId,
      channel,
      sender: '',
      text,
      ts: Date.now(),
      system: true,
    };
    addSystemMessage(this.channelLog(serverId, channel), message);
    this.dispatch({ type: 'newMessage', message });
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

  /**
   * The messages to render for a channel.
   *
   * Opening a room this session fetches its newest page from the relay
   * first — there is no local copy to fall back on, which is the point:
   * what you see is what the circle has, not what this device happened to
   * be awake for.
   */
  async loadMessages(serverId, channel) {
    const record = this.servers.get(serverId);
    if (!record) return [];
    const log = this.channelLog(serverId, channel);
    if (!log.loaded) {
      log.loaded = true;
      // `before` with no bound means "the newest page".
      await this.fetchPage(record, channel, { before: Number.MAX_SAFE_INTEGER });
      await this.drainAlternateLogs(record, channel).catch((e) =>
        console.warn(`alternate logs #${channel}: ${e.message}`)
      );
    }
    // Auto-delete is enforced at read time (and on setting changes) —
    // there is no background process in a browser tab to rely on.
    this.applyRetention(record, channel);
    return renderLog(log);
  }

  /** Page further back in a channel. Returns whether anything older
      remains, so the UI can retire the affordance at the start. */
  async loadOlderMessages(serverId, channel) {
    const record = this.servers.get(serverId);
    const log = this.channelLog(serverId, channel);
    if (!record || log.complete) return { more: false };
    const { complete } = await this.fetchPage(record, channel, {
      before: log.oldest ?? Number.MAX_SAFE_INTEGER,
    });
    this.dispatch({ type: 'refreshMessages' });
    return { more: !complete };
  }

  /** Whether this channel has more to show above what is on screen. */
  hasOlderMessages(serverId, channel) {
    const log = this.logs.get(logKey(serverId, channel));
    return !!log?.loaded && !log.complete;
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



