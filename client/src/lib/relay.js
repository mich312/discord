// Relay connection: auth handshake, rid-correlated requests, server events,
// automatic reconnect with backoff. Crypto is injected (sign/pubkey come
// from the worker); this file never touches key material.
export const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

const AUTH_CONTEXT = 'relay-auth-v1';

export class Relay {
  /**
   * @param {{url: string, name: string, getPubkey: () => Promise<Uint8Array>,
   *          sign: (bytes: Uint8Array) => Promise<Uint8Array>,
   *          getInvite?: () => string|null,
   *          onAuthError?: (message: string) => void,
   *          onEvent: (msg: any) => void,
   *          onStatus: (status: 'online'|'offline'|'connecting') => void}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.ready = false;
    this.nextRid = 1;
    this.pending = new Map();
    this.backoff = 500;
    this.closed = false;
  }

  connect() {
    if (this.closed) return;
    this.opts.onStatus('connecting');
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = async () => {
      const pubkey = await this.opts.getPubkey();
      // First-time registration on an invite-only relay must present a
      // usable invite id; pinned users are admitted regardless.
      const invite = this.opts.getInvite?.() ?? null;
      ws.send(JSON.stringify({ t: 'hello', user: this.opts.name, pubkey: b64.enc(pubkey), invite }));
    };

    ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);
      // An error before `ready` is a handshake refusal (invite-only
      // registration, or the handle is pinned to another key). Retrying
      // the same handshake can't succeed — stop reconnecting.
      if (msg.t === 'error' && !this.ready) {
        this.closed = true;
        this.opts.onAuthError?.(msg.message);
        return;
      }
      if (msg.t === 'challenge') {
        const nonce = b64.dec(msg.nonce);
        const context = new TextEncoder().encode(AUTH_CONTEXT);
        const signed = new Uint8Array([...context, ...nonce]);
        const sig = await this.opts.sign(signed);
        ws.send(JSON.stringify({ t: 'auth', sig: b64.enc(sig) }));
        return;
      }
      if (msg.t === 'ready') {
        this.ready = true;
        this.backoff = 500;
        this.opts.onStatus('online');
        this.opts.onEvent(msg);
        return;
      }
      if (msg.rid !== undefined && this.pending.has(msg.rid)) {
        const { resolve, reject } = this.pending.get(msg.rid);
        this.pending.delete(msg.rid);
        msg.t === 'error' ? reject(new Error(msg.message)) : resolve(msg);
        return;
      }
      this.opts.onEvent(msg);
    };

    ws.onclose = () => {
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(new Error('connection lost'));
      this.pending.clear();
      this.opts.onStatus('offline');
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15000);
      }
    };
  }

  request(msg) {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error('offline'));
      const rid = this.nextRid++;
      this.pending.set(rid, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, rid }));
    });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
