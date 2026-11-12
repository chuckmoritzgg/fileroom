// Known devices: persistent identity and name, recognition in later rooms, automatic encryption.
//   NODE_PATH=$(npm root -g) node tests/e2e/contacts.e2e.mjs
// Every browser context is one phone (its own storage and identity).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startMockServer } from './mock-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const chromePath = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const mock = await startMockServer();
const browser = await chromium.launch({ executablePath: chromePath });
const errors = [];
const stamp = Date.now() % 100000;

async function device(name) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return page;
}
async function go(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.fileroom?.ready && window.fileroom.online && window.fileroomContacts?._state.self);
  return page;
}
async function setName(page, name, isPublic = true) {
  await page.evaluate(([n, p]) => {
    document.querySelector('[data-action="change-name"]').click();
    document.getElementById('profileName').value = n;
    document.getElementById('profilePublic').checked = p;
    document.getElementById('profileForm').requestSubmit();
  }, [name, isPublic]);
}
const E = (page, fn, arg) => page.evaluate(fn, arg);
const contacts = (page) => E(page, () => [...window.fileroomContacts._state.contacts.values()].map((c) => c.name));
const kid = (page) => E(page, () => window.fileroom.keys?.kid || null);
const hasKey = (page) => page.waitForFunction(() => window.fileroom.keys, null, { timeout: 15000 });
const step = (text) => console.log(`  ✓ ${text}`);
const serverMessages = async (room) => (await (await fetch(`${mock.url}/api/room/${room}/data`)).json()).messages;

try {
  const alice = await device('Alice'), bob = await device('Bob'), carol = await device('Carol');

  console.log('Getting to know each other');
  await go(alice, `${mock.url}/room/MEET${stamp}?new=1`);
  await setName(alice, 'Alice');
  await alice.waitForFunction(() => window.fileroom.user?.name === 'Alice');
  await go(bob, await E(alice, () => window.fileroom.inviteUrl()));
  await setName(bob, 'Bob', false); // Bob stays anonymous in public
  await alice.waitForFunction(() => [...window.fileroomContacts._state.contacts.values()].some((c) => c.name === 'Bob'));
  await bob.waitForFunction(() => [...window.fileroomContacts._state.contacts.values()].some((c) => c.name === 'Alice'));
  const bobPublic = await E(bob, () => window.fileroom.user.name);
  assert.notEqual(bobPublic, 'Bob', 'the server only knows a random name for Bob');
  assert.ok(!JSON.stringify(mock.seen.signals).includes('"Bob"'), 'Bob\'s real name never passes the server in the clear');
  await alice.waitForFunction(() => /\(?Bob\)?/.test(document.querySelector('#usersList .user-alias')?.textContent || ''));
  step(`shared an encrypted room: both remember each other; Bob is "${bobPublic}" in public and "Bob" for Alice`);

  console.log('Meeting again in a room without a key');
  const room2 = `KITCHEN${stamp}`;
  await go(alice, `${mock.url}/room/${room2}`);
  assert.equal(await E(alice, () => window.fileroom.user.name), 'Alice', 'the name is kept for the next room');
  assert.equal(await kid(alice), null, 'a typed room name has no key');
  await go(bob, `${mock.url}/room/${room2}`);
  await Promise.all([hasKey(alice), hasKey(bob)]);
  assert.equal(await kid(alice), await kid(bob), 'both ended up with the same room key');
  await alice.waitForSelector('#usersList .user-known', { state: 'attached' });
  await bob.waitForSelector('#usersList .user-known', { state: 'attached' });
  await bob.fill('#messageInput', 'hello again');
  await bob.click('[data-action="send"]');
  await alice.waitForFunction(() => [...document.querySelectorAll('.message.text')].some((m) => m.textContent.includes('hello again')));
  assert.deepEqual((await serverMessages(room2)).map((m) => m.type), ['sealed'], 'the server only stores ciphertext');
  const secret = await E(alice, () => window.fileroom.secret);
  assert.ok(!JSON.stringify(mock.seen.signals).includes(secret), 'the room key never passes the server in the clear');
  step('both recognised each other and the room encrypted itself; the server saw neither the key nor who is who');

  // Recognition leaves nothing to link: Bob's tag lists differ every time.
  const tagLists = mock.seen.signals.filter((s) => s.includes('"t":"tags"'));
  assert.ok(tagLists.length >= 2 && new Set(tagLists).size === tagLists.length, 'no tag list is ever repeated');
  step('recognition messages are different every time (nothing for the server to link)');

  console.log('A room with a key, a known device arrives without it');
  await go(alice, `${mock.url}/room/NEW${stamp}?new=1`);
  const k3 = await kid(alice);
  await go(bob, `${mock.url}/room/NEW${stamp}`); // only the room name, no key in the link
  await hasKey(bob);
  assert.equal(await kid(bob), k3, 'Bob received the room key from Alice');
  step('known device without the key gets it automatically');

  console.log('Known devices and a stranger');
  const room4 = `MIXED${stamp}`;
  await go(carol, `${mock.url}/room/${room4}`);
  await go(alice, `${mock.url}/room/${room4}`);
  await go(bob, `${mock.url}/room/${room4}`);
  await alice.waitForFunction(() => window.fileroomContacts._state.offer, null, { timeout: 15000 });
  assert.equal(await kid(alice), null, 'nothing is encrypted behind a stranger\'s back');
  assert.equal(await kid(bob), null);
  await E(alice, () => document.querySelector('[data-action="open-key"]').click());
  await alice.waitForSelector('#contactHint:not(.d-none)', { state: 'attached' });
  assert.match(await alice.locator('#contactHint span').textContent(), /Bob is a known device/);
  await E(alice, () => document.querySelector('[data-action="contacts-encrypt"]').click());
  await Promise.all([hasKey(alice), hasKey(bob)]);
  assert.equal(await kid(alice), await kid(bob));
  await carol.waitForTimeout(1500);
  assert.equal(await kid(carol), null, 'the stranger does not get the key');
  assert.equal((await contacts(carol)).length, 0);
  step('with a stranger present the app only offers it; after a tap the known devices share a key, the stranger does not');

  console.log('Forgetting');
  await E(bob, () => document.querySelector('[data-action="contacts-forget"]').click());
  await bob.waitForFunction(() => window.fileroomContacts._state.contacts.size === 0);
  const room5 = `LATER${stamp}`;
  await go(alice, `${mock.url}/room/${room5}`);
  await go(bob, `${mock.url}/room/${room5}`);
  await bob.waitForTimeout(4000);
  assert.equal(await kid(alice), null, 'a forgotten device is a stranger again');
  assert.equal(await kid(bob), null);
  assert.equal(await alice.locator('#usersList .user-known').count(), 0);
  step('"Forget known devices" gives the device a new identity: no recognition, no automatic key');

  console.log('Anonymous');
  await setName(alice, '');
  await alice.waitForFunction(() => window.fileroom.user?.name !== 'Alice');
  const anon1 = await E(alice, () => window.fileroom.user.name);
  await go(alice, `${mock.url}/room/ANON${stamp}`);
  assert.notEqual(await E(alice, () => window.fileroom.user.name), 'Alice');
  step(`name removed: "${anon1}" here, another random name in the next room`);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll known-device tests passed');
} finally {
  await browser.close();
  await mock.close();
}
