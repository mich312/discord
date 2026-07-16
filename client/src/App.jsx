import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { openDb } from './lib/db.js';
import { createCrypto } from './lib/rpc.js';
import { Controller } from './lib/controller.js';
import { parseInviteUrl } from './lib/invite.js';
import Modal from './components/Modal.jsx';
import Onboarding from './components/Onboarding.jsx';
import Masthead from './components/Masthead.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Rail from './components/Rail.jsx';
import Channels from './components/Channels.jsx';
import Messages from './components/Messages.jsx';
import Members from './components/Members.jsx';
import CallPanel from './components/CallPanel.jsx';
import Settings from './components/Settings.jsx';
import Seal from './components/Seal.jsx';
import { Key, Bell, ShieldCheck, LinkGlyph, Sun, QuorumGlyph, Gear } from './components/icons.jsx';

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
  globalAdmin: false, // relay-side flag (RELAY_ADMINS)
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
    case 'admin':
      return { ...state, globalAdmin: action.globalAdmin };
    default:
      return state;
  }
}

// Theme is a device preference, not account state — plain localStorage.
// ('vellum' is accepted for continuity with the previous theme naming.)
function loadTheme() {
  try {
    const v = localStorage.getItem('quorum-theme');
    return v === 'paper' || v === 'vellum' ? 'paper' : 'carbon';
  } catch {
    return 'carbon';
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [theme, setTheme] = useState(loadTheme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Narrow-screen drawers: the sidebar and roster slide over the messages
  // pane instead of flanking it. null | 'nav' | 'roster'; CSS ignores this
  // entirely on wide screens, where both panels are static.
  const [drawer, setDrawer] = useState(null);
  const controllerRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Keep the browser/OS chrome (Android address bar, iOS standalone
    // status bar) in step with the app surface.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'paper' ? '#e6e4dd' : '#0e0e0f');
    try {
      localStorage.setItem('quorum-theme', theme);
    } catch {
      // private mode etc. — the toggle still works for this session
    }
  }, [theme]);

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

  // ⌘K / Ctrl+K opens the palette anywhere inside the app; Escape closes
  // an open drawer.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') setDrawer(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Anything that opens above the workspace (modal, palette) takes over
  // from a drawer — never stack the two.
  useEffect(() => {
    if (state.modal || paletteOpen) setDrawer(null);
  }, [state.modal, paletteOpen]);

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

  // Web Crypto (crypto.subtle) is only exposed in a secure context. Served
  // over plain HTTP off localhost it is undefined, so every identity,
  // recovery, and vault operation throws a cryptic "undefined is not an
  // object (evaluating 'crypto.subtle…')". Surface the real requirement.
  if (!window.isSecureContext || !window.crypto?.subtle) {
    return (
      <div className="centered">
        <div className="card" data-testid="insecure-context">
          <h1>Needs a secure connection</h1>
          <p className="muted lede">
            quorum generates and unlocks your keys with the browser's Web Crypto
            API, which browsers only expose over a secure connection. This page
            is being served over plain <strong>http://</strong>.
          </p>
          <p className="muted">
            Serve it over <strong>https://</strong> (terminate TLS in front of
            the relay), or use <strong>http://localhost</strong> for local
            testing.
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === 'loading') {
    return <div className="centered muted">loading…</div>;
  }
  if (state.phase === 'onboarding') {
    return <Onboarding controller={controllerRef.current} />;
  }

  const unsecured = state.vault.kind === null && !state.vault.securedLocal;
  // Admin of the active circle (or a global admin): may add members,
  // create invites, and change roles. Relay-enforced; this only gates UI.
  const canManage =
    state.globalAdmin || (activeServer && activeServer.roles?.[state.me] === 'admin');

  const openIdentity = () =>
    dispatch({
      type: 'modal',
      modal: { type: 'identity', key: controllerRef.current.identityKeyString() },
    });
  const openSecure = () => dispatch({ type: 'modal', modal: { type: 'secure' } });
  const openSettings = () => dispatch({ type: 'modal', modal: { type: 'settings' } });
  const openInvite = async () => {
    try {
      const url = await controllerRef.current.createInvite(server);
      dispatch({ type: 'modal', modal: { type: 'invite', url } });
    } catch (e) {
      dispatch({ type: 'toast', text: e.message });
    }
  };
  const enableAlerts = async () => {
    try {
      await controllerRef.current.enableNotifications();
      dispatch({ type: 'toast', text: 'push notifications enabled for this device' });
    } catch (e) {
      dispatch({ type: 'toast', text: `notifications: ${e.message}` });
    }
  };

  const openAdminOverview = async () => {
    try {
      const reply = await controllerRef.current.adminList();
      dispatch({
        type: 'modal',
        modal: { type: 'admin', users: reply.users, groups: reply.groups },
      });
    } catch (e) {
      dispatch({ type: 'toast', text: e.message });
    }
  };

  const paletteActions = [
    ...(activeServer && canManage
      ? [{ id: 'act:invite', label: 'create invite link', hint: 'action', glyph: <LinkGlyph />, run: openInvite }]
      : []),
    ...(state.globalAdmin
      ? [{ id: 'act:admin', label: 'relay admin overview', hint: 'action', glyph: <ShieldCheck />, run: openAdminOverview }]
      : []),
    { id: 'act:settings', label: 'open settings', hint: 'action', glyph: <Gear />, run: openSettings },
    { id: 'act:identity', label: 'show identity key', hint: 'action', glyph: <Key />, run: openIdentity },
    { id: 'act:secure', label: 'secure this account', hint: 'action', glyph: <ShieldCheck />, run: openSecure },
    {
      id: 'act:theme',
      label: theme === 'paper' ? 'switch to carbon (dark)' : 'switch to paper (light)',
      hint: 'action',
      glyph: <Sun />,
      run: () => setTheme((t) => (t === 'paper' ? 'carbon' : 'paper')),
    },
  ];

  return (
    <div className="app-shell" data-drawer={drawer ?? undefined}>
      <Masthead
        server={activeServer}
        connection={state.connection}
        theme={theme}
        canInvite={canManage}
        onInvite={openInvite}
        onPalette={() => setPaletteOpen(true)}
        onTheme={() => setTheme((t) => (t === 'paper' ? 'carbon' : 'paper'))}
        onMenu={() => setDrawer((d) => (d === 'nav' ? null : 'nav'))}
        onRoster={() => setDrawer((d) => (d === 'roster' ? null : 'roster'))}
      />
      {unsecured && (
        <div className="secure-banner" data-testid="secure-banner">
          <Key size={14} />
          <span>
            this account exists only in this browser — lose it and <strong>{state.me}</strong> is
            gone forever
          </span>
          <button className="button" data-testid="secure-now" onClick={openSecure}>
            secure account
          </button>
        </div>
      )}
      <div className="app">
        {drawer && (
          <div
            className="drawer-backdrop"
            data-testid="drawer-backdrop"
            onClick={() => setDrawer(null)}
          />
        )}
        <nav className="sidebar">
          <Rail
            servers={state.servers}
            active={server}
            onSelect={(id) => {
              const s = state.servers.find((x) => x.id === id);
              dispatch({ type: 'select', server: id, channel: s.channels[0] });
              setDrawer(null);
            }}
            onCreate={async (name) => {
              const id = await controllerRef.current.createServer(name);
              dispatch({ type: 'select', server: id, channel: 'general' });
              setDrawer(null);
            }}
          />
          {activeServer && (
            <Channels
              server={activeServer}
              activeChannel={channel}
              me={state.me}
              onSelect={(ch) => {
                dispatch({ type: 'select', server, channel: ch });
                setDrawer(null);
              }}
              onCreate={(ch) => controllerRef.current.createChannel(server, ch)}
              onVoiceCreate={(ch) => controllerRef.current.createVoiceChannel(server, ch)}
              voice={state.voice}
              onVoiceJoin={(ch) =>
                controllerRef.current.voice
                  .join(server, ch)
                  .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
              }
              onVoiceLeave={() => controllerRef.current.voice.leave()}
            />
          )}
          <div className="self-card">
            <Seal name={state.me} size={32} title={state.me} />
            <span className="who">
              <span className="handle" data-testid="self-name">{state.me}</span>
              <span className={`status ${state.connection}`}>{state.connection}</span>
            </span>
            <button className="icon-btn" title="identity key" data-testid="identity-open" onClick={openIdentity}>
              <Key size={14} />
            </button>
            <button className="icon-btn" title="enable push notifications" data-testid="enable-notifications" onClick={enableAlerts}>
              <Bell size={14} />
            </button>
            <button className="icon-btn" title="settings" data-testid="open-settings" onClick={openSettings}>
              <Gear size={14} />
            </button>
          </div>
        </nav>
        {activeServer ? (
          <>
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
              canManage={canManage}
              onCall={(peer) => {
                setDrawer(null);
                controllerRef.current.voice
                  .callUser(server, peer)
                  .catch((e) => dispatch({ type: 'toast', text: `call: ${e.message}` }));
              }}
              onAdd={(user) =>
                controllerRef.current
                  .addMember(server, user)
                  .catch((e) => dispatch({ type: 'toast', text: e.message }))
              }
              onSetRole={(user, role) =>
                controllerRef.current
                  .setRole(server, user, role)
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
              <div className="glyph-lg">
                <QuorumGlyph size={44} />
              </div>
              <h2>No circles yet</h2>
              <p className="muted">
                Start one from the sidebar, follow an invite link, or ask someone to add you —
                they need your handle: <strong>{state.me}</strong>
              </p>
              <div className="row">
                <button className="button" data-testid="identity-open-empty" onClick={openIdentity}>
                  <Key size={14} />
                  identity key
                </button>
                <button className="button" data-testid="secure-open-empty" onClick={openSecure}>
                  <ShieldCheck size={14} />
                  secure account
                </button>
              </div>
            </div>
          </div>
        )}
        <CallPanel
          voice={state.voice}
          me={state.me}
          onAccept={() =>
            controllerRef.current.voice
              .acceptRing()
              .catch((e) => dispatch({ type: 'toast', text: `call: ${e.message}` }))
          }
          onDecline={() => controllerRef.current.voice.declineRing()}
          onCancel={() => controllerRef.current.voice.cancelCall()}
          onHangup={() => controllerRef.current.voice.leave()}
        />
        {state.toast && <div className="toast">{state.toast}</div>}
        {state.modal?.type === 'settings' && (
          <Settings
            me={state.me}
            theme={theme}
            onTheme={() => setTheme((t) => (t === 'paper' ? 'carbon' : 'paper'))}
            onEnableNotifications={() => controllerRef.current.enableNotifications()}
            voice={controllerRef.current?.voice}
            secured={!unsecured}
            onShowIdentity={openIdentity}
            onSecure={openSecure}
            onClose={() => dispatch({ type: 'modal', modal: null })}
          />
        )}
        {state.modal && state.modal.type !== 'settings' && (
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
        {paletteOpen && (
          <CommandPalette
            servers={state.servers}
            active={server}
            actions={paletteActions}
            onNavigate={(srv, ch) => dispatch({ type: 'select', server: srv, channel: ch })}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
