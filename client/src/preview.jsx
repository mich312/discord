// Dev-only UI gallery (`npm run preview:ui`): the real components, mock
// state, no relay and no crypto core. Mirrors App.jsx's ready-phase layout —
// if App's shell changes, keep this in step. Views:
//   /preview.html?view=app            main surface, carbon
//   /preview.html?view=app&theme=paper
//   /preview.html?view=onboarding | invited | empty | circles | banner | overview
//   /preview.html?view=modal-safety | modal-invite | modal-secure | modal-identity
//   /preview.html?view=signing        the membership ledger, over the board
//   /preview.html?view=palette | call | call-share | game
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Masthead from './components/Masthead.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import CirclesHome from './components/CirclesHome.jsx';
import RoomStrip from './components/RoomStrip.jsx';
import Messages from './components/Messages.jsx';
import Overview from './components/Overview.jsx';
import Members from './components/Members.jsx';
import Modal from './components/Modal.jsx';
import { SigningDialog } from './components/Signing.jsx';
import Onboarding from './components/Onboarding.jsx';
import CallStage from './components/CallStage.jsx';
import CallBar from './components/CallBar.jsx';
import PhoneTabs from './components/PhoneTabs.jsx';
import GameStage from './components/GameStage.jsx';
import BootLoader from './components/BootLoader.jsx';
import { Key } from './components/icons.jsx';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'app';
const theme = params.get('theme') ?? 'carbon';
document.documentElement.dataset.theme = theme;

const now = Date.now();
const H = 3600 * 1000;

const servers = [
  {
    id: 'srv-race',
    name: 'Race Team',
    epoch: 12,
    channels: ['general', 'logistics', 'pit-wall'],
    voiceChannels: ['lounge'],
    members: ['alice', 'bob', 'charlie', 'dana'],
    verified: ['bob'],
    linkJoined: ['charlie'],
    chanMeta: { 'pit-wall': { topic: 'live timing chatter during sessions' } },
    threshold: 3,
    proposals: [
      {
        id: 'prop-edda',
        handle: 'edda',
        why: 'she runs the Otley lot and has a van',
        by: 'dana',
        at: now - 3 * H,
        signatures: [
          { who: 'dana', at: now - 3 * H },
          { who: 'bob', at: now - 2 * H },
        ],
        objections: [{ who: 'charlie', why: 'she still has our spare wheel', at: now - 90 * 60e3 }],
      },
    ],
    offers: [
      {
        id: 'lift1',
        text: 'Leeds → Otley, 07:00',
        note: 'boot space for two bikes',
        seats: 3,
        ts: now - 3 * H,
        author: 'bob',
        takers: ['dana', 'charlie'],
      },
      {
        id: 'kit1',
        text: 'Spare wheels in dana’s car — 11 speed only',
        seats: 0,
        ts: now - 26 * H,
        author: 'dana',
        takers: [],
      },
    ],
    roles: { alice: 'admin' },
    presence: {
      bob: { playing: { id: 'g1', name: 'Hex Gambit', kind: 'activity' }, ts: now - 41 * 60e3 },
      dana: { playing: { id: 'g1', name: 'Hex Gambit', kind: 'activity' }, ts: now - 41 * 60e3 },
    },
    // An open rally: charlie's up for Tanks and hoping someone joins in.
    wants: {
      charlie: { want: { id: 'g3', name: 'Tanks! Night Ops', kind: 'activity' }, ts: now - 4 * 60e3 },
    },
    // Live typing signal in #general (reader-expires ~6s after `ts`).
    typing: { charlie: { channel: 'general', ts: now } },
    rsvps: {
      bob: { at: now + 52 * H, ts: now - 3 * H },
      dana: { at: now + 52 * H, ts: now - 2 * H },
      marek: { at: now + 52 * H, ts: now - H },
      alice: { at: now + 26 * H, ts: now - 2 * H },
      charlie: { at: now + 26 * H, ts: now - H },
    },
    overview: {
      games: [
        { id: 'g1', name: 'Hex Gambit', url: '/games/hexgambit.html', kind: 'activity', note: 'bundled demo — local two-player chess', glyph: '♞' },
        { id: 'g2', name: 'Craftworld', url: 'mc.raceteam.example:25565', kind: 'server', note: 'survival, keep-inventory off', glyph: '⛏' },
        { id: 'g3', name: 'Tanks! Night Ops', url: 'https://tanks.arcade.example/room/race-team', kind: 'activity', glyph: '⌖' },
        { id: 'g4', name: 'Factory Floor', url: 'factorio.raceteam.example:34197', kind: 'server', glyph: '⚙' },
      ],
      blurb:
        'Pit crew HQ for the season. Race weekends run out of #logistics; #pit-wall is live timing only.',
      links: [
        { label: 'stint sheet', url: 'https://example.com/stints' },
        { label: 'tyre pressure log', url: 'https://example.com/tyres' },
      ],
      events: [
        {
          id: 'ev1',
          title: 'Qualifying — Round 4, Spa',
          at: now + 52 * H,
          note: 'Trailer leaves 6am. Pack the spare diffuser tonight.',
        },
        {
          id: 'ev2',
          title: 'Hex Gambit ladder night',
          at: now + 26 * H,
          note: 'best of five, bring your openings',
          gameId: 'g1',
        },
      ],
    },
    notices: [
      { id: 'n1', text: 'Scrutineering forms due Thursday — hand them to dana.', ts: now - 5 * H, author: 'dana' },
      { id: 'n2', text: 'New tyre pressure targets pinned in #pit-wall.', ts: now - 26 * H, author: 'bob' },
    ],
  },
  {
    id: 'srv-photo',
    name: 'Darkroom Society',
    epoch: 4,
    channels: ['general', 'critique'],
    voiceChannels: ['lounge'],
    members: ['alice', 'edda'],
    verified: [],
    linkJoined: [],
  },
];

