// Phase-1 stub relay: a dumb fan-out over WebSocket. It parses only the
// JSON envelope (never the MLS payload, which stays an opaque base64 blob)
// and forwards to everyone else — or to a single named client when `to`
// is set (Welcomes are addressed, everything else is broadcast).
//
// Deliberately missing (Phase 2 work): auth, persistence, ordering
// guarantees across reconnects, KeyPackage storage.
import { WebSocketServer } from 'ws';

const port = Number(process.env.RELAY_PORT ?? 9601);
const wss = new WebSocketServer({ port });

// name -> socket, set by the client's initial {type:"hello"} envelope
const clients = new Map();

wss.on('connection', (ws) => {
  let name = null;

  ws.on('message', (data) => {
    let envelope;
    try {
      envelope = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (envelope.type === 'hello' && typeof envelope.from === 'string') {
      name = envelope.from;
      clients.set(name, ws);
      return;
    }
    if (!name) return; // no hello, no service

    const raw = JSON.stringify(envelope);
    if (envelope.to) {
      const target = clients.get(envelope.to);
      if (target && target.readyState === target.OPEN) target.send(raw);
      return;
    }
    for (const [peer, sock] of clients) {
      if (peer !== name && sock.readyState === sock.OPEN) sock.send(raw);
    }
  });

  ws.on('close', () => {
    if (name && clients.get(name) === ws) clients.delete(name);
  });
});

console.log(`relay listening on ws://127.0.0.1:${port}`);
