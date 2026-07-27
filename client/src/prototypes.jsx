// PROTOTYPE BOARDS — not wired into the app.
//
//   /prototypes.html?board=seal       the encryption claim, before / after
//   /prototypes.html?board=panel      what the padlock opens
//   /prototypes.html?board=mobile     the same, collapsed for a phone
//   /prototypes.html?board=identity   circle marks, three treatments
//   /prototypes.html?board=hue        how far the circle hue should reach
//   /prototypes.html?board=home       the generalised home, gaming vs not
//   ...&theme=paper
//
// These render against the real styles.css so the tokens, radii and type are
// honest. Prototype-only scaffolding is prefixed `p-`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './prototypes.css';
import Crest from './components/Crest.jsx';
import Seal from './components/Seal.jsx';
import { idHue } from './lib/crest.js';
import {
  Camera, Gamepad, Users, Wave, Screen, Archive, Clock, Key,
  Hash, External, LinkGlyph, Bell, Lock, Check, AlertTriangle, X,
} from './components/icons.jsx';

const params = new URLSearchParams(location.search);
const board = params.get('board') ?? 'identity';
document.documentElement.dataset.theme = params.get('theme') ?? 'carbon';

// Eight circles of the kind quorum is actually for — one shared thing each,
// and only two of them about games.
const CIRCLES = [
  { id: 'srv-race', name: 'Race Team', glyph: Gamepad },
  { id: 'srv-photo', name: 'Darkroom Society', glyph: Camera },
  { id: 'srv-choir', name: 'Thursday Choir', glyph: Wave },
  { id: 'srv-allot', name: 'Allotment 14', glyph: null },
  { id: 'srv-book', name: 'Book Club', glyph: Archive },
  { id: 'srv-ride', name: 'Sunday Riders', glyph: null },
  { id: 'srv-lan', name: 'Basement LAN', glyph: Screen },
  { id: 'srv-crew', name: 'Site Crew', glyph: Users },
];

