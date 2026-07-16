// Dev-only UI gallery (`npm run preview:ui`): the real components, mock
// state, no relay and no crypto core. Mirrors App.jsx's ready-phase layout —
// if App's shell changes, keep this in step. Views:
//   /preview.html?view=app            main surface, carbon
//   /preview.html?view=app&theme=paper
//   /preview.html?view=onboarding | invited | empty | banner
//   /preview.html?view=modal-safety | modal-invite | modal-secure | modal-identity
//   /preview.html?view=palette
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Masthead from './components/Masthead.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Rail from './components/Rail.jsx';
import Channels from './components/Channels.jsx';
import Messages from './components/Messages.jsx';
import Members from './components/Members.jsx';
import Modal from './components/Modal.jsx';
import Onboarding from './components/Onboarding.jsx';
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

const voice = {
  active: { server: 'srv-race', channel: 'lounge' },
  listenOnly: false,
  connections: { bob: 'connected', dana: 'connecting…' },
  presence: { 'srv-race/lounge': ['alice', 'bob', 'dana'] },
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

function PreviewShell({ empty = false, banner = false, modal = null, palette = false }) {
  const me = 'alice';
  const [active, setActive] = useState({ server: empty ? null : 'srv-race', channel: 'general' });
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
              setActive({ server: id, channel: 'general' });
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
        {activeServer ? (
          <>
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
  if (view === 'banner') return <PreviewShell banner />;
  if (view === 'palette') return <PreviewShell palette />;
  if (modals[view]) return <PreviewShell modal={modals[view]} />;
  return <PreviewShell />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode>{pick()}</React.StrictMode>);
