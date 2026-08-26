import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { openDb } from './lib/db.js';
import { createCrypto } from './lib/rpc.js';
import { Controller } from './lib/controller.js';
import { parseInviteUrl } from './lib/invite.js';
import { parseLinkUrl, verifyCode } from './lib/link.js';
import Modal from './components/Modal.jsx';
import Onboarding from './components/Onboarding.jsx';
import Masthead from './components/Masthead.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import CirclesHome from './components/CirclesHome.jsx';
import RoomStrip from './components/RoomStrip.jsx';
import Messages from './components/Messages.jsx';
import Overview from './components/Overview.jsx';
import Members from './components/Members.jsx';
import CallPanel from './components/CallPanel.jsx';
import CallBar from './components/CallBar.jsx';
import PhoneTabs from './components/PhoneTabs.jsx';
import CallStage from './components/CallStage.jsx';
import GameStage from './components/GameStage.jsx';
import { callChatChannel } from './lib/controller.js';
import Settings from './components/Settings.jsx';
import NotificationsPrompt from './components/NotificationsPrompt.jsx';
import {
  shouldPromptNotifications,
  notifAlreadyPrompted,
  markNotifPrompted,
} from './lib/notify-prompt.js';
import BootLoader from './components/BootLoader.jsx';
import { Key, ShieldCheck, LinkGlyph, Sun, Gear } from './components/icons.jsx';
import { markPlayed, bumpPlayCount } from './lib/games.js';
import { withViewTransition } from './lib/viewTransition.js';
import { useMinuteClock } from './lib/clock.js';
import { hasTurn, loadRelayOnly, saveRelayOnly } from './lib/voice.js';
import { deviceLabel } from './lib/account.js';
import {
  readPref,
  writePref,
  resolveTheme,
  prefersLight,
  watchSystem,
  THEME_COLOR,
} from './lib/theme.js';

/** Content identity of a message for merging a load snapshot with live
    arrivals — same idea as history.js's fingerprint, plus the system flag. */
function messageKey(m) {
  // Identity, not content: this keys the load/live merge below, and an
  // edited or deleted line keeps the same (sender, ts) while its body
  // changes — the fresh copy must replace the old one, not stack beside it
  // (the same reason msgPatch keys on (sender, ts)). System chips carry no
  // stable ts identity, so keep their text in the key to tell them apart.
  return m.system ? `s|${m.sender}|${m.ts}|${m.text ?? ''}` : `m|${m.sender}|${m.ts}`;
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
  // Circles live on the relay now, so there is a real window between "the
  // app is up" and "we know which circles you are in". An empty rail during
  // that window would read as an answer — that you are in none — so it says
  // it is still asking instead.
  circlesLoading: true,
  messagesRev: 0, // bumped when stored messages changed outside the live path (backfill, prune)
};

