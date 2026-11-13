// The conditions the main journey never met, each of which broke the product
// while every other suite stayed green:
//
//   A. a reload at a bad moment — just after being added, just after a room
//      key arrives, and after a member was removed (a rotated key)
//   B. the same account open in two tabs
//   C. the same account on several devices, all of them sending
//   D. more than one circle: getting to the list of them, and staying there
//   E. a global admin deleting a circle that nobody can open any more
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
    t.section('C. the same account on several devices');
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

    /** Sign in as dan on a fresh device. */
    const signIn = async (label) => {
      const page = (await device(label)).page;
      await page.goto(base);
      await page.click('[data-testid=tab-signin]');
      await page.fill('[data-testid=signin-handle]', 'dan');
      await page.click('[data-testid=signin-continue]');
      await page.fill('[data-testid=signin-password]', 'tyre pressures at dawn');
      await page.click('[data-testid=signin-submit]');
      return page;
    };
    /** A device can send once its composer is live and nothing says read-only. */
    const canSend = (page, timeout = 20000) =>
      page
        .waitForFunction(
          () =>
            !document.querySelector('[data-testid=restored-note]') &&
            document.querySelector('[data-testid=composer]') &&
            !document.querySelector('[data-testid=composer]').disabled,
          { timeout }
        )
        .then(() => true, () => false);

    const phone = await signIn('dan-phone');
    t.check('signing in on a second device brings the circle with it', await inCircle(phone, 30000).then(() => true, () => false));
    await phone.click('[data-testid=channel-general]');
    t.check('…with its history', await sees(phone, 'written before dan joined'));
    // Nobody does anything: the phone asks, and the circle — here dan's own
    // laptop — lets it in on the strength of its certificate.
    t.check('…and it is let in to send, without anyone being asked', await canSend(phone));

    await say(phone, 'dan on the phone');
    t.check('the second device sends', await sees(alice, 'dan on the phone'));
    t.check('…and the first device sees what the second wrote', await sees(laptop, 'dan on the phone'));
    t.check('the first device was not displaced', await canSend(laptop, 3000));
    await say(laptop, 'dan back on the laptop');
    t.check('the first device still sends', await sees(alice, 'dan back on the laptop'));
    t.check('…and the second sees it', await sees(phone, 'dan back on the laptop'));
    await say(alice, 'to dan, wherever he is');
    t.check('both of the account’s devices receive', (await sees(phone, 'to dan, wherever he is')) && (await sees(laptop, 'to dan, wherever he is')));

    await board(alice);
    const roster = await alice.textContent('[data-testid=member-list]');
    t.check('the roster lists the account once', roster.split('dan').length === 2);
    await room(alice, 'general');

    await phone.reload();
    await inCircle(phone);
    await online(phone);
    await room(phone, 'general');
    t.check('the second device is still a full member after a reload', await canSend(phone, 8000));
    await say(phone, 'dan on the phone, after a reload');
    t.check('…and its ratchet survived it', await sees(alice, 'dan on the phone, after a reload'));

    // Neither of dan's devices online: a third still gets in, because any
    // member may add a device its owner's identity key has certified.
    await laptop.context().close();
    await phone.context().close();
    const tablet = await signIn('dan-tablet');
    await inCircle(tablet, 30000);
    await tablet.click('[data-testid=channel-general]');
    t.check('with none of the account’s devices online, another member lets a new one in', await canSend(tablet));
    await say(tablet, 'dan on the tablet');
    t.check('…and it sends', await sees(alice, 'dan on the tablet'));
    t.check('…and reads what its siblings wrote', await sees(tablet, 'dan on the phone, after a reload'));

    // Removing a person removes every device of theirs.
    await board(alice);
    alice.once('dialog', (d) => d.accept());
    await alice.click('[data-testid=remove-member-dan]');
    t.check('removing the member puts every device out', await tablet.waitForSelector('[data-testid=circles-home]', { timeout: 15000 }).then(() => true, () => false));
  }

  // ------------------------------------------------------------------ D --
  {
    t.section('D. more than one circle');
    const alice = (await device('alice4')).page;
    const bob = (await device('bob4')).page;
    await onboard(alice, base, 'amy');
    await createCircle(alice, 'First Circle');
    await onboard(bob, base, 'bo');
    await bob.waitForTimeout(800);
    await propose(alice, 'bo');
    await inCircle(bob);
    await room(bob, 'general');

    // On a wide screen the only route to the list of circles was the
    // phone's tab bar, which is not there. So: from the fascia.
    await alice.click('[data-testid=masthead-home]');
    t.check('the list of circles is reachable from inside a circle', await alice.waitForSelector('[data-testid=circles-home]', { timeout: 10000 }).then(() => true, () => false));
    // Every message anywhere produces a roster update, and each one used to
    // throw whoever was on this screen into their first circle.
    await say(bob, 'said while amy is on circles home');
    await alice.waitForTimeout(1500);
    t.check('…and a message arriving elsewhere does not throw you off it', await alice.locator('[data-testid=circles-home]').count() === 1);

    await alice.click('[data-testid=new-server]');
    await alice.fill('[data-testid=new-server-name]', 'Second Circle');
    await alice.press('[data-testid=new-server-name]', 'Enter');
    t.check(
      'a second circle can be started from there',
      await alice
        .waitForFunction(() => document.querySelector('[data-testid=server-name]')?.textContent === 'Second Circle', { timeout: 15000 })
        .then(() => true, () => false)
    );
    await room(alice, 'general');
    await say(alice, 'only in the second circle');

    await alice.click('[data-testid=masthead-home]');
    await alice.waitForSelector('[data-testid=circles-home]');
    await alice.click('[data-testid^=circles-open-first-circle]');
    await room(alice, 'general');
    t.check('switching back shows the first circle’s conversation', await sees(alice, 'said while amy is on circles home'));
    t.check('…and not the other one’s', !(await sees(alice, 'only in the second circle', 1500)));
    await say(alice, 'amy, back in the first circle');
    t.check('…and it still sends', await sees(bob, 'amy, back in the first circle'));
  }
} catch (e) {
  crashed = e;
}