const monogram = (n) =>
  n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function Row({ label, note, children }) {
  return (
    <section className="p-row">
      <h2 className="overline">{label}</h2>
      {note && <p className="p-note">{note}</p>}
      <div className="p-tiles">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------ board: identity -- */

function Identity() {
  return (
    <div className="p-board">
      <header className="p-head">
        <h1>Circle identity</h1>
        <p className="p-lede">
          Derived by default, chosen as an overlay, never blank. Shown at rail
          size (44px) — the size that actually has to work.
        </p>
      </header>

      <Row
        label="A · today"
        note="Monogram on a gradient keyed to the name. Renaming the circle changes its face."
      >
        {CIRCLES.map((c) => {
          const hue = idHue(c.id);
          return (
            <figure key={c.id} className="p-tile">
              <span
                className="circle-tile p-static"
                style={{
                  background: `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 42) % 360} 68% 58%))`,
                }}
              >
                {monogram(c.name)}
              </span>
              <figcaption>{c.name}</figcaption>
            </figure>
          );
        })}
      </Row>

      <Row
        label="B · derived mark"
        note="A generated gradient, keyed to the circle id — nothing drawn on top. Variation lives in the hues, the geometry (a linear sweep or a radial source) and where the light falls. Hues run on an arc from 15° to 295°, never a full wheel: the 80° around coral is a dead zone no circle can enter, anchor or companion, so a mark never reads as 'selected'."
      >
        {CIRCLES.map((c) => (
          <figure key={c.id} className="p-tile">
            <Crest id={c.id} name={c.name} />
            <figcaption>{c.name}</figcaption>
          </figure>
        ))}
      </Row>

      <Row
        label="C · chosen crest, derived fallback"
        note="Four circles picked a glyph; four never did and keep their mark. Both are legible; neither spells the name out."
      >
        {CIRCLES.map((c) => (
          <figure key={c.id} className="p-tile">
            <Crest id={c.id} name={c.name} glyph={c.glyph} />
            <figcaption>{c.name}</figcaption>
          </figure>
        ))}
      </Row>

      <Row label="D · the rail, in context" note="Eight circles as you would actually scan them.">
        <div className="p-rail">
          {CIRCLES.map((c, i) => (
            <span key={c.id} className={i === 0 ? 'p-railslot active' : 'p-railslot'}>
              <Crest id={c.id} name={c.name} glyph={c.glyph} size={44} />
            </span>
          ))}
        </div>
      </Row>
    </div>
  );
}

/* ----------------------------------------------------------- board: hue -- */

// How far the circle hue should travel. Surfaces only — it never touches
// coral, green, amber or red, which carry meaning.
function HueRoom({ circle, rooms, active }) {
  const hue = idHue(circle.id);
  const style = {
    '--circle-hue': hue,
    '--circle-tint': `hsl(${hue} 40% 50% / 0.10)`,
    '--circle-edge': `hsl(${hue} 50% 55% / 0.32)`,
  };
  return (
    <div className="p-room" style={style}>
      <div className="p-room-head">
        <Crest id={circle.id} name={circle.name} glyph={circle.glyph} size={34} />
        <div>
          <strong>{circle.name}</strong>
          <span className="p-sub">{circle.members} members</span>
        </div>
      </div>
      <div className="p-room-body">
        <span className="overline p-tinted">rooms</span>
        <ul className="p-rooms">
          {rooms.map((r) => (
            <li key={r} className={r === active ? 'p-roomrow on' : 'p-roomrow'}>
              <Hash size={13} /> {r}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Hue() {
  return (
    <div className="p-board">
      <header className="p-head">
        <h1>How far the hue reaches</h1>
        <p className="p-lede">
          Rail tile, home header, section rule, active-room marker — and
          nothing else. Two circles side by side: the question is whether
          switching between them feels like changing rooms.
        </p>
      </header>
      <div className="p-two">
        <HueRoom
          circle={{ ...CIRCLES[0], members: 12 }}
          rooms={['general', 'logistics', 'pit-wall']}
          active="general"
        />
        <HueRoom
          circle={{ ...CIRCLES[1], members: 23 }}
          rooms={['general', 'critique', 'darkroom']}
          active="critique"
        />
        <HueRoom
          circle={{ ...CIRCLES[2], members: 31 }}
          rooms={['general', 'rehearsal']}
          active="rehearsal"
        />
      </div>
      <p className="p-foot">
        The tint is one translucent hue over <code>--panel</code>, so it holds
        in both themes without a second palette.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- board: home -- */

function Band({ icon: Icon, label, children, tone }) {
  return (
    <section className={tone ? `p-band ${tone}` : 'p-band'}>
      <h3 className="overline">
        <Icon size={11} /> {label}
      </h3>
      {children}
    </section>
  );
}

function CatchUp({ rows }) {
  return (
    <ul className="p-catch">
      {rows.map((r) => (
        <li key={r.room}>
          <span className="p-catch-room">
            <Hash size={12} /> {r.room}
          </span>
          <span className="p-catch-last">{r.last}</span>
          {r.unread > 0 && <span className="unread-badge">{r.unread}</span>}
        </li>
      ))}
    </ul>
  );
}

function ShelfCard({ kind, name, host, note }) {
  const K = { app: Screen, place: Key, link: LinkGlyph }[kind];
  return (
    <article className="p-shelf-card">
      <header>
        <K size={13} />
        <strong>{name}</strong>
        <span className="p-kind">{kind}</span>
      </header>
      <p className="p-host">{host}</p>
      {note && <p className="p-shelf-note">{note}</p>}
    </article>
  );
}

function Home({ circle, sections }) {
  const hue = idHue(circle.id);
  return (
    <div
      className="p-home"
      style={{
        '--circle-tint': `hsl(${hue} 40% 50% / 0.10)`,
        '--circle-edge': `hsl(${hue} 50% 55% / 0.32)`,
      }}
    >
      <div className="p-home-head">
        <Crest id={circle.id} name={circle.name} glyph={circle.glyph} size={30} />
        <h2>home</h2>
        <span className="p-sub">{circle.name}</span>
      </div>
      {sections}
    </div>
  );
}

function HomeBoard() {
  return (
    <div className="p-board">
      <header className="p-head">
        <h1>Home, with sections that appear when populated</h1>
        <p className="p-lede">
          Same page, same code. The photo club never sees a games section and
          nobody configured a "circle type" — the sections simply have nothing
          to render.
        </p>
      </header>

      <div className="p-two wide">
        <Home
          circle={CIRCLES[0]}
          sections={
            <>
              <Band icon={Wave} label="live now" tone="live">
                <p className="p-live">
                  <strong>2 in the lounge</strong> · bob and dana are in{' '}
                  <strong>Hex Gambit</strong>
                </p>
              </Band>
              <Band icon={Bell} label="rally">
                <p>
                  charlie is up for <strong>Tanks! Night Ops</strong>
                </p>
              </Band>
              <Band icon={Clock} label="coming up">
                <p>
                  <strong>Qualifying — Round 4, Spa</strong>
                  <span className="p-when">Tue 11:16 · in 26 h</span>
                </p>
              </Band>
              <Band icon={Hash} label="catch up">
                <CatchUp
                  rows={[
                    { room: 'logistics', last: 'trailer leaves at 6am sharp', unread: 3 },
                    { room: 'general', last: 'plan B if it rains: box on lap 14', unread: 0 },
                    { room: 'pit-wall', last: '—', unread: 0 },
                  ]}
                />
              </Band>
              <Band icon={Archive} label="the shelf">
                <div className="p-shelf">
                  <ShelfCard kind="app" name="Hex Gambit" host="bundled with quorum" />
                  <ShelfCard kind="place" name="Craftworld" host="mc.raceteam.example:25565" />
                </div>
              </Band>
            </>
          }
        />

        <Home
          circle={CIRCLES[1]}
          sections={
            <>
              <Band icon={Clock} label="coming up">
                <p>
                  <strong>Print swap — bring 3</strong>
                  <span className="p-when">Sat 14:00 · in 4 days</span>
                </p>
              </Band>
              <Band icon={Hash} label="catch up">
                <CatchUp
                  rows={[
                    { room: 'critique', last: 'new darkroom scans are up', unread: 1 },
                    { room: 'general', last: 'anyone got spare fixer?', unread: 0 },
                    { room: 'darkroom', last: '—', unread: 0 },
                  ]}
                />
              </Band>
              <Band icon={Bell} label="noticeboard">
                <p>Enlarger 2 has a dodgy timer — edda is on it.</p>
              </Band>
              <Band icon={Archive} label="the shelf">
                <div className="p-shelf">
                  <ShelfCard
                    kind="link"
                    name="Club gallery"
                    host="gallery.darkroom.example"
                    note="that site sees your connection, not your chat"
                  />
                  <ShelfCard kind="app" name="Contact sheet" host="bundled with quorum" />
                </div>
              </Band>
            </>
          }
        />
      </div>

      <p className="p-foot">
        No <code>PLAY</code>/<code>HOME</code> tabs, no stored default tab, and
        no "No games yet" for a circle that does not play games. The word
        "game" appears nowhere in the chrome.
      </p>
    </div>
  );
}


/* ---------------------------------------------------------- board: seal -- */

// The five states the claim can actually be in. Today the composer renders
// "End-to-end encrypted · N members" in all five, unchanged — including the
// three where it is not the whole truth.
const STATES = [
  {
    key: 'plain',
    label: 'nothing is reduced',
    seal: 'ok',
    before: 'End-to-end encrypted · 4 members',
    after: null,
    why: 'The padlock in the room header already said this. A second copy under the composer is the wallpaper that makes the exceptions invisible.',
  },
  {
    key: 'unchecked',
    label: 'someone unchecked',
    seal: 'warn',
    before: 'End-to-end encrypted · 4 members',
    after: 'Encrypted, but nobody has checked 2 of these keys',
    why: '"· 4 members" quietly claims something about who those four are. Two of them are unverified strangers as far as this device knows.',
  },
  {
    key: 'kept',
    label: 'history is kept',
    seal: 'warn',
    before: 'End-to-end encrypted · 4 members',
    after: 'Encrypted · history kept — anyone added later can read this room',
    why: 'The one room property that trades away forward secrecy, and the footer read identically to a room that had not.',
  },
  {
    key: 'offline',
    label: 'not connected',
    seal: 'off',
    before: 'End-to-end encrypted · 4 members',
    after: 'Not connected — messages will send when the relay is back',
    why: 'Nothing is being encrypted because nothing is being sent. The claim was true and irrelevant, which is its own kind of wrong.',
  },
  {
    key: 'forked',
    label: 'out of sync',
    seal: 'bad',
    before: 'End-to-end encrypted · 4 members',
    after: 'Your view of this circle has forked — you may be missing messages',
    why: 'The fork note above the composer already says this. The claim below it contradicted the warning.',
  },
];

function SealGlyph({ state }) {
  return (
    <span className={`p-seal ${state}`}>
      <Lock size={13} />
      {state === 'warn' && <i className="p-seal-dot warn" />}
      {state === 'bad' && <i className="p-seal-dot bad" />}
      {state === 'off' && <i className="p-seal-dot off" />}
    </span>
  );
}

function SealBoard() {
  return (
    <div className="p-board">
      <header className="p-head">
        <h1>The claim, before and after</h1>
        <p className="p-lede">
          Today one string renders in every state. The proposal: the padlock
          carries the state, silence is the healthy case, and prose is spent
          only where something is actually reduced.
        </p>
      </header>

      {STATES.map((st) => (
        <section key={st.key} className="p-state">
          <div className="p-state-label">
            <span className="overline">{st.label}</span>
          </div>
          <div className="p-state-cols">
            <div className="p-state-col">
              <span className="p-tag now">today</span>
              <div className="p-fauxhead">
                <Lock size={13} />
                <strong>general</strong>
              </div>
              <div className="p-fauxcomposer">Message #general</div>
              <div className="p-fauxnote">
                <Lock size={11} /> {st.before}
              </div>
            </div>
            <div className="p-state-col">
              <span className="p-tag next">proposed</span>
              <div className="p-fauxhead">
                <SealGlyph state={st.seal} />
                <strong>general</strong>
              </div>
              <div className="p-fauxcomposer">Message #general</div>
              {st.after ? (
                <div className={`p-fauxnote ${st.seal}`}>
                  <AlertTriangle size={11} /> {st.after}
                </div>
              ) : (
                <div className="p-fauxnote empty">— nothing —</div>
              )}
            </div>
          </div>
          <p className="p-why">{st.why}</p>
        </section>
      ))}

      <p className="p-foot">
        Four of five states now say something the old string never did, and the
        fifth says nothing at all — which is what makes the other four legible.
      </p>
    </div>
  );
}

/* --------------------------------------------------------- board: panel -- */

const PEOPLE_OK = [
  { name: 'alice', tag: 'you' },
  { name: 'bob', tag: 'checked', when: '12 Mar' },
  { name: 'dana', tag: 'checked', when: '4 Apr' },
  { name: 'marek', tag: 'checked', when: '4 Apr' },
];
const PEOPLE_BAD = [
  { name: 'alice', tag: 'you' },
  { name: 'bob', tag: 'checked', when: '12 Mar' },
  { name: 'dana', tag: 'unchecked' },
  { name: 'charlie', tag: 'link' },
];

function PersonRow({ p }) {
  return (
    <li className="p-person">
      <Seal name={p.name} size={22} />
      <span className="p-person-name">{p.name}</span>
      {p.tag === 'you' && <span className="badge-you">you</span>}
      {p.tag === 'checked' && (
        <span className="p-person-state ok">
          <Check size={11} /> checked {p.when}
        </span>
      )}
      {p.tag === 'unchecked' && (
        <>
          <span className="p-person-state warn">not checked</span>
          <button className="button p-check">check</button>
        </>
      )}
      {p.tag === 'link' && (
        <>
          <span className="p-person-state warn">via link · not checked</span>
          <button className="button p-check">check</button>
        </>
      )}
    </li>
  );
}

function Panel({ title, people, kept, retention, connection, unchecked }) {
  return (
    <div className="p-panel">
      <div className="p-panel-head">
        <SealGlyph state={unchecked ? 'warn' : 'ok'} />
        <strong>{title}</strong>
        <button className="p-panel-x" aria-label="close"><X size={13} /></button>
      </div>
      <p className="p-panel-lede">
        Messages here are sealed on your device and opened only by the people
        below. The relay carries them and cannot read them.
      </p>

      <h4 className="overline">who can read this room — {people.length}</h4>
      <ul className="p-people">
        {people.map((p) => <PersonRow key={p.name} p={p} />)}
      </ul>

      <h4 className="overline">history</h4>
      <p className={kept ? 'p-panel-line warn' : 'p-panel-line'}>
        {kept
          ? 'Kept. Anyone added to this circle later can read everything in this room, including messages sent before they joined.'
          : 'Not kept. People added later start from their first message — nobody can hand them the past.'}
      </p>

      <h4 className="overline">auto-delete</h4>
      <p className="p-panel-line">
        {retention
          ? `Messages disappear ${retention} after sending. A shared setting, not a guarantee — a device that keeps a copy keeps it.`
          : 'Off. Messages stay on the devices that received them.'}
      </p>

      <h4 className="overline">connection</h4>
      <p className={connection === 'live' ? 'p-panel-line' : 'p-panel-line warn'}>
        {connection === 'live'
          ? 'Live. Messages are going out as you send them.'
          : 'Offline. Messages will send when the relay is back.'}
      </p>
    </div>
  );
}

function PanelBoard() {
  return (
    <div className="p-board">
      <header className="p-head">
        <h1>What the padlock opens</h1>
        <p className="p-lede">
          Everything the old footer implied, said properly and on demand. The
          member count stops being a number and becomes the thing it was always
          standing in for — which four, and whether anyone has checked them.
        </p>
      </header>
      <div className="p-two">
        <Panel
          title="#general"
          people={PEOPLE_OK}
          kept={false}
          retention={null}
          connection="live"
          unchecked={false}
        />
        <Panel
          title="#pit-wall"
          people={PEOPLE_BAD}
          kept
          retention="1 day"
          connection="live"
          unchecked
        />
      </div>
      <p className="p-foot">
        Left: nothing is reduced, so the room header shows a plain padlock and
        the composer says nothing. Right: two unchecked keys and kept history —
        the padlock carries a mark, and one line appears under the composer.
      </p>
    </div>
  );
}

/* -------------------------------------------------------- board: mobile -- */

function MobileBoard() {
  return (
    <div className="p-board">
      <header className="p-head">
        <h1>The same, on a phone</h1>
        <p className="p-lede">
          Today the narrow breakpoint deletes both disclosures with
          <code> display: none</code> and keeps the unconditional claim. The
          rule is that a disclosure may collapse but never disappear — and
          collapsing only counts if the entry point visibly changes.
        </p>
      </header>

      <div className="p-phones">
        <figure className="p-phone">
          <figcaption>today</figcaption>
          <div className="p-screen">
            <div className="p-fauxhead mob">
              <Lock size={13} /> <strong>pit-wall</strong>
            </div>
            <div className="p-screen-body">
              <p className="p-ghost">…messages…</p>
            </div>
            <div className="p-fauxcomposer mob">Message #pit-wall</div>
            <div className="p-fauxnote mob">
              <Lock size={11} /> End-to-end encrypted · 4 members
            </div>
          </div>
          <p className="p-why">
            Kept history and auto-delete are both switched off by
            <code> display: none</code>. The one room in the circle that is not
            forward-secret looks exactly like the three that are — under a line
            that says it is encrypted.
          </p>
        </figure>

        <figure className="p-phone">
          <figcaption>proposed</figcaption>
          <div className="p-screen">
            <div className="p-fauxhead mob">
              <SealGlyph state="warn" /> <strong>pit-wall</strong>
            </div>
            <div className="p-chips">
              <button className="p-chip warn"><Archive size={10} /> history kept</button>
              <button className="p-chip"><Clock size={10} /> 1 day</button>
              <button className="p-chip warn">2 unchecked</button>
            </div>
            <div className="p-screen-body">
              <p className="p-ghost">…messages…</p>
            </div>
            <div className="p-fauxcomposer mob">Message #pit-wall</div>
            <div className="p-fauxnote mob warn">
              <AlertTriangle size={11} /> history kept · 2 unchecked
            </div>
          </div>
          <p className="p-why">
            Chips carry the facts in a line, each one tappable into the panel.
            Nothing is hidden; it is abbreviated. The healthy room shows no
            chips and no note at all.
          </p>
        </figure>

        <figure className="p-phone">
          <figcaption>the panel, as a sheet</figcaption>
          <div className="p-screen sheet">
            <Panel
              title="#pit-wall"
              people={PEOPLE_BAD}
              kept
              retention="1 day"
              connection="live"
              unchecked
            />
          </div>
          <p className="p-why">
            The same panel as desktop, full width. This is where the detail
            lives on every surface, so there is one thing to write and one
            thing to keep true.
          </p>
        </figure>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

const BOARDS = { identity: Identity, hue: Hue, home: HomeBoard, seal: SealBoard, panel: PanelBoard, mobile: MobileBoard };
const Board = BOARDS[board] ?? Identity;
createRoot(document.getElementById('root')).render(<Board />);