function reducer(state, action) {
  switch (action.type) {
    case 'phase':
      return { ...state, phase: action.phase };
    // Terminal startup failure. Distinct from a toast because there is no
    // app behind it to return to — the alternative was an endless splash.
    case 'fatal':
      return { ...state, phase: 'fatal', fatal: action.text };
    case 'storageAtRisk':
      return { ...state, storageAtRisk: true, storageEvicts: action.evicts };
    case 'circlesLoading':
      return { ...state, circlesLoading: action.loading };
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
    // Audio cues mirrored as text. Kept out of `toast` on purpose: a toast is
    // a visible transient, and these exist for people who cannot hear the
    // chime, not for everyone to read.
    case 'announce':
      return { ...state, announce: action.text };
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


export default function App() {
  const [state, rawDispatch] = useReducer(reducer, initial);
  // The roster regroups (a member sliding into "in call" / "playing") on a
  // voice update, which is network-driven, not a click — so we can't wrap it
  // at a call site. Instead the dispatch itself runs a View Transition, but
  // ONLY when the call/game *membership* actually changed: speaking meters
  // fire many times a second and must never trigger a transition.
  const stateRef = useRef(state);
  stateRef.current = state;
  const rosterSig = (v) => JSON.stringify(v?.presence ?? {});
  const dispatch = useCallback((action) => {
    if (action.type === 'voice' && rosterSig(action.state) !== rosterSig(stateRef.current.voice)) {
      withViewTransition(() => rawDispatch(action));
      return;
    }
    rawDispatch(action);
  }, []);
  // Theme is a device preference, not account state — plain localStorage.
  // `themePref` is 'paper' | 'carbon' | null, where null means "follow the
  // system"; `theme` is what is actually on screen. Everything downstream
  // sees only the resolved value and stays a two-way toggle.
  const [themePref, setThemePref] = useState(readPref);
  const [systemLight, setSystemLight] = useState(prefersLight);
  useEffect(() => watchSystem(setSystemLight), []);
  const theme = resolveTheme(themePref, systemLight);
  // Pin whichever theme is *not* showing, regardless of how the current one
  // was arrived at — a toggle that did nothing on its first press because the
  // stored preference already matched the system would read as broken.
  const toggleTheme = useCallback(
    () => setThemePref(resolveTheme(themePref, systemLight) === 'paper' ? 'carbon' : 'paper'),
    [themePref, systemLight],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The room the phone's "rooms" tab goes back to. Not a stored preference
  // (§7.5): it is where you were, and it resets with the circle.
  const lastRoom = useRef(null);
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
  // First-run notifications ask: false until surfaced once, a beat after
  // landing in the app (see effect below). The popup routes through the same
  // enableNotifications() as Settings.
  const [notifPrompt, setNotifPrompt] = useState(false);

  useEffect(() => {
    // Leaving the attribute *off* is what hands first paint to the CSS
    // prefers-color-scheme rule, so "follow the system" must clear it rather
    // than write the resolved value.
    if (themePref) document.documentElement.dataset.theme = themePref;
    else delete document.documentElement.dataset.theme;
    writePref(themePref);
  }, [themePref]);

  useEffect(() => {
    // Keep the browser/OS chrome (Android address bar, iOS standalone
    // status bar) in step with the app surface. This one tracks the resolved
    // theme, so it follows the system flipping under us.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLOR[theme]);
  }, [theme]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // Default: same origin (single-container mode, relay serves this page).
    // Dev setups (vite on another port) pass ?relay=ws://localhost:9601/ws.
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sameOrigin = `${wsProto}://${location.host}/ws`;
    // ?relay= used to be honored verbatim, and invite links propagated it —
    // so a crafted link could point a victim's client at a relay of the
    // attacker's choosing, which then proxies to the real one. Only accept
    // an override that stays on this origin, or a loopback address for the
    // documented `npm run dev` split (vite on another port).
    const requested = params.get('relay');
    const allowed =
      requested &&
      (() => {
        try {
          const u = new URL(requested);
          if (u.host === location.host) return true;
          return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        } catch {
          return false;
        }
      })();
    if (requested && !allowed) {
      console.warn(`ignoring ?relay=${requested}: only this origin or localhost is allowed`);
    }
    const relayUrl = allowed ? requested : sameOrigin;
    const controller = new Controller({
      db: null,
      crypto: createCrypto(),
      dispatch,
      relayUrl,
    });
    const invite = parseInviteUrl(location);
    if (invite) controller.setPendingInvite(invite);
    controllerRef.current = controller;
    openDb()
      .then((db) => {
        controller.db = db;
        controller.boot().catch((e) => dispatch({ type: 'toast', text: e.message }));
      })
      // Private browsing and locked-down profiles reject openDb outright.
      // This had no catch, so the rejection went unhandled and the app sat
      // on the boot splash forever with nothing on screen to explain it.
      .catch((e) =>
        dispatch({
          type: 'fatal',
          text: `this browser will not let quorum store data (${e.message}). Private browsing usually causes this — try a normal window.`,
        })
      );
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

  // First-run notifications ask: once we're inside (fresh registration, a
  // sign-in, or a returning boot), offer to turn on push — but only if the
  // browser supports it, the user hasn't already decided, and we haven't asked
  // before. A short beat lets the app settle so it reads as a welcome, not an
  // interruption.
  useEffect(() => {
    if (state.phase !== 'ready') return;
    const supported = typeof Notification !== 'undefined';
    const permission = supported ? Notification.permission : 'unsupported';
    if (!shouldPromptNotifications({ supported, permission, asked: notifAlreadyPrompted() })) return;
    const id = setTimeout(() => setNotifPrompt(true), 1500);
    return () => clearTimeout(id);
  }, [state.phase]);

  // Persist that we've asked and close, whichever way the user answered — the
  // prompt is a one-time nicety, not a recurring nag.
  const dismissNotifPrompt = () => {
    markNotifPrompted();
    setNotifPrompt(false);
  };

  // ⌘K / Ctrl+K opens the palette anywhere inside the app.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
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

  // Device-local unread counts for the room chips — same digest the
  // board uses, keyed on everything that can move it.
  const [unreads, setUnreads] = useState({});
  // Read the room whenever the active channel changes — or when its working
  // copy moved underneath us (a page arrived, a mutation landed, retention
  // pruned). The first read of a session fetches from the relay; there is no
  // local archive to fall back on.
  const { server, channel } = state.active;
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    if (!server || !channel) return;
    lastRoom.current = channel;
    let alive = true;
    controllerRef.current
      .loadMessages(server, channel)
      .then((messages) => alive && dispatch({ type: 'messages', messages, server, channel }));
    return () => {
      alive = false;
    };
  }, [server, channel, state.messagesRev]);

  const loadOlder = useCallback(() => {
    if (!server || !channel) return;
    setLoadingOlder(true);
    controllerRef.current
      ?.loadOlderMessages(server, channel)
      .catch((e) => dispatch({ type: 'toast', text: `could not read further back: ${e.message}` }))
      .finally(() => setLoadingOlder(false));
  }, [server, channel]);

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

  // Device preference, like the theme: whether to route call media through
  // TURN so peers never see this device's address.
  const [relayOnly, setRelayOnly] = useState(loadRelayOnly);

  // Must be stable: the palette re-runs its scan whenever this identity
  // changes, so an inline arrow would rescan on every keystroke it causes.
  const searchMessages = useCallback(
    (q) => controllerRef.current?.searchMessages(q) ?? { hits: [], truncated: false },
    [],
  );

  // Also must be stable: the security panel loads the device list in an
  // effect keyed on this, so an inline arrow would refetch on every render.
  const listDevices = useCallback(
    () => controllerRef.current?.listDevices() ?? Promise.resolve([]),
    [],
  );

  // Cross-circle activity for the rail badges. Same seen markers as the
  // per-channel pills, rolled up per circle — without it nothing on screen
  // says a circle you are not looking at has moved.
  const [circleUnreads, setCircleUnreads] = useState({});
  useEffect(() => {
    let alive = true;
    controllerRef.current
      ?.circleUnreads()
      .then((u) => alive && setCircleUnreads(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [server, channel, state.messagesRev, state.messages, state.servers]);

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!state.toast) return;
    const t = setTimeout(() => dispatch({ type: 'toast', text: null }), 5000);
    return () => clearTimeout(t);
  }, [state.toast]);

  // One clock for every surface that shows how long a call has run, so two
  // of them can never disagree about the same call.
  const now = useMinuteClock(!!state.voice.active);

  // A different circle's rooms are not this one's.
  useEffect(() => {
    lastRoom.current = null;
  }, [server]);

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
    // Morph the main pane text ⇄ call stage as one View Transition.
    withViewTransition(() => {
      dispatch({ type: 'select', server: v.server, channel: callChatChannel(v.channel) });
      setStage(true);
    });
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
    const back = stageReturn.current;
    stageReturn.current = null;
    withViewTransition(() => {
      setStage(false);
      if (back?.server && state.servers.some((s) => s.id === back.server)) {
        dispatch({ type: 'select', server: back.server, channel: back.channel });
      } else if (activeServer) {
        dispatch({ type: 'select', server: activeServer.id, channel: activeServer.channels[0] });
      }
    });
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

  if (state.phase === 'fatal') {
    return (
      <div className="boot-fatal">
        <h1>quorum can't start</h1>
        <p>{state.fatal}</p>
      </div>
    );
  }
  if (state.phase === 'loading') {
    return <BootLoader />;
  }
  if (state.phase === 'onboarding') {
    return <Onboarding controller={controllerRef.current} />;
  }

  const unsecured = state.vault.kind === null && !state.vault.securedLocal;
  // Admin of the active circle (or a global admin): may add members,
  // create invites, and change roles. Relay-enforced; this only gates UI.
  const canManage =
    state.globalAdmin || (activeServer && activeServer.roles?.[state.me] === 'admin');

  // The roster, built once. It is the security boundary — it is exactly who
  // can read this circle — so it has one definition and one set of actions,
  // whether it is being read on the board or pulled open beside a room.
  const roster = activeServer ? (
    <Members
      server={activeServer}
      me={state.me}
      canManage={canManage}
      voice={state.voice}
      onCall={(peer) => {
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
              mismatched: !!activeServer.mismatched?.[peer],
            },
          });
        } catch (e) {
          dispatch({ type: 'toast', text: e.message });
        }
      }}
    />

  ) : null;


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
      run: toggleTheme,
    },
  ];

  return (
    <div className="app-shell">
      {/* Reaching the conversation meant tabbing the rail, the whole channel
          sidebar and the voice list, on every load. Hidden until focused. */}
      <a className="skip-link" href="#messages-pane">
        skip to conversation
      </a>
      <Masthead
        server={activeServer}
        channel={channel}
        // What the pane is *showing*, which is not the same as what is
        // running: a call keeps going when you walk back to a text room, and
        // the marker must name the room in that case, not the call.
        callChannel={stage && state.voice.active ? state.voice.active.channel : null}
        game={liveGame && channel ? liveGame : null}
        call={state.voice.active}
        now={now}
        onOpenCircle={() =>
          withViewTransition(() => {
            dispatch({ type: 'select', server, channel: null });
            setStage(false);
            setGame(null);
          })
        }
        connection={state.connection}
        theme={theme}
        canInvite={canManage}
        onInvite={openInvite}
        onPalette={() => setPaletteOpen(true)}
        onTheme={toggleTheme}
        me={state.me}
        onSettings={openSettings}
      />
      {unsecured && (
        <div className="secure-banner" data-testid="secure-banner">
          <Key size={14} />
          {/* §11.6 bans "gone forever" by name, and cites this banner as the
              reason the rule exists. It has never actually been on screen —
              the vault status it keys off never reached the reducer — so this
              is the first version of it anyone will read. §11.2: what is true,
              what it means for you, what to do about it. */}
          <span>
            <strong>{state.me}</strong> lives only in this browser. Park an encrypted copy on
            the relay and you can sign in on another device.
          </span>
          <button className="button" data-testid="secure-now" onClick={openSecure}>
            secure account
          </button>
        </div>
      )}
      {state.storageAtRisk && state.storageEvicts && !unsecured && (
        // Only shown where it is a real countdown (WebKit, not installed)
        // and only once the account is already secured — an unsecured
        // account has a louder banner of its own, and stacking two nags is
        // how people learn to dismiss both.
        <div className="secure-banner" data-testid="storage-banner">
          <Key size={14} />
          <span>
            this browser may delete quorum's data after 7 days without use —{' '}
            <strong>add it to your home screen</strong> so you don't have to sign in and be
            re-added to every circle
          </span>
        </div>
      )}
      {/* A call is running and the screen is not it. §7.4 — the mic stays
          live when you walk away from the call stage, so it says so here,
          everywhere you go, until you come back or hang up. The game stage
          is excluded because the call rides in its own dock there; two
          places saying "you are in a call" is how the sidebar taught people
          to stop reading either. */}
      {state.voice.active && !stage && !(liveGame && channel) && (
        <CallBar
          voice={state.voice}
          me={state.me}
          now={now}
          onOpen={openStage}
          onToggleMute={() =>
            controllerRef.current?.voice?.setMuted(!state.voice.muted)
          }
        />
      )}
      {/* The strip sits at shell level, under the fascia and above whatever
          the pane is showing — so it is on screen during the call stage and
          the game stage too. That is the half of §7.1 the sidebar column
          could never hold: it was a list of rooms, and a call is not a row
          in a list of rooms. */}
      {activeServer && (
        <RoomStrip
          server={activeServer}
          activeChannel={channel}
          onStage={stage && !!state.voice.active}
          onGame={!!(liveGame && channel)}
          unreads={unreads}
          voice={state.voice}
          canManage={canManage && !activeServer.restored}
          onSelect={(ch) =>
            withViewTransition(() => {
              dispatch({ type: 'select', server, channel: ch });
              setStage(false); // picking a room dismisses the stage…
              setGame(null); // …and the game
            })
          }
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
          onVoiceJoin={(ch) =>
            controllerRef.current.voice
              .join(server, ch)
              .then(() => openStage())
              .catch((e) => dispatch({ type: 'toast', text: `voice: ${e.message}` }))
          }
          onOpenStage={openStage}
        />
      )}
      <div className="app">
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
                hasOlder={controllerRef.current?.hasOlderMessages(server, channel) ?? false}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlder}
                onSend={(text, reply) =>
                  controllerRef.current
                    .sendChat(server, channel, text, reply)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onType={() => controllerRef.current?.typing(server, channel).catch(() => {})}
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
                onOpenBoard={() =>
                  withViewTransition(() => {
                    dispatch({ type: 'select', server, channel: null });
                    setStage(false);
                    setGame(null);
                  })
                }
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
                onEdit={(m, text) =>
                  controllerRef.current
                    .editMessage(server, channel, m, text)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onDelete={(m) =>
                  controllerRef.current
                    .deleteMessage(server, channel, m)
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
                onSelectChannel={(ch) =>
                  withViewTransition(() => dispatch({ type: 'select', server, channel: ch }))
                }
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
                onAddOffer={(text, seats) =>
                  controllerRef.current
                    .addOffer(server, text, seats)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onTakeOffer={(id, taking) =>
                  controllerRef.current
                    .takeOffer(server, id, taking)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                onRemoveOffer={(id) =>
                  controllerRef.current
                    .removeOffer(server, id)
                    .catch((e) => dispatch({ type: 'toast', text: e.message }))
                }
                people={roster}
              />
            )}
          </>
        ) : (
          // No circle open — the screen that replaced the rail. Same surface
          // whether you are in none or in six; "no circles yet" is a state of
          // this page, not a different page.
          <CirclesHome
            servers={state.servers}
            loading={state.circlesLoading}
            me={state.me}
            voice={state.voice}
            unreads={circleUnreads}
            now={now}
            onOpen={(id) =>
              withViewTransition(() => {
                dispatch({ type: 'select', server: id, channel: null });
                setStage(false);
                setGame(null);
              })
            }
            onCreate={async (name) => {
              const id = await controllerRef.current.createServer(name);
              dispatch({ type: 'select', server: id, channel: null });
            }}
            onIdentity={openIdentity}
            onSecure={openSecure}
          />
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
        {/* Every confirmation in the product lands here — "device revoked",
            "marked as verified", a failed screen share — and it was a bare
            div that vanished after five seconds. aria-atomic so the whole
            line is read rather than the diff against the previous toast. */}
        {state.toast && (
          <div className="toast" role="status" aria-live="polite" aria-atomic="true">
            {state.toast}
          </div>
        )}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.announce}
        </span>
        {state.modal?.type === 'settings' && (
          <Settings
            me={state.me}
            theme={theme}
            themePref={themePref}
            onTheme={toggleTheme}
            onSystemTheme={() => setThemePref(null)}
            onEnableNotifications={() => controllerRef.current.enableNotifications()}
            voice={controllerRef.current?.voice}
            relayOnly={relayOnly}
            turnAvailable={hasTurn(controllerRef.current?.voice?.iceServers)}
            onRelayOnly={(on) => {
              setRelayOnly(on);
              saveRelayOnly(on);
              // Existing peer connections keep the policy they were built
              // with; this takes effect on the next call, which the panel says.
              if (controllerRef.current?.voice) controllerRef.current.voice.relayOnly = on;
            }}
            secured={!unsecured}
            onLogout={openLogout}
            onShowIdentity={openIdentity}
            onSecure={openSecure}
            onClose={() => dispatch({ type: 'modal', modal: null })}
          />
        )}
        {notifPrompt && !state.modal && (
          <NotificationsPrompt
            onEnable={async () => {
              await controllerRef.current.enableNotifications();
              dispatch({ type: 'toast', text: 'notifications enabled for this device' });
            }}
            onClose={dismissNotifPrompt}
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
              await controllerRef.current.enrollDevicePasskey(
                deviceLabel(navigator.userAgent)
              );
              dispatch({ type: 'modal', modal: null });
              dispatch({ type: 'toast', text: 'this device can now sign in with one tap' });
            }}
            onListDevices={listDevices}
            onRevokeDevice={async (credId) => {
              await controllerRef.current.revokeDevice(credId);
              dispatch({ type: 'toast', text: 'device revoked — it can no longer sign in' });
            }}
            onVerify={async (srv, peer) => {
              await controllerRef.current.markVerified(srv, peer);
              dispatch({ type: 'modal', modal: null });
              dispatch({ type: 'toast', text: `${peer} marked as verified` });
            }}
            onMismatch={async (srv, peer) => {
              await controllerRef.current.markMismatch(srv, peer);
              // The dialog stays open, unlike verifying: the outcome copy is
              // the point of pressing this, and closing onto a toast would
              // throw away the only guidance the user gets.
              dispatch({
                type: 'modal',
                modal: { ...state.modal, mismatched: true, verified: false },
              });
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
            onSetGlyph={(srv, glyph) => {
              // The glyph rides the overview record, so it has to be written
              // as an edit to that record and not as a replacement — saving
              // {glyph} alone would drop the blurb, the shelf and the
              // schedule for every member of the circle.
              const rec = state.servers.find((x) => x.id === srv);
              return controllerRef.current.setOverview(srv, {
                ...(rec?.overview ?? {}),
                glyph,
              });
            }}
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
            onSearch={searchMessages}
            onNavigate={(srv, ch) => {
              dispatch({ type: 'select', server: srv, channel: ch });
              setStage(false);
              setGame(null);
            }}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
      {/* Below 821px only (CSS decides): the strip is at the top of the
          screen and a phone is held at the bottom. */}
      <PhoneTabs
        server={activeServer}
        channel={channel}
        onStage={stage && !!state.voice.active}
        onGame={!!(liveGame && channel)}
        onCircles={() =>
          withViewTransition(() => {
            dispatch({ type: 'select', server: null, channel: null });
            setStage(false);
            setGame(null);
          })
        }
        onBoard={() =>
          withViewTransition(() => {
            dispatch({ type: 'select', server, channel: null });
            setStage(false);
            setGame(null);
          })
        }
        onRooms={() =>
          withViewTransition(() => {
            const ch = lastRoom.current ?? activeServer?.channels?.[0];
            if (!ch) return;
            dispatch({ type: 'select', server, channel: ch });
            setStage(false);
            setGame(null);
          })
        }
      />
    </div>
  );
}