const messages = [
  { sender: 'bob', text: 'scrutineering passed — we are P4 on the grid', ts: now - 26 * H, reacts: { '🔥': ['alice', 'dana', 'charlie'], '😤': ['dana'] } },
  { sender: 'bob', text: 'stewards want the wing endplate photos before nine', ts: now - 26 * H + 40e3 },
  { sender: 'alice', text: 'on it. tyre pressures from this morning still good?', ts: now - 25.6 * H },
  { system: true, text: 'charlie joined via invite link — unverified until someone checks their safety number', ts: now - 25 * H },
  { sender: 'charlie', text: 'found my way in via the link, reading up now', ts: now - 24.8 * H },
  { sender: 'alice', text: 'dropped 0.2 up front, track temp is way up', ts: now - 3 * H },
  { sender: 'alice', file: { name: 'tyre-temps.png', mime: 'image/png', size: 48213 }, ts: now - 3 * H + 30e3 },
  { sender: 'bob', game: { id: 'g1', name: 'Hex Gambit', kind: 'activity' }, ts: now - 2.5 * H },
  { sender: 'alice', text: 'left front is the one to watch', ts: now - 3 * H + 55e3 },
  { sender: 'dana', text: 'trailer leaves at 6am sharp — pack the spare diffuser tonight', ts: now - 2.2 * H, reacts: { '👍': ['alice', 'bob'] } },
  { sender: 'bob', file: { name: 'stint-plan.pdf', mime: 'application/pdf', size: 182044 }, ts: now - 1.1 * H },
  { sender: 'bob', text: 'plan B if it rains: box on lap 14 and go long', ts: now - 1.1 * H + 20e3 },
  {
    sender: 'alice',
    text: 'good call — I’ll prep the wets either way',
    ts: now - 1.05 * H,
    reply: { sender: 'bob', ts: now - 1.1 * H + 20e3, text: 'plan B if it rains: box on lap 14 and go long' },
  },
  { sender: 'dana', text: 'thanks @alice — leave the intermediates too, forecast is shaky', ts: now - 1.0 * H },
  { sender: 'bob', text: 'grid slot confirmed: P4 (was P5)', ts: now - 0.9 * H, edited: true },
  { sender: 'charlie', ts: now - 0.85 * H, deleted: true },
  // Read back from the log but unattributable: same sender as a signed line and close enough
  // in time that the old grouping would have merged them under one header.
  { sender: 'bob', text: 'wets are in the second truck if we need them', ts: now - 0.84 * H, auth: 'unknown' },
  { sender: 'bob', text: 'and the spare set is under the awning', ts: now - 0.83 * H, auth: 'unknown' },
];

// 2×2 png so the eager image-decrypt path renders something real.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0)
);

// Home-base catch-up mock: what channelDigest() would compute locally.
const digestMock = {
  'srv-race': [
    { channel: 'general', unread: 0, last: { sender: 'bob', text: 'plan B if it rains: box on lap 14 and go long', ts: now - 1.1 * H } },
    { channel: 'logistics', unread: 3, last: { sender: 'dana', text: 'trailer leaves at 6am sharp — pack the spare diffuser tonight', ts: now - 2.2 * H } },
    { channel: 'pit-wall', unread: 0, last: null },
  ],
  'srv-photo': [
    { channel: 'general', unread: 0, last: null },
    { channel: 'critique', unread: 1, last: { sender: 'edda', text: 'new darkroom scans are up', ts: now - 8 * H } },
  ],
};