await stack.stop().catch(() => {});

// -------------------------------------------------------------------- E --
// Its own relay: a global admin is a deployment setting (RELAY_ADMINS).
if (!crashed) {
  const admin = await startStack(Number(process.env.E2E_PORT ?? 9710) + 1, { RELAY_ADMINS: 'root' });
  try {
    t.section('E. a global admin clears out a circle nobody can use');
    const amy = (await admin.device('amy5')).page;
    const root = (await admin.device('root')).page;
    await onboard(amy, admin.base, 'amy');
    await createCircle(amy, 'Stuck Circle');
    await say(amy, 'something said in it');
    await onboard(root, admin.base, 'root');

    // root is not in the circle and never was: the relay's overview is the
    // only place it appears for them, by id.
    await root.keyboard.press('Control+k');
    await root.waitForSelector('.palette-input');
    await root.fill('.palette-input', 'relay admin');
    await root.keyboard.press('Enter');
    const row = root.locator('[data-testid^=admin-delete-stuck-circle]');
    t.check('the overview lists a circle the admin is not in', await row.waitFor({ timeout: 10000 }).then(() => true, () => false));
    root.once('dialog', (d) => d.accept());
    await row.click();
    t.check('deleting it removes it from the relay', await row.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false));

    await amy.reload();
    t.check(
      'its members’ devices drop it the next time they connect',
      await amy.waitForSelector('[data-testid=circles-home]', { timeout: 20000 }).then(() => true, () => false)
    );
    t.check('…and say why', await sees(amy, 'you no longer have access', 8000));
    // Not for everyone: amy has no such entry in her palette.
    await amy.keyboard.press('Control+k');
    await amy.waitForSelector('.palette-input');
    await amy.fill('.palette-input', 'relay admin');
    await amy.waitForTimeout(400);
    t.check('someone who is not a global admin is not offered the overview', (await amy.locator('text=relay admin overview').count()) === 0);
  } catch (e) {
    crashed = e;
  }
  await admin.stop().catch(() => {});
}
const failed = t.failed();
if (crashed) console.error(`\nstopped early: ${crashed.message}`);
if (failed.length || crashed) {
  console.error(`\nFAIL: ${failed.length} expectation(s) did not hold${failed.length ? ':\n  - ' + failed.join('\n  - ') : ''}`);
  process.exit(1);
}
console.log('\nPASS: reloads at bad moments, two tabs, several devices, several circles, admin clean-up');
process.exit(0);
