// The conditions the main journey never met, each of which broke the product
// while every other suite stayed green:
//
//   A. a reload at a bad moment — just after being added, just after a room
//      key arrives, and after a member was removed (a rotated key)
//   B. the same account open in two tabs
//   C. the same account on two devices
//
// `run.mjs` walks one long happy path with one tab per person. These are
// short, independent, and about what ordinary use does to that path. Every
// expectation is listed; the suite fails if any did not hold.
import { board, createCircle, inCircle, inviteLink, ledger, onboard, online, propose, room, say, sees, signProposal, startStack } from './lib.mjs';

const stack = await startStack(Number(process.env.E2E_PORT ?? 9710));
const { base, device } = stack;
const t = ledger();
let crashed = null;

try {
  // ------------------------------------------------------------------ A --
  {
    t.section('A. a reload at a bad moment');
    const alice = (await device('alice')).page;
    const bob = (await device('bob')).page;
    await onboard(alice, base, 'alice');
    await createCircle(alice, 'Race Team');
    await say(alice, 'written before bob joined');
    await onboard(bob, base, 'bob');
    await bob.waitForTimeout(800); // bob's KeyPackages reach the relay

    await propose(alice, 'bob');
    await inCircle(bob);
    await bob.reload(); // the instant the circle appears
    t.check('added, reloaded at once: the circle is still there', await inCircle(bob).then(() => true, () => false));
    await online(bob);
    t.check(
      '…under its real name',
      await bob
        .waitForFunction(() => document.querySelector('[data-testid=server-name]')?.textContent === 'Race Team', { timeout: 10000 })
        .then(() => true, () => false)
    );
    await room(bob, 'general');
    t.check('…and the joiner reads what was written before they joined', await sees(bob, 'written before bob joined'));

    await room(alice, 'general');
    await alice.click('[data-testid=new-channel]');
    await alice.fill('[data-testid=new-channel-name]', 'pits');
    await alice.press('[data-testid=new-channel-name]', 'Enter');
    await bob.waitForSelector('[data-testid=channel-pits]', { timeout: 10000 });
    await bob.waitForTimeout(300);
    await bob.reload(); // inside the window the room key used to be lost in
    await room(alice, 'pits');
    await say(alice, 'alice in the new room');
    await inCircle(bob);
    await online(bob);
    await room(bob, 'pits');
    t.check('a room key that had just arrived survives a reload', await sees(bob, 'alice in the new room'));
    await say(bob, 'bob in the new room');
    t.check('…and the room works both ways', await sees(alice, 'bob in the new room'));

    const charlie = (await device('charlie')).page;
    await onboard(charlie, base, 'charlie');
    await charlie.waitForTimeout(800);
    await propose(alice, 'charlie');
    await signProposal(bob);
    await inCircle(charlie);
    await alice.waitForTimeout(1000);
    await board(alice);
    alice.once('dialog', (d) => d.accept());
    await alice.click('[data-testid=remove-member-charlie]');
    t.check('the removed member is put out', await charlie.waitForSelector('[data-testid=circles-home]', { timeout: 15000 }).then(() => true, () => false));
    await room(alice, 'general');
    await room(bob, 'general');
    await say(alice, 'alice after the removal');
    t.check('chat continues after a removal', await sees(bob, 'alice after the removal'));
    await say(bob, 'bob after the removal');
    // Seen by the other side before anyone reloads: a line is on its
    // author's screen a moment before the relay has it.
    t.check('…in both directions', await sees(alice, 'bob after the removal'));
    for (const [name, page] of [['bob', bob], ['alice', alice]]) {
      await page.reload();
      await inCircle(page);
      await online(page);
      await room(page, 'general');
      t.check(
        `${name} reloads and still reads what was written after the removal`,
        (await sees(page, 'alice after the removal')) &&
          (await sees(page, 'bob after the removal', 4000)) &&
          (await sees(page, 'written before bob joined', 4000))
      );
    }
    for (const page of [alice, bob, charlie]) await page.context().close();
  }

  // ------------------------------------------------------------------ B --
  {
    t.section('B. the same account in two tabs');
    const alice = (await device('alice2')).page;
    const bobDevice = await device('bob2');
    const bob = bobDevice.page;
    await onboard(alice, base, 'ana');
    await createCircle(alice, 'Photo Club');
    await onboard(bob, base, 'ben');
    await bob.waitForTimeout(800);
    await propose(alice, 'ben');
    await inCircle(bob);
    await room(alice, 'general');
    await room(bob, 'general');

    const second = await bobDevice.newTab();
    await second.goto(base);
    t.check('a second tab is told the app is open elsewhere', await second.waitForSelector('[data-testid=session-elsewhere]', { timeout: 10000 }).then(() => true, () => false));
    await say(alice, 'while two tabs are open');
    t.check('the first tab keeps receiving', await sees(bob, 'while two tabs are open'));
    await say(bob, 'from the first tab');
    t.check('…and what it sends can still be read', await sees(alice, 'from the first tab'));

    await second.click('[data-testid=session-take]');
    await inCircle(second);
    t.check('taking the session here stops the other tab', await bob.waitForSelector('[data-testid=session-superseded]', { timeout: 10000 }).then(() => true, () => false));
    await online(second);
    await room(second, 'general');
    await say(second, 'from the second tab');
    t.check('the tab that took over sends', await sees(alice, 'from the second tab'));
    await say(alice, 'to the second tab');
    t.check('…and receives', await sees(second, 'to the second tab'));

    await bob.click('[data-testid=session-take]'); // and back again
    await inCircle(bob);
    await online(bob);
    await room(bob, 'general');
    t.check('handing it back: the other tab is stopped in turn', await second.waitForSelector('[data-testid=session-superseded]', { timeout: 10000 }).then(() => true, () => false));
    await say(bob, 'back on the first tab');
    t.check('…and the ratchet survived both handovers', await sees(alice, 'back on the first tab'));
    await say(alice, 'after both handovers');
    t.check('…in both directions', await sees(bob, 'after both handovers'));
    await alice.context().close();
    await bobDevice.context.close();
  }

  // ------------------------------------------------------------------ C --
  {
    t.section('C. the same account on two devices');
    const alice = (await device('alice3')).page;
    await onboard(alice, base, 'ava');
    await createCircle(alice, 'Book Circle');
    await say(alice, 'written before dan joined');
    const url = await inviteLink(alice);

    const laptop = (await device('dan-laptop')).page;
    await laptop.goto(url);
    await laptop.fill('[data-testid=handle-input]', 'dan');
    await laptop.click('[data-testid=join-fast]');
    await inCircle(laptop);
    await laptop.click('[data-testid=secure-now]');
    await laptop.fill('[data-testid=secure-password]', 'tyre pressures at dawn');
    await laptop.click('[data-testid=secure-password-submit]');
    await laptop.waitForFunction(() => !document.querySelector('[data-testid=secure-banner]'), { timeout: 30000 });
    await room(laptop, 'general');
    await room(alice, 'general');
    await say(laptop, 'dan on the laptop');
    await sees(alice, 'dan on the laptop');

    const phone = (await device('dan-phone')).page;
    await phone.goto(base);
    await phone.click('[data-testid=tab-signin]');
    await phone.fill('[data-testid=signin-handle]', 'dan');
    await phone.click('[data-testid=signin-continue]');
    await phone.fill('[data-testid=signin-password]', 'tyre pressures at dawn');
    await phone.click('[data-testid=signin-submit]');
    t.check('signing in on a second device brings the circle with it', await inCircle(phone, 30000).then(() => true, () => false));
    await phone.click('[data-testid=channel-general]');
    t.check('…with its history', await sees(phone, 'written before dan joined'));
    t.check('…read-only, and saying so', await phone.waitForSelector('[data-testid=restored-note]', { timeout: 10000 }).then(() => true, () => false));

    await say(alice, 'while the phone is signed in');
    t.check('the laptop keeps receiving', await sees(laptop, 'while the phone is signed in'));
    t.check('the read-only phone sees new messages as they are sent', await sees(phone, 'while the phone is signed in'));
    await say(laptop, 'dan again, on the laptop');
    t.check('…including what the same account wrote elsewhere', await sees(phone, 'dan again, on the laptop'));

    // One identity holds one sending seat. Opening an invite link on the
    // phone moves it there; the laptop must say so and keep reading, not
    // sit there looking like a member with a ratchet that no longer works.
    await phone.goto(url);
    await inCircle(phone);
    await online(phone);
    await room(phone, 'general');
    t.check('the laptop is told it is now read-only', await laptop.waitForSelector('[data-testid=restored-note]', { timeout: 15000 }).then(() => true, () => false));
    await say(phone, 'dan on the phone');
    t.check('the phone can send once the seat moves to it', await sees(alice, 'dan on the phone'));
    t.check('the laptop, now read-only, still sees it', await sees(laptop, 'dan on the phone'));
    await say(alice, 'to dan, wherever he is');
    t.check('both of the account’s devices receive', (await sees(phone, 'to dan, wherever he is')) && (await sees(laptop, 'to dan, wherever he is')));
    await board(alice);
    const roster = await alice.textContent('[data-testid=member-list]');
    t.check('the roster lists the account once', roster.split('dan').length === 2);
  }
} catch (e) {
  crashed = e;
}

await stack.stop().catch(() => {});
const failed = t.failed();
if (crashed) console.error(`\nstopped early: ${crashed.message}`);
if (failed.length || crashed) {
  console.error(`\nFAIL: ${failed.length} expectation(s) did not hold${failed.length ? ':\n  - ' + failed.join('\n  - ') : ''}`);
  process.exit(1);
}
console.log('\nPASS: reloads at bad moments, two tabs, two devices');
process.exit(0);
