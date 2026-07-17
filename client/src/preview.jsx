// Dev-only UI gallery (`npm run preview:ui`): the real components, mock
// state, no relay and no crypto core. Mirrors App.jsx's ready-phase layout —
// if App's shell changes, keep this in step. Views:
//   /preview.html?view=app            main surface, carbon
//   /preview.html?view=app&theme=paper
//   /preview.html?view=onboarding | invited | empty | banner | overview
//   /preview.html?view=modal-safety | modal-invite | modal-secure | modal-identity
//   /preview.html?view=palette | call | call-share
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Masthead from './components/Masthead.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Rail from './components/Rail.jsx';
import Channels from './components/Channels.jsx';
import Messages from './components/Messages.jsx';
import Overview from './components/Overview.jsx';
import Members from './components/Members.jsx';
import Modal from './components/Modal.jsx';
import Onboarding from './components/Onboarding.jsx';
import CallStage from './components/CallStage.jsx';
import Seal from './components/Seal.jsx';
import { Key, Bell, ShieldCheck, QuorumGlyph } from './components/icons.jsx';

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
    roles: { alice: 'admin' },
    overview: {
      blurb:
        'Pit crew HQ for the season. Race weekends run out of #logistics; #pit-wall is live timing only.',
      links: [
        { label: 'stint sheet', url: 'https://example.com/stints' },
        { label: 'tyre pressure log', url: 'https://example.com/tyres' },
      ],
      event: {
        title: 'Qualifying — Round 4, Spa',
        at: now + 52 * H,
        note: 'Trailer leaves 6am. Pack the spare diffuser tonight.',
      },
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
  { sender: 'bob', text: 'scrutineering passed — we are P4 on the grid', ts: now - 26 * H },
  { sender: 'bob', text: 'stewards want the wing endplate photos before nine', ts: now - 26 * H + 40e3 },
  { sender: 'alice', text: 'on it. tyre pressures from this morning still good?', ts: now - 25.6 * H },
  { system: true, text: 'charlie joined via invite link — unverified until someone checks their safety number', ts: now - 25 * H },
  { sender: 'charlie', text: 'found my way in via the link, reading up now', ts: now - 24.8 * H },
  { sender: 'alice', text: 'dropped 0.2 up front, track temp is way up', ts: now - 3 * H },
  { sender: 'alice', file: { name: 'tyre-temps.png', mime: 'image/png', size: 48213 }, ts: now - 3 * H + 30e3 },
  { sender: 'alice', text: 'left front is the one to watch', ts: now - 3 * H + 55e3 },
  { sender: 'dana', text: 'trailer leaves at 6am sharp — pack the spare diffuser tonight', ts: now - 2.2 * H },
  { sender: 'bob', file: { name: 'stint-plan.pdf', mime: 'application/pdf', size: 182044 }, ts: now - 1.1 * H },
  { sender: 'bob', text: 'plan B if it rains: box on lap 14 and go long', ts: now - 1.1 * H + 20e3 },
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
  active: { server: 'srv-race', channel: 'lounge' },
  listenOnly: false,
  connections: { bob: 'connected', dana: 'connecting…' },
  presence: { 'srv-race/lounge': ['alice', 'bob', 'dana'] },
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
  'modal-safety': {
    type: 'safety',
    server: 'srv-race',
    peer: 'charlie',
    number: '39217 55018 82649 10473 66392 04815 77260 93148 25501 68937 41205 87716',
    verified: false,
  },
};

