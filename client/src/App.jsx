import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { openDb } from './lib/db.js';
import { createCrypto } from './lib/rpc.js';
import { Controller } from './lib/controller.js';
import { parseInviteUrl } from './lib/invite.js';
import { parseLinkUrl, verifyCode } from './lib/link.js';
import Modal from './components/Modal.jsx';
import Onboarding from './components/Onboarding.jsx';
import Masthead from './components/Masthead.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Rail from './components/Rail.jsx';
import Channels from './components/Channels.jsx';
import Messages from './components/Messages.jsx';
import Overview from './components/Overview.jsx';
import Members from './components/Members.jsx';
import CallPanel from './components/CallPanel.jsx';
import CallStage from './components/CallStage.jsx';
import GameStage from './components/GameStage.jsx';
import { callChatChannel } from './lib/controller.js';
import Settings from './components/Settings.jsx';
import Seal from './components/Seal.jsx';
import { Key, ShieldCheck, LinkGlyph, Sun, QuorumGlyph, Gear, LogOut } from './components/icons.jsx';
import { markPlayed, bumpPlayCount } from './lib/games.js';

/** Content identity of a message for merging a load snapshot with live
    arrivals — same idea as history.js's fingerprint, plus the system flag. */
function messageKey(m) {
  const body = m.file ? `f:${m.file.blob}` : m.game ? `g:${m.game.id}` : `t:${m.text ?? ''}`;
  return `${m.system ? 's' : 'm'}|${m.sender}|${m.ts}|${body}`;
}

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
  messagesRev: 0, // bumped when stored messages changed outside the live path (backfill, prune)
};

