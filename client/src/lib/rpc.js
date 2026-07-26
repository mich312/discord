// RPC client for the crypto worker.
export function createCrypto() {
  const worker = new Worker('/worker.js', { type: 'module' });
  let nextId = 1;
  const pending = new Map();
  // Set once the worker or its wasm fails to load. Every in-flight call is
  // rejected and every later one fails fast: previously nothing rejected
  // these promises, so a failed wasm load left boot() awaiting forever and
  // the user staring at the splash with no error and no way back.
  let dead = null;

  const killAll = (message) => {
    dead = new Error(message);
    for (const [, p] of pending) p.reject(dead);
    pending.clear();
  };

  worker.onmessage = ({ data }) => {
    const { id, ok, result, error } = data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) =>
    killAll(`the encryption worker failed to start: ${e.message ?? 'unknown error'}`);
  // Fired when a module worker's static imports (crypto_core.js, and the
  // wasm it pulls in) cannot be resolved — the common real-world failure.
  worker.onmessageerror = () => killAll('the encryption worker sent an unreadable message');

  return (cmd, args = {}) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, ...args });
    });
}