const voice = {
  active: { server: 'srv-race', channel: 'lounge', since: now - 24 * 60e3 },
  listenOnly: false,
  connections: { bob: 'connected', dana: 'connecting…' },
  presence: { 'srv-race/lounge': ['alice', 'bob', 'dana'] },
};

// The same room seen from outside the call: others are live, I'm not.
const voiceIdle = {
  active: null,
  listenOnly: false,
  connections: {},
  presence: { 'srv-race/lounge': ['bob', 'dana', 'marek'] },
};

// Stage previews: everyone in the lounge, dana mid-sentence, and (for
// view=call-share) bob presenting a synthetic screen drawn on a canvas.
const stageVoice = (sharing) => ({
  ...voice,
  connections: { bob: 'connected', dana: 'connected' },
  speaking: ['dana'],
  sharing,
  screens: sharing.filter((n) => n !== 'alice'),
});

const callMessages = [
  { sender: 'bob', text: 'sharing the stint plan now', ts: now - 3 * 60e3 },
  { sender: 'alice', text: 'seeing it — lap 14 box works', ts: now - 2 * 60e3 },
  { sender: 'dana', text: 'agreed, weather radar says rain by lap 20', ts: now - 60e3 },
];

// A live MediaStream without any capture permission: draw a fake "shared
// screen" on a canvas and stream that. Only used by the gallery.
let fakeScreen = null;
function fakeScreenStream() {
  if (fakeScreen) return fakeScreen;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#2c2c34';
    ctx.fillRect(60, 60, 1160, 80);
    ctx.fillStyle = '#9aa0aa';
    ctx.font = '32px monospace';
    ctx.fillText('stint-plan.pdf — bob’s screen', 84, 112);
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#1a1a20' : '#202028';
      ctx.fillRect(60, 180 + i * 60, 1160, 48);
    }
    requestAnimationFrame(draw);
  };
  draw();
  fakeScreen = canvas.captureStream(10);
  return fakeScreen;
}

const mockVoiceManager = {
  screenStreamFor: (name) => (name === 'bob' ? fakeScreenStream() : null),
  cameraStreamFor: () => null,
};

const noop = () => {};
const mockController = {
  pendingInvite: view === 'invited' ? { id: 'x' } : null,
  registerPolicy: async () => ({ invite_required: false }),
  createIdentity: async () => new Uint8Array(32),
  completeOnboarding: noop,
  restoreIdentity: noop,
  signInWithPassword: noop,
  signInWithPasskey: noop,
};

const modals = {
  'modal-invite': {
    type: 'invite',
    url: 'https://quorum.example/?j=WnHDAesFBX-nTrekWD2rA2O5#k=9dJQmVdrqGz0kM3sX4uJb2FyPcVaNwLh8tTeRi5oYxAE',
  },
  'modal-secure': { type: 'secure' },
  'modal-identity': { type: 'identity', key: 'AGVkMjU1MTkAAAAg7fQm1kO4X9cJ2ZxWv8pRnLhT3sBqYaUieDo0M5wNfKgQxJtM2v-identity-demo' },
  'modal-mismatch': {
    type: 'safety',
    server: 'srv-race',
    peer: 'charlie',
    number: '39217 55018 82649 10473 66392 04815 77260 93148 25501 68937 41205 87716',
    mismatched: true,
  },
  'modal-safety': {
    type: 'safety',
    server: 'srv-race',
    peer: 'charlie',
    number: '39217 55018 82649 10473 66392 04815 77260 93148 25501 68937 41205 87716',
    verified: false,
  },
};

