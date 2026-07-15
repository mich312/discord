// RPC client for the crypto worker.
export function createCrypto() {
  const worker = new Worker('/worker.js', { type: 'module' });
  let nextId = 1;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const { id, ok, result, error } = data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  return (cmd, args = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, ...args });
    });
}
