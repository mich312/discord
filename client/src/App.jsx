import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { openDb } from './lib/db.js';
import { createCrypto } from './lib/rpc.js';
import { Controller } from './lib/controller.js';
import Onboarding from './components/Onboarding.jsx';
import Rail from './components/Rail.jsx';
import Channels from './components/Channels.jsx';
import Messages from './components/Messages.jsx';
import Members from './components/Members.jsx';

const initial = {
  phase: 'loading', // loading | onboarding | ready
  me: null,
  servers: [],
  active: { server: null, channel: null },
  messages: [], // active channel only
  connection: 'connecting',
  toast: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'phase':
      return { ...state, phase: action.phase };
    case 'booted': {
      const first = action.servers[0];
      return {
        ...state,
        phase: 'ready',
        me: action.me,
        servers: action.servers,
        active: first
          ? { server: first.id, channel: first.channels[0] }
          : { server: null, channel: null },
      };
    }
    case 'servers': {
      let active = state.active;
      if (!active.server && action.servers.length > 0) {
        active = { server: action.servers[0].id, channel: action.servers[0].channels[0] };
      }
      return { ...state, servers: action.servers, active };
    }
    case 'select':
      return { ...state, active: { server: action.server, channel: action.channel } };
    case 'messages':
      return { ...state, messages: action.messages };
    case 'newMessage': {
      const { server, channel } = state.active;
      if (action.message.server === server && action.message.channel === channel) {
        return { ...state, messages: [...state.messages, action.message] };
      }
      return state;
    }
    case 'connection':
      return { ...state, connection: action.status };
    case 'toast':
      return { ...state, toast: action.text };
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const controllerRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const relayUrl = params.get('relay') ?? `ws://${location.hostname}:9601/ws`;
    const controller = new Controller({
      db: null,
      crypto: createCrypto(),
      dispatch,
      relayUrl,
    });
    controllerRef.current = controller;
    openDb().then((db) => {
      controller.db = db;
      controller.boot().catch((e) => dispatch({ type: 'toast', text: e.message }));
    });
  }, []);

  // Load history whenever the active channel changes.
  const { server, channel } = state.active;
  useEffect(() => {
    if (!server || !channel) return;
    controllerRef.current
      .loadMessages(server, channel)
      .then((messages) => dispatch({ type: 'messages', messages }));
  }, [server, channel]);

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!state.toast) return;
    const t = setTimeout(() => dispatch({ type: 'toast', text: null }), 5000);
    return () => clearTimeout(t);
  }, [state.toast]);

  const activeServer = useMemo(
    () => state.servers.find((s) => s.id === server) ?? null,
    [state.servers, server]
  );

  if (state.phase === 'loading') {
    return <div className="centered muted">loading…</div>;
  }
  if (state.phase === 'onboarding') {
    return <Onboarding controller={controllerRef.current} />;
  }

  return (
    <div className="app">
      <Rail
        servers={state.servers}
        active={server}
        connection={state.connection}
        onSelect={(id) => {
          const s = state.servers.find((x) => x.id === id);
          dispatch({ type: 'select', server: id, channel: s.channels[0] });
        }}
        onCreate={async (name) => {
          const id = await controllerRef.current.createServer(name);
          dispatch({ type: 'select', server: id, channel: 'general' });
        }}
      />
      {activeServer ? (
        <>
          <Channels
            server={activeServer}
            activeChannel={channel}
            me={state.me}
            connection={state.connection}
            onSelect={(ch) => dispatch({ type: 'select', server, channel: ch })}
            onCreate={(ch) => controllerRef.current.createChannel(server, ch)}
          />
          <Messages
            key={`${server}/${channel}`}
            server={activeServer}
            channel={channel}
            me={state.me}
            messages={state.messages}
            onSend={(text) =>
              controllerRef.current
                .sendChat(server, channel, text)
                .catch((e) => dispatch({ type: 'toast', text: e.message }))
            }
          />
          <Members
            server={activeServer}
            me={state.me}
            onAdd={(user) =>
              controllerRef.current
                .addMember(server, user)
                .catch((e) => dispatch({ type: 'toast', text: e.message }))
            }
          />
        </>
      ) : (
        <div className="empty-state">
          <div>
            <h2>no servers yet</h2>
            <p className="muted">
              create one from the rail, or ask someone to add you — they need your
              handle: <strong>{state.me}</strong>
            </p>
          </div>
        </div>
      )}
      {state.toast && <div className="toast">{state.toast}</div>}
    </div>
  );
}