function PreviewShell({ empty = false, circles = false, banner = false, modal = null, palette = false, stage = null, landing = false, game = null, idle = false, emptyChat = false, signing = false }) {
  const vc = idle ? voiceIdle : voice;
  const me = 'alice';
  // channel: null means the circle's hub page, same as App.jsx.
  const [active, setActive] = useState({
    server: empty || circles ? null : 'srv-race',
    channel: landing && !game ? null : 'general',
  });
  const [liveGame, setLiveGame] = useState(game);
  const [overviews, setOverviews] = useState({});
  const [noticesBy, setNoticesBy] = useState({});
  const [openModal, setOpenModal] = useState(modal);
  const [paletteOpen, setPaletteOpen] = useState(palette);
  const [ledger, setLedger] = useState(signing ? 'prop-edda' : null);
  const list = empty ? [] : servers;
  const activeServer = list.find((s) => s.id === active.server) ?? null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#messages-pane">
        skip to conversation
      </a>
      <Masthead
        server={activeServer}
        channel={active.channel}
        callChannel={stage ? vc.active?.channel ?? null : null}
        game={liveGame && active.channel ? liveGame : null}
        call={vc.active}
        now={now}
        onOpenCircle={() => setActive((a) => ({ ...a, channel: null }))}
        me={me}
        onSettings={noop}
        connection="online"
        theme={theme}
        onInvite={() => setOpenModal(modals['modal-invite'])}
        onPalette={() => setPaletteOpen(true)}
        onTheme={() => {
          document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === 'paper' ? 'carbon' : 'paper';
        }}
      />
      {banner && (
        <div className="secure-banner" data-testid="secure-banner">
          <Key size={14} />
          <span>
            <strong>{me}</strong> lives only in this browser. Park an encrypted copy on the
            relay and you can sign in on another device.
          </span>
          <button className="button">secure account</button>
        </div>
      )}
      {vc.active && !stage && !(liveGame && active.channel) && (
        <CallBar voice={vc} me={me} now={now} onOpen={noop} onToggleMute={noop} />
      )}
      {activeServer && (
        <RoomStrip
          server={activeServer}
          activeChannel={active.channel}
          onStage={!!stage}
          onGame={!!(liveGame && active.channel)}
          unreads={Object.fromEntries(
            (digestMock[activeServer.id] ?? []).map((d) => [d.channel, d.unread])
          )}
          voice={vc}
          canManage
          onSelect={(ch) => setActive({ ...active, channel: ch })}
          onSettings={noop}
          onCreate={noop}
          onVoiceCreate={noop}
          onVoiceSettings={noop}
          onVoiceJoin={noop}
          onOpenStage={noop}
        />
      )}
      <div className="app">
        {activeServer && liveGame && active.channel ? (
          <GameStage
            game={liveGame}
            server={activeServer}
            channel={active.channel}
            me={me}
            messages={callMessages}
            canSend
            onSend={noop}
            voice={vc}
            onVoiceJoin={noop}
            onVoiceLeave={noop}
            onToggleMute={noop}
            onInviteSeat={noop}
            onClose={() => {
              setLiveGame(null);
              setActive({ ...active, channel: null });
            }}
          />
        ) : activeServer && stage ? (
          <CallStage
            voice={stage}
            manager={mockVoiceManager}
            me={me}
            messages={callMessages}
            canSend
            onSend={noop}
            onShare={noop}
            onStopShare={noop}
            onToggleMute={noop}
            onLeave={noop}
            onClose={noop}
          />
        ) : activeServer ? (
          <>
            {active.channel ? (
              <Messages
                server={activeServer}
                channel={active.channel}
                me={me}
                messages={emptyChat ? [] : messages}
                onSend={noop}
                onSendFile={noop}
                fetchFile={async (f) => {
                  if ((f.mime ?? '').startsWith('image/')) return PNG;
                  throw new Error('preview: no blob store');
                }}
                voice={vc}
                onVoiceJoin={noop}
                onOpenStage={noop}
              onOpenBoard={() => setActive({ ...active, channel: null })}
                onLaunchGame={(g) => {
                  setActive({ ...active, channel: activeServer.channels[0] });
                  setLiveGame(g);
                }}
                onReact={noop}
                onEdit={noop}
                onDelete={noop}
              />
            ) : (
              <Overview
                server={{
                  ...activeServer,
                  overview: overviews[activeServer.id] ?? activeServer.overview,
                  notices: noticesBy[activeServer.id] ?? activeServer.notices ?? [],
                }}
                me={me}
                canManage={activeServer.roles?.[me] === 'admin'}
                canSend
                voice={vc}
                digestKey="preview"
                loadDigest={async (id) => digestMock[id] ?? []}
                onSelectChannel={(ch) => setActive({ ...active, channel: ch })}
                onVoiceJoin={noop}
                onLaunchGame={(g) => {
                  setActive({ ...active, channel: activeServer.channels[0] });
                  setLiveGame(g);
                }}
                onRally={noop}
                onRsvp={noop}
                onSave={(ov) => setOverviews((o) => ({ ...o, [activeServer.id]: ov }))}
                onAddOffer={noop}
              onTakeOffer={noop}
              onRemoveOffer={noop}
              onOpenProposal={(id) => setLedger(id)}
              onCircleSettings={() =>
                setOpenModal({
                  type: 'circle',
                  server: activeServer.id,
                  name: activeServer.name,
                  glyph: activeServer.overview?.glyph,
                  threshold: activeServer.threshold,
                  members: activeServer.members.length,
                  canManage: true,
                })
              }
              people={
                <Members
                  server={activeServer}
                  me={me}
                  voice={vc}
                  onPropose={noop}
                  onMember={() => setOpenModal(modals['modal-safety'])}
                />
              }
              onAddNotice={(text) =>
                  setNoticesBy((by) => ({
                    ...by,
                    [activeServer.id]: [
                      { id: `p${Date.now()}`, text, ts: Date.now(), author: me },
                      ...(by[activeServer.id] ?? activeServer.notices ?? []),
                    ],
                  }))
                }
                onRemoveNotice={(id) =>
                  setNoticesBy((by) => ({
                    ...by,
                    [activeServer.id]: (by[activeServer.id] ?? activeServer.notices ?? []).filter(
                      (n) => n.id !== id
                    ),
                  }))
                }
              />
            )}
          </>
        ) : (
          <CirclesHome
            servers={list}
            me={me}
            voice={vc}
            unreads={Object.fromEntries(
              servers.map((s) => [
                s.id,
                (digestMock[s.id] ?? []).reduce((n, d) => n + d.unread, 0),
              ])
            )}
            now={now}
            onOpen={(id) => setActive({ server: id, channel: null })}
            onCreate={noop}
            onOpenProposal={(srv, id) => {
              setActive({ server: srv, channel: null });
              setLedger(id);
            }}
            onIdentity={() => setOpenModal(modals['modal-identity'])}
            onSecure={() => setOpenModal(modals['modal-secure'])}
          />
        )}
        {openModal && (
          <Modal
            modal={openModal}
            onClose={() => setOpenModal(null)}
            onVerify={() => setOpenModal(null)}
            onSecurePasskey={noop}
            onSecurePassword={noop}
            onSecureFile={noop}
            identityKey="demo"
          />
        )}
        {paletteOpen && (
          <CommandPalette
            servers={list}
            active={active.server}
            actions={[{ id: 'a', label: 'create invite link', hint: 'action', glyph: <Key size={14} />, run: noop }]}
            onNavigate={(srv, ch) => setActive({ server: srv, channel: ch })}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
      {ledger &&
        (() => {
          const proposal = (activeServer?.proposals ?? []).find((p) => p.id === ledger);
          return proposal ? (
            <SigningDialog
              proposal={proposal}
              server={activeServer}
              me={me}
              threshold={activeServer.threshold}
              verified={(activeServer.verified ?? []).includes(proposal.by)}
              onSign={noop}
              onObject={noop}
              onWithdraw={noop}
              onCompare={() => setOpenModal(modals['modal-safety'])}
              onClose={() => setLedger(null)}
            />
          ) : null;
        })()}
      <PhoneTabs
        server={activeServer}
        channel={active.channel}
        onStage={!!stage}
        onGame={!!(liveGame && active.channel)}
        onCircles={() => setActive({ server: null, channel: null })}
        onBoard={() => setActive({ ...active, channel: null })}
        onRooms={() => setActive({ ...active, channel: activeServer?.channels?.[0] ?? null })}
      />
    </div>
  );
}

function pick() {
  if (view === 'boot') return <BootLoader />;
  if (view === 'onboarding' || view === 'invited') return <Onboarding controller={mockController} />;
  if (view === 'empty') return <PreviewShell empty />;
  if (view === 'circles') return <PreviewShell circles />;
  if (view === 'emptychat') return <PreviewShell emptyChat />;
  if (view === 'overview') return <PreviewShell landing />;
  if (view === 'overview-idle') return <PreviewShell landing idle />;
  if (view === 'banner') return <PreviewShell banner />;
  if (view === 'palette') return <PreviewShell palette />;
  if (view === 'call') return <PreviewShell stage={stageVoice([])} />;
  if (view === 'game')
    return (
      <PreviewShell
        landing
        game={{ id: 'g1', name: 'Hex Gambit', url: '/games/hexgambit.html', kind: 'activity' }}
      />
    );
  if (view === 'call-share') return <PreviewShell stage={stageVoice(['bob'])} />;
  if (view === 'signing') return <PreviewShell landing signing />;
  if (modals[view]) return <PreviewShell modal={modals[view]} />;
  return <PreviewShell />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode>{pick()}</React.StrictMode>);
