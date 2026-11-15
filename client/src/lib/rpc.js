// RPC client for the crypto worker.
//
// `WorkerImpl` is injected so the failure paths can be driven in a test. They
// are the ones worth covering: a worker that never starts used to leave
// `boot()` awaiting forever, so the user sat on the splash screen with no
// error and no way back — the failure mode you cannot debug from a bug report.
export function createCrypto({ WorkerImpl = globalThis.Worker } = {}) {
  const worker = new WorkerImpl('/worker.js', { type: 'module' });
  let nextId = 1;
  const pending = new Map();
  // Set once the worker or its wasm fails to load. Every in-flight call is
  // rejected and every later one fails fast: previously nothing rejected
  // these promises, so a failed wasm load left boot() awaiting forever and
  // the user staring at the splash with no error and no way back.
  let dead = null;

  // The person gets a plain sentence; the underlying cause rides along as
  // `cause` and in the console, where a bug report can find it.
  const killAll = (message, cause) => {
    dead = new Error(message, { cause });
    if (cause) console.error(`crypto worker: ${cause}`);
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
    killAll('The encryption worker failed to start. Try reloading.', e.message ?? 'unknown error');
  // Fired when a module worker's static imports (crypto_core.js, and the
  // wasm it pulls in) cannot be resolved — the common real-world failure.
  worker.onmessageerror = () => killAll('The encryption worker sent an unreadable message. Try reloading.');

  return (cmd, args = {}) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, ...args });
    });
}
