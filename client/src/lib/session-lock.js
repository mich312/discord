// One tab at a time.
//
// Every tab of this origin shares one IndexedDB, and so one MLS ratchet. Two
// tabs each load that ratchet into their own worker and advance their own
// copy: both encrypt their next message under the same generation, so the
// second one to arrive cannot be opened by anybody ("the requested secret
// was deleted"), and each tab then writes its snapshot over the other's.
// Nothing on screen said any of this. Both tabs showed a green dot, messages
// sent from one of them silently never arrived, and which tab's ratchet
// survived a reload was whichever wrote last.
//
// A ratchet cannot be shared, so the session is not: a Web Lock, held for as
// long as the tab runs it. A second tab is told the app is open elsewhere
// and offered the session; taking it asks the holder to stop (it disconnects
// and stops writing before it lets go) and, if the holder is frozen and
// never answers, takes the lock anyway.
//
// Browsers without Web Locks (Safari before 15.4) run unguarded, exactly as
// every browser did before this existed.

const NAME = 'quorum-session';
/** How long a holder gets to stop cleanly before the lock is taken from it. */
const HANDOVER_MS = 2500;

export class SessionLock {
  /**
   * @param {{locks?: LockManager, Channel?: typeof BroadcastChannel,
   *          onSuperseded?: () => (void|Promise<void>), handoverMs?: number}} opts
   *   `onSuperseded` runs in the holding tab when another tab takes the
   *   session. It must stop everything that touches the ratchet; the lock is
   *   released only after it settles.
   */
  constructor({
    locks = globalThis.navigator?.locks,
    Channel = globalThis.BroadcastChannel,
    onSuperseded = () => {},
    handoverMs = HANDOVER_MS,
  } = {}) {
    this.locks = locks?.request ? locks : null;
    this.channel = this.locks && Channel ? new Channel(NAME) : null;
    this.onSuperseded = onSuperseded;
    this.handoverMs = handoverMs;
    this.held = false;
    this.release = null;
    if (this.channel) {
      this.channel.onmessage = ({ data }) => {
        if (data === 'takeover' && this.held) this.yield();
      };
    }
  }

  /** Whether this browser can guard the session at all. */
  get supported() {
    return !!this.locks;
  }

  /** Hold the lock from inside a `locks.request` callback until released. */
  #hold(resolve) {
    this.held = true;
    resolve(true);
    return new Promise((done) => {
      this.release = done;
    });
  }

  /** Take the session if nobody has it. Resolves to whether this tab now
      runs it. Never waits. */
  tryAcquire() {
    if (!this.locks) {
      this.held = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.locks
        .request(NAME, { ifAvailable: true }, (lock) => (lock ? this.#hold(resolve) : resolve(false)))
        // A stolen lock rejects the holder's request: that IS being superseded.
        .catch(() => this.yield());
    });
  }

  /** Take the session from whichever tab has it. Asks first; insists after
      `handoverMs`. Resolves once this tab holds it. */
  takeOver() {
    if (!this.locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const got = (value) => {
        if (settled) return undefined;
        settled = true;
        clearTimeout(timer);
        return this.#hold(() => resolve(value));
      };
      this.channel?.postMessage('takeover');
      // Queued behind the holder: granted the moment it lets go.
      const queued = new AbortController();
      this.locks
        .request(NAME, { signal: queued.signal }, () => got(true))
        .catch(() => {});
      // A frozen or crashed holder never will. Its ratchet copy is stale the
      // moment this tab starts, so there is nothing left for it to protect.
      const timer = setTimeout(() => {
        if (settled) return;
        queued.abort();
        this.locks
          .request(NAME, { steal: true }, () => got(true))
          .catch(() => this.yield());
      }, this.handoverMs);
    });
  }

  /** Another tab is taking the session: stop, then let go. */
  async yield() {
    if (!this.held) return;
    this.held = false;
    try {
      await this.onSuperseded();
    } finally {
      this.release?.();
      this.release = null;
    }
  }
}
