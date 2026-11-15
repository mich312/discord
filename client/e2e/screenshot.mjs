// Drive a short two-user session and screenshot the client. Dev tooling,
// not a test — useful for docs and eyeballing the visual register.
//
// One relay serving the built client on one origin, as deployed (lib.mjs).
// Run after: npm run build, cargo build -p relay.
import { startStack, onboard, createCircle, propose, inCircle, room, board, say } from './lib.mjs';

const PORT = Number(process.env.PORT ?? 9730);
const out = process.env.SHOT_PATH ?? '/tmp/client.png';

const stack = await startStack(PORT);
try {
  const alice = (await stack.device('alice')).page;
  const bob = (await stack.device('bob')).page;
  for (const page of [alice, bob]) await page.setViewportSize({ width: 1280, height: 800 });

  await onboard(alice, stack.base, 'alice');
  await createCircle(alice, 'Race Team');
  await onboard(bob, stack.base, 'bob');
  await propose(alice, 'bob'); // a circle of one: this adds him
  await inCircle(bob);
  await room(alice, 'general');
  await room(bob, 'general');

  const script = [
    [alice, 'scrutineering passed, we are P4 on the grid'],
    [bob, 'nice. tyre pressures from this morning still good?'],
    [alice, 'dropped 0.2 up front, track temp is way up'],
  ];
  for (const [page, text] of script) await say(page, text);

  // A second room, from the strip's "+" menu.
  await alice.click('[data-testid=new-room-menu]');
  await alice.click('[data-testid=new-channel]');
  await alice.fill('[data-testid=new-channel-name]', 'logistics');
  await alice.press('[data-testid=new-channel-name]', 'Enter');
  await bob.waitForSelector('[data-testid=channel-logistics]', { timeout: 10000 });
  await room(alice, 'general');

  // An encrypted attachment (2x2 PNG) and a verified member for the shot.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC',
    'base64'
  );
  await alice.setInputFiles('[data-testid=attach-input]', {
    name: 'tyre-temps.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await bob.waitForSelector('[data-testid=attachment-img]', { timeout: 15000 });
  await board(bob);
  await bob.click('[data-testid=member-alice]');
  await bob.waitForSelector('[data-testid=mark-verified]');
  await bob.click('[data-testid=mark-verified]');
  await bob.click('[data-testid=close-modal]').catch(() => {});
  await room(bob, 'general');
  await bob.waitForTimeout(400);

  await bob.screenshot({ path: out });
  console.log(`saved ${out}`);
} finally {
  await stack.stop();
}
process.exit(0);
