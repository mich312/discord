import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { openDb } from './lib/db.js';
import { createCrypto } from './lib/rpc.js';
import { Controller } from './lib/controller.js';
import { parseInviteUrl } from './lib/invite.js';
import Modal from './components/Modal.jsx';
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
  modal: null, // invite | identity | safety | secure
  voice: { active: null, connections: {}, presence: {} },
  vault: { kind: undefined, securedLocal: true }, // kind: undefined=unknown, null=none
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
    case 'modal':
      return { ...state, modal: action.modal };
    case 'voice':
      return { ...state, voice: action.state };
    case 'vault':
      return { ...state, vault: { kind: action.kind, securedLocal: action.securedLocal } };
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const controllerRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // Default: same origin (single-container mode, relay serves this page).
    // Dev setups (vite on another port) pass ?relay=ws://localhost:9601/ws.
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const relayUrl = params.get('relay') ?? `${wsProto}://${location.host}/ws`;
    const controller = new Controller({
      db: null,
      crypto: createCrypto(),
      dispatch,
      relayUrl,
    });
    const invite = parseInviteUrl(location);
    if (invite) controller.setPendingInvite(invite);
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

  const unsecured = state.vault.kind === null && !state.vault.securedLocal;

  return (
    <div className="app-shell">
      {unsecured && (
        <div className="secure-banner" data-testid="secure-banner">
          <span>
            this account exists only in this browser — lose it and <strong>{state.me}</strong> is
            gone forever
          </span>
          <button
            className="button"
            data-testid="secure-now"
            onClick={() => dispatch({ type: 'modal', modal: { type: 'secure' } })}
          >
            secure account
          </button>
        </div>
      )}
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
            onInvite={async () => {
              try {
                const url = await controllerRef.current.createInvite(server);
                dispatch({ type: 'modal', modal: { type: 'invite', url } });
              } catch (e) {
                dispatch({ type: 'toast', text: e.message });
              }
            }}
            onIdentity={() =>
              dispatch({
                type: 'modal',
                modal: { type: 'identity', key: controllerRef.current.identityKeyString() },
              })
            }
            voice={state.voice}
            onVoiceJoin={(ch) =>
              controllerRef.current.voice
                .join(server, ch)
                .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
            }
            onVoiceLeave={() => controllerRef.current.voice.leave()}
            onAlerts={async () => {
              try {
                await controllerRef.current.enableNotifications();
                dispatch({ type: 'toast', text: 'push notifications enabled for this device' });
              } catch (e) {
                dispatch({ type: 'toast', text: `notifications: ${e.message}` });
              }
            }}
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
            onSendFile={(file) =>
              controllerRef.current
                .sendFile(server, channel, file)
                .catch((e) => dispatch({ type: 'toast', text: e.message }))
            }
            fetchFile={(file) => controllerRef.current.fetchFile(file)}
          />
          <Members
            server={activeServer}
            me={state.me}
            onAdd={(user) =>
              controllerRef.current
                .addMember(server, user)
                .catch((e) => dispatch({ type: 'toast', text: e.message }))
            }
            onMember={async (peer) => {
              try {
                const number = await controllerRef.current.safetyNumber(server, peer);
                dispatch({
                  type: 'modal',
                  modal: {
                    type: 'safety',
                    server,
                    peer,
                    number,
                    verified: (activeServer.verified ?? []).includes(peer),
                  },
                });
              } catch (e) {
                dispatch({ type: 'toast', text: e.message });
              }
            }}
          />
        </>
      ) : (
        <div className="empty-state">
          <div>
            <h2>no servers yet</h2>
            <p className="muted">
              create one from the rail, follow an invite link, or ask someone to add you —
              they need your handle: <strong>{state.me}</strong>
            </p>
            <div className="row centered-row">
              <button
                className="button"
                data-testid="identity-open-empty"
                onClick={() =>
                  dispatch({
                    type: 'modal',
                    modal: { type: 'identity', key: controllerRef.current.identityKeyString() },
                  })
                }
              >
                identity key
              </button>
              <button
                className="button"
                data-testid="secure-open-empty"
                onClick={() => dispatch({ type: 'modal', modal: { type: 'secure' } })}
              >
                secure account
              </button>
            </div>
          </div>
        </div>
      )}
      {state.toast && <div className="toast">{state.toast}</div>}
      {state.modal && (
        <Modal
          modal={state.modal}
          onClose={() => dispatch({ type: 'modal', modal: null })}
          onVerify={async (srv, peer) => {
            await controllerRef.current.markVerified(srv, peer);
            dispatch({ type: 'modal', modal: null });
            dispatch({ type: 'toast', text: `${peer} marked as verified` });
          }}
          onSecurePasskey={async () => {
            await controllerRef.current.secureWithPasskey();
            dispatch({ type: 'modal', modal: null });
            dispatch({ type: 'toast', text: 'account secured with a passkey' });
          }}
          onSecurePassword={async (password) => {
            await controllerRef.current.secureWithPassword(password);
            dispatch({ type: 'modal', modal: null });
            dispatch({ type: 'toast', text: 'account secured with a password' });
          }}
          onSecureFile={async () => {
            await controllerRef.current.markSecuredLocal();
            dispatch({ type: 'toast', text: 'key file downloaded — store it safely' });
          }}
          identityKey={controllerRef.current?.identityKeyString()}
        />
      )}
      </div>
    </div>
  );
}
