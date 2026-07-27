// PROTOTYPE BOARDS — not wired into the app.
//
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
  Hash, External, LinkGlyph, Bell,
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
        note="One division of the field plus an occasional charge, keyed to the circle id — heraldry's answer to being legible when small. Hues are quantised to a 12-stop wheel so neighbours in the rail never land next to each other."
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

/* ----------------------------------------------------------------------- */

const BOARDS = { identity: Identity, hue: Hue, home: HomeBoard };
const Board = BOARDS[board] ?? Identity;
createRoot(document.getElementById('root')).render(<Board />);