function PreviewShell({ empty = false, banner = false, modal = null, palette = false, stage = null, landing = false }) {
  const me = 'alice';
  // channel: null means the circle's overview page, same as App.jsx.
  const [active, setActive] = useState({
    server: empty ? null : 'srv-race',
    channel: landing ? null : 'general',
  });
  const [overviews, setOverviews] = useState({});
  const [noticesBy, setNoticesBy] = useState({});
  const [openModal, setOpenModal] = useState(modal);
  const [paletteOpen, setPaletteOpen] = useState(palette);
  const [drawer, setDrawer] = useState(null); // narrow screens: null | 'nav' | 'roster'
  const list = empty ? [] : servers;
  const activeServer = list.find((s) => s.id === active.server) ?? null;

  return (
    <div className="app-shell" data-drawer={drawer ?? undefined}>
      <Masthead
        server={activeServer}
        connection="online"
        theme={theme}
        onInvite={() => setOpenModal(modals['modal-invite'])}
        onPalette={() => setPaletteOpen(true)}
        onTheme={() => {
          document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === 'paper' ? 'carbon' : 'paper';
        }}
        onMenu={() => setDrawer((d) => (d === 'nav' ? null : 'nav'))}
        onRoster={() => setDrawer((d) => (d === 'roster' ? null : 'roster'))}
      />
      {banner && (
        <div className="secure-banner" data-testid="secure-banner">
          <Key size={14} />
          <span>
            this account exists only in this browser — lose it and <strong>{me}</strong> is gone forever
          </span>
          <button className="button">secure account</button>
        </div>
      )}
      <div className="app">
        {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />}
        <nav className="sidebar">
          <Rail
            servers={list}
            active={active.server}
            onSelect={(id) => {
              setActive({ server: id, channel: null }); // land on the overview
              setDrawer(null);
            }}
            onCreate={noop}
          />
          {activeServer && (
            <Channels
              server={activeServer}
              activeChannel={active.channel}
              me={me}
              onSelect={(ch) => {
                setActive({ ...active, channel: ch });
                setDrawer(null);
              }}
              onCreate={noop}
              voice={voice}
              onVoiceJoin={noop}
              onVoiceLeave={noop}
            />
          )}
          <div className="self-card">
            <Seal name={me} size={32} />
            <span className="who">
              <span className="handle">{me}</span>
              <span className="status online">online</span>
            </span>
            <button className="icon-btn" title="identity key"><Key size={14} /></button>
            <button className="icon-btn" title="alerts"><Bell size={14} /></button>
          </div>
        </nav>
        {activeServer && stage ? (
          <CallStage
            voice={stage}
            manager={mockVoiceManager}
            me={me}
            messages={callMessages}
            canSend
            onSend={noop}
            onShare={noop}
            onStopShare={noop}
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
                messages={messages}
                onSend={noop}
                onSendFile={noop}
                fetchFile={async (f) => {
                  if ((f.mime ?? '').startsWith('image/')) return PNG;
                  throw new Error('preview: no blob store');
                }}
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
                voice={voice}
                digestKey="preview"
                loadDigest={async (id) => digestMock[id] ?? []}
                onSelectChannel={(ch) => setActive({ ...active, channel: ch })}
                onVoiceJoin={noop}
                onSave={(ov) => setOverviews((o) => ({ ...o, [activeServer.id]: ov }))}
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
            <Members server={activeServer} me={me} onAdd={noop} onMember={() => setOpenModal(modals['modal-safety'])} />
          </>
        ) : (
          <div className="empty-state">
            <div>
              <div className="glyph-lg"><QuorumGlyph size={44} /></div>
              <h2>No circles yet</h2>
              <p className="muted">
                Start one from the sidebar, follow an invite link, or ask someone to add you —
                they need your handle: <strong>{me}</strong>
              </p>
              <div className="row">
                <button className="button"><Key size={14} /> identity key</button>
                <button className="button"><ShieldCheck size={14} /> secure account</button>
              </div>
            </div>
          </div>
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
    </div>
  );
}

function pick() {
  if (view === 'onboarding' || view === 'invited') return <Onboarding controller={mockController} />;
  if (view === 'empty') return <PreviewShell empty />;
  if (view === 'overview') return <PreviewShell landing />;
  if (view === 'banner') return <PreviewShell banner />;
  if (view === 'palette') return <PreviewShell palette />;
  if (view === 'call') return <PreviewShell stage={stageVoice([])} />;
  if (view === 'call-share') return <PreviewShell stage={stageVoice(['bob'])} />;
  if (modals[view]) return <PreviewShell modal={modals[view]} />;
  return <PreviewShell />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode>{pick()}</React.StrictMode>);