function reducer(state, action) {
  switch (action.type) {
    case 'phase':
      return { ...state, phase: action.phase };
    case 'booted': {
      // Land on the first circle's overview page (channel: null), not in a
      // room — the landing zone is the front door.
      const first = action.servers[0];
      return {
        ...state,
        phase: 'ready',
        me: action.me,
        servers: action.servers,
        active: first
          ? { server: first.id, channel: null }
          : { server: null, channel: null },
      };
    }
    case 'servers': {
      let active = state.active;
      if (!active.server && action.servers.length > 0) {
        active = { server: action.servers[0].id, channel: null };
      } else if (active.server) {
        const srv = action.servers.find((s) => s.id === active.server);
        if (!srv) {
          // The active circle vanished out from under us (we left it, it was
          // deleted, or we were removed): land on the first remaining circle,
          // or the empty state if none are left.
          const first = action.servers[0];
          active = first
            ? { server: first.id, channel: null }
            : { server: null, channel: null };
        } else if (active.channel && !srv.channels.includes(active.channel)) {
          // The active channel was renamed or deleted out from under us —
          // fall back to the first remaining channel so the view isn't stranded.
          active = { ...active, channel: srv.channels[0] };
        }
      }
      return { ...state, servers: action.servers, active };
    }
    case 'select': {
      const same =
        state.active.server === action.server && state.active.channel === action.channel;
      return {
        ...state,
        active: { server: action.server, channel: action.channel },
        // Switching rooms clears the pane: rendering the old room's
        // messages until the new load resolves invites cross-channel
        // flashes and races the live-append path below.
        messages: same ? state.messages : [],
      };
    }
    case 'messages': {
      // A load snapshot can resolve late (fast channel switching) or early
      // (a live message committed after the snapshot read). Ignore loads
      // for rooms we've moved away from, and keep live arrivals the
      // snapshot missed instead of replacing them away.
      if (action.server !== state.active.server || action.channel !== state.active.channel) {
        return state;
      }
      const seen = new Set(action.messages.map(messageKey));
      const missed = state.messages.filter(
        (m) =>
          m.server === action.server && m.channel === action.channel && !seen.has(messageKey(m))
      );
      const merged = [...action.messages, ...missed].sort((a, b) => a.ts - b.ts);
      return { ...state, messages: merged };
    }
    case 'newMessage': {
      const { server, channel } = state.active;
      if (action.message.server === server && action.message.channel === channel) {
        // Sender clocks skew: keep the pane sorted the same way a reload
        // sorts, or day dividers and grouping drift until the next load.
        const merged = [...state.messages, action.message].sort((a, b) => a.ts - b.ts);
        return { ...state, messages: merged };
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
    case 'refreshMessages':
      return { ...state, messagesRev: state.messagesRev + 1 };
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
  // The call stage takes over the main pane while set: bubbles for everyone
  // in the call, the shared screen, and the call's own chat thread (the
  // active channel becomes `voice:<room>` so the message machinery follows).
  const [stage, setStage] = useState(false);
  // A web game from the shelf, playing in the main pane with the room's
  // chat (and the call, if one is on) docked beside it.
  const [game, setGame] = useState(null);
  // Where to land when the stage closes — the text channel we came from.
  const stageReturn = useRef(null);
  const controllerRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Keep the browser/OS chrome (Android address bar, iOS standalone
    // status bar) in step with the app surface.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'paper' ? '#e9e6e0' : '#09090a');
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

  // Sending side of device-linking: a signed-in device opened with a link URL
  // (?link=…#k=…) offers to hand its identity to the new device that showed it.
  useEffect(() => {
    if (state.phase !== 'ready') return;
    const link = parseLinkUrl(location);
    if (!link) return;
    verifyCode(link.pub).then((code) => {
      dispatch({ type: 'modal', modal: { type: 'link-send', blobId: link.blobId, pub: link.pub, code } });
    });
  }, [state.phase]);

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

  // In-call hotkey: M toggles mute. Ignored while typing (composer, search)
  // or with a modifier held, so it never eats a keystroke meant for text or
  // a browser shortcut.
  useEffect(() => {
    function onKey(e) {
      if (!state.voice.active) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'm') {
        e.preventDefault();
        controllerRef.current.voice.setMuted(!state.voice.muted);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.voice.active, state.voice.muted]);

  // Anything that opens above the workspace (modal, palette) takes over
  // from a drawer — never stack the two.
  useEffect(() => {
    if (state.modal || paletteOpen) setDrawer(null);
  }, [state.modal, paletteOpen]);

  // Device-local unread counts for the sidebar pills — same digest the
  // hub uses, keyed on everything that can move it.
  const [unreads, setUnreads] = useState({});
  // Load history whenever the active channel changes — or when stored
  // messages changed underneath us (history backfill, auto-delete prune).
  const { server, channel } = state.active;
  useEffect(() => {
    if (!server || !channel) return;
    let alive = true;
    controllerRef.current
      .loadMessages(server, channel)
      .then((messages) => alive && dispatch({ type: 'messages', messages, server, channel }));
    return () => {
      alive = false;
    };
  }, [server, channel, state.messagesRev]);

  // Whatever is on screen is read: keep the device-local seen marker in
  // step so the hub's unread counts mean "since you last looked". Message
  // timestamps are sender clocks — pass the newest visible ts so a sender
  // whose clock runs ahead can't leave a just-read message forever unread.
  useEffect(() => {
    if (!server || !channel) return;
    const newest = state.messages.reduce((t, m) => Math.max(t, m.ts ?? 0), 0);
    controllerRef.current?.markSeen(server, channel, newest);
  }, [server, channel, state.messages]);

  useEffect(() => {
    if (!server) return void setUnreads({});
    let alive = true;
    controllerRef.current
      ?.channelDigest(server)
      .then((d) => alive && setUnreads(Object.fromEntries(d.map((x) => [x.channel, x.unread]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [server, channel, state.messagesRev, state.messages]);

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

  // The stage must play the *live* shelf entry, not the snapshot captured
  // at launch: an admin edit (new URL, renamed, removed) syncs to everyone
  // else's shelf but would otherwise leave this player on the stale game.
  const liveGame = useMemo(() => {
    if (!game) return null;
    return (activeServer?.overview?.games ?? []).find((g) => g.id === game.id) ?? null;
  }, [game, activeServer]);

  // The admin pulled the game from the shelf while it was being played:
  // close the stage instead of keeping an unlisted iframe alive.
  useEffect(() => {
    if (game && !liveGame) {
      setGame(null);
      dispatch({ type: 'toast', text: `"${game.name}" was removed from the shelf` });
    }
  }, [game, liveGame]);

  // Open the stage for whatever call the VoiceManager is in right now.
  // Read it off the controller, not React state — this runs right after a
  // join resolves, before the published state has rendered.
  const openStage = () => {
    const v = controllerRef.current?.voice?.active;
    if (!v) return;
    // A running game keeps the pane — the call rides in its dock instead.
    if (game) return;
    if (!stage) stageReturn.current = state.active;
    dispatch({ type: 'select', server: v.server, channel: callChatChannel(v.channel) });
    setStage(true);
    setDrawer(null);
  };

  // Launch a game from the shelf: the game takes the main pane, and the
  // circle's first room docks beside it so the conversation rides along.
  // Launching also drops a join card into that room — late arrivals get
  // a one-tap way in, which is the whole point of a shared shelf.
  const launchGame = (g, { announce = true } = {}) => {
    const ch = channel ?? activeServer?.channels[0];
    if (!ch) return;
    dispatch({ type: 'select', server, channel: ch });
    setStage(false);
    setGame(g);
    setDrawer(null);
    markPlayed(g.id);
    bumpPlayCount(g.id);
    if (announce && !activeServer?.restored) {
      controllerRef.current?.sendGameCard(server, ch, g).catch(() => {});
    }
  };

  // Rich presence follows the game state: whenever a game opens or closes
  // (from any path — back button, room click, circle switch), tell the
  // circle it was launched in. Ephemeral; peers expire it on their own.
  const playingRef = useRef(null);
  useEffect(() => {
    const c = controllerRef.current;
    if (!c) return;
    const prev = playingRef.current;
    if (game && server && !activeServer?.restored) {
      playingRef.current = { server, game };
      c.setPlaying(server, game).catch(() => {});
      // Being in a game supersedes any rally I sent for it — stand it down.
      c.setWant(server, null).catch(() => {});
    } else if (!game && prev) {
      playingRef.current = null;
      c.setPlaying(prev.server, null).catch(() => {});
    }
  }, [game]);

  const closeGame = () => {
    setGame(null);
    // Land back on the hub the game was launched from.
    if (server) dispatch({ type: 'select', server, channel: null });
  };

  const closeStage = () => {
    setStage(false);
    const back = stageReturn.current;
    stageReturn.current = null;
    if (back?.server && state.servers.some((s) => s.id === back.server)) {
      dispatch({ type: 'select', server: back.server, channel: back.channel });
    } else if (activeServer) {
      dispatch({ type: 'select', server: activeServer.id, channel: activeServer.channels[0] });
    }
  };

  // The call ended (hang-up, peer left, connection lost) — the stage has
  // nothing to show; land back where the user was.
  useEffect(() => {
    if (stage && !state.voice.active) closeStage();
  }, [stage, state.voice.active]);

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
  const openLogout = () => dispatch({ type: 'modal', modal: { type: 'logout' } });
  const openInvite = async () => {
    try {
      const url = await controllerRef.current.createInvite(server);
      dispatch({ type: 'modal', modal: { type: 'invite', url } });
    } catch (e) {
      dispatch({ type: 'toast', text: e.message });
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
              // Picking a circle lands on its game hub, not a room.
              dispatch({ type: 'select', server: id, channel: null });
              setStage(false); // navigating away swaps the stage for the rooms
              setGame(null);
              setDrawer(null);
            }}
            onCreate={async (name) => {
              const id = await controllerRef.current.createServer(name);
              dispatch({ type: 'select', server: id, channel: null });
              setDrawer(null);
            }}
          />
          <div className="nav-col">
          {activeServer && (
            <Channels
              server={activeServer}
              activeChannel={channel}
              me={state.me}
              unreads={unreads}
              canManage={canManage && !activeServer.restored}
              onSelect={(ch) => {
                dispatch({ type: 'select', server, channel: ch });
                setStage(false); // picking a text room dismisses the stage
                setGame(null); // …and the game
                setDrawer(null);
              }}
              onSettings={(ch) =>
                dispatch({
                  type: 'modal',
                  modal: {
                    type: 'channel',
                    server,
                    channel: ch,
                    meta: activeServer.chanMeta?.[ch] ?? {},
                  },
                })
              }
              onCreate={(ch) => controllerRef.current.createChannel(server, ch)}
              onVoiceCreate={(ch) => controllerRef.current.createVoiceChannel(server, ch)}
              onVoiceSettings={(ch) =>
                dispatch({
                  type: 'modal',
                  modal: { type: 'channel', voice: true, server, channel: ch, meta: {} },
                })
              }
              voice={state.voice}
              onVoiceJoin={(ch) =>
                controllerRef.current.voice
                  .join(server, ch)
                  .then(() => openStage())
                  .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
              }
              onVoiceLeave={() => controllerRef.current.voice.leave()}
              onOpenStage={openStage}
              onManage={() =>
                dispatch({
                  type: 'modal',
                  modal: {
                    type: 'circle',
                    server,
                    name: activeServer.name,
                    canManage: canManage && !activeServer.restored,
                  },
                })
              }
            />
          )}
          <div className="self-card">
            <div className="self-id">
              <Seal name={state.me} size={32} title={state.me} />
              <span className="who">
                <span className="handle" data-testid="self-name">{state.me}</span>
                <span className={`status ${state.connection}`}>{state.connection}</span>
              </span>
            </div>
            <div className="self-actions">
              <button className="icon-btn" title="settings" data-testid="open-settings" onClick={openSettings}>
                <Gear size={14} />
              </button>
              <button className="icon-btn danger" title="log out" data-testid="logout" onClick={openLogout}>
                <LogOut size={14} />
              </button>
            </div>
          </div>
          </div>
        </nav>
        {activeServer && liveGame && channel ? (
          <GameStage
            game={liveGame}
            server={activeServer}
            channel={channel}
            me={state.me}
            messages={state.messages}
            canSend={!activeServer.restored}
            onSend={(text) =>
              controllerRef.current
                .sendChat(server, channel, text)
                .catch((e) => dispatch({ type: 'toast', text: e.message }))
            }
            voice={state.voice}
            onVoiceJoin={(ch) =>
              controllerRef.current.voice
                .join(server, ch)
                .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
            }
            onVoiceLeave={() => controllerRef.current.voice.leave()}
            onToggleMute={() => controllerRef.current.voice.setMuted(!state.voice.muted)}
            onInviteSeat={() =>
              controllerRef.current.sendGameCard(server, channel, liveGame).catch(() => {})
            }
            onClose={closeGame}
          />
        ) : activeServer && stage && state.voice.active ? (
          <CallStage
            voice={state.voice}
            manager={controllerRef.current.voice}
            me={state.me}
            messages={state.messages}
            canSend={!activeServer.restored}
            onSend={(text) =>
              controllerRef.current
                .sendChat(server, channel, text)
                .catch((e) => dispatch({ type: 'toast', text: e.message }))
            }
            onShare={() =>
              controllerRef.current.voice
                .startShare()
                .catch((e) => dispatch({ type: 'toast', text: `screen share: ${e.message}` }))
            }
            onStopShare={() => controllerRef.current.voice.stopShare()}
            onCamera={() =>
              controllerRef.current.voice
                .startCamera()
                .catch((e) => dispatch({ type: 'toast', text: `camera: ${e.message}` }))
            }
            onStopCamera={() => controllerRef.current.voice.stopCamera()}
            onToggleMute={() => controllerRef.current.voice.setMuted(!state.voice.muted)}
            onLeave={() => controllerRef.current.voice.leave()}
            onClose={closeStage}
          />
        ) : activeServer ? (
          <>
            {channel ? (
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
                voice={state.voice}
                onVoiceJoin={(ch) =>
                  controllerRef.current.voice
                    .join(server, ch)
                    .then(() => openStage())
                    .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
                }
                onOpenStage={openStage}
                onLaunchGame={(g) => launchGame(g, { announce: false })}
                onReact={(target, emo) =>
                  controllerRef.current
                    .react(server, channel, target, emo)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onRetry={(m) =>
                  controllerRef.current
                    .retryMessage(server, channel, m)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
              />
            ) : (
              <Overview
                server={activeServer}
                me={state.me}
                canManage={canManage && !activeServer.restored}
                canSend={!activeServer.restored}
                voice={state.voice}
                digestKey={`${activeServer.lastSeq}:${state.messagesRev}`}
                loadDigest={(id) => controllerRef.current.channelDigest(id)}
                onSelectChannel={(ch) => dispatch({ type: 'select', server, channel: ch })}
                onVoiceJoin={(ch) =>
                  controllerRef.current.voice
                    .join(server, ch)
                    .then(() => openStage())
                    .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
                }
                onLaunchGame={launchGame}
                onRally={(g) =>
                  controllerRef.current
                    .setWant(server, g)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onRsvp={(at, going) =>
                  controllerRef.current
                    .rsvp(server, at, going)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onSave={(ov) =>
                  controllerRef.current
                    .setOverview(server, ov)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onAddNotice={(text) =>
                  controllerRef.current
                    .addNotice(server, text)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onRemoveNotice={(id) =>
                  controllerRef.current
                    .removeNotice(server, id)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
              />
            )}
            <Members
              server={activeServer}
              me={state.me}
              canManage={canManage}
              voice={state.voice}
              onCall={(peer) => {
                setDrawer(null);
                controllerRef.current.voice
                  .callUser(server, peer)
                  .then(() => openStage())
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
              onRemoveMember={(user) =>
                controllerRef.current
                  .removeMember(server, user)
                  .catch((e) => dispatch({ type: 'toast', text: `remove: ${e.message}` }))
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
          stageOpen={stage}
          onAccept={() =>
            controllerRef.current.voice
              .acceptRing()
              .then(() => openStage())
              .catch((e) => dispatch({ type: 'toast', text: `call: ${e.message}` }))
          }
          onDecline={() => controllerRef.current.voice.declineRing()}
          onCancel={() => controllerRef.current.voice.cancelCall()}
          onHangup={() => controllerRef.current.voice.leave()}
          onToggleMute={() => controllerRef.current.voice.setMuted(!state.voice.muted)}
          onOpen={openStage}
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
            unsecured={unsecured}
            onLogout={() => controllerRef.current.logout()}
            onLinkSend={async (blobId, pub) => {
              await controllerRef.current.sendIdentityToDevice(blobId, pub);
            }}
            onEnrollDevice={async () => {
              await controllerRef.current.enrollDevicePasskey();
              dispatch({ type: 'modal', modal: null });
              dispatch({ type: 'toast', text: 'this device can now sign in with one tap' });
            }}
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
            onChannelSettings={(srv, ch, settings) =>
              controllerRef.current.setChannelSettings(srv, ch, settings)
            }
            onChannelRename={(srv, ch, to, isVoice) =>
              isVoice
                ? controllerRef.current.renameVoiceChannel(srv, ch, to)
                : controllerRef.current.renameChannel(srv, ch, to)
            }
            onChannelDelete={(srv, ch, isVoice) =>
              isVoice
                ? controllerRef.current.deleteVoiceChannel(srv, ch)
                : controllerRef.current.deleteChannel(srv, ch)
            }
            onRenameServer={(srv, name) => controllerRef.current.renameServer(srv, name)}
            onLeaveServer={(srv) => controllerRef.current.leaveServer(srv)}
            onDeleteServer={(srv) => controllerRef.current.deleteServer(srv)}
            identityKey={controllerRef.current?.identityKeyString()}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            servers={state.servers}
            active={server}
            actions={paletteActions}
            onNavigate={(srv, ch) => {
              dispatch({ type: 'select', server: srv, channel: ch });
              setStage(false);
              setGame(null);
            }}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
