// Linked devices: one identity on several devices of the same person.
//   NODE_PATH=$(npm root -g) node tests/e2e/linked.e2e.mjs
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
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Family' : undefined));
  return page;
}
const ready = (page) => page.waitForFunction(() => window.fileroom?.ready && window.fileroom.online && window.fileroomContacts?._state.self, null, { timeout: 20000 });
async function go(page, url) { await page.goto(url); await ready(page); return page; }
const E = (page, fn, arg) => page.evaluate(fn, arg);
const click = (page, selector) => E(page, (s) => document.querySelector(s).click(), selector);
const setName = (page, name) => E(page, (n) => {
  document.querySelector('[data-action="change-name"]').click();
  document.getElementById('profileName').value = n;
  document.getElementById('profileForm').requestSubmit();
}, name);
const reachable = (page, name) => E(page, async (n) => { // a push subscription as the browser would create it
  const C = window.FileRoomCrypto;
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = C.b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return window.fileroomContacts._setPush({ sub: { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh, auth: C.b64(crypto.getRandomValues(new Uint8Array(16))) } }, vapid: await C.generateVapid() });
}, name);
const identity = (page) => E(page, () => window.fileroomContacts._state.self.pub);
const kid = (page) => E(page, () => window.fileroom.keys?.kid || null);
const lists = (page) => E(page, () => ({
  contacts: [...window.fileroomContacts._state.contacts.values()].map((c) => `${c.alias || c.name}${c.fav ? '*' : ''}`).sort(),
  groups: (window.fileroom.storage.get('fileroom_groups') || []).map((g) => `${g.name}:${g.members.length}`),
  name: window.fileroom.profile.name,
}));
const step = (text) => console.log(`  ✓ ${text}`);

try {
  const phone = await device('phone'), tablet = await device('tablet'), bob = await device('Bob'), carol = await device('Carol'), thief = await device('thief');

  console.log('A phone with known devices, a favourite and a group');
  await go(phone, `${mock.url}/room/MEET${stamp}?new=1`);
  await setName(phone, 'Alice'); await reachable(phone, 'alice-phone');
  const meet = await E(phone, () => window.fileroom.inviteUrl());
  await go(bob, meet); await setName(bob, 'Bob'); await reachable(bob, 'bob');
  await go(carol, meet); await setName(carol, 'Carol');
  await phone.waitForFunction(() => { const c = [...window.fileroomContacts._state.contacts.values()]; return c.length === 2 && c.every((x) => x.name); });
  await bob.waitForFunction(() => [...window.fileroomContacts._state.contacts.values()].some((c) => c.name === 'Alice' && Object.keys(c.pushes || {}).length === 1));
  const ids = await E(phone, () => Object.fromEntries([...window.fileroomContacts._state.contacts.values()].map((c) => [c.name, c.id])));
  await click(phone, '[data-action="open-people"]');
  await click(phone, `[data-action="people-fav"][data-id="${ids.Bob}"]`);
  for (const n of ['Bob', 'Carol']) await E(phone, (id) => document.querySelector(`#peopleList input[data-contact="${id}"]`).click(), ids[n]);
  await click(phone, '[data-action="people-save-group"]');
  await phone.waitForFunction(() => (window.fileroom.storage.get('fileroom_groups') || []).length === 1);
  await click(phone, '[data-action="close-people"]');
  const before = await lists(phone);
  assert.deepEqual(before, { contacts: ['Bob*', 'Carol'], groups: ['Family:2'], name: 'Alice' });
  step('phone: knows Bob (favourite) and Carol, group "Family", name Alice');

  console.log('Linking the tablet');
  await go(phone, `${mock.url}/room/HOME${stamp}?new=1`);
  assert.notEqual(await identity(await go(tablet, `${mock.url}/room/OTHER${stamp}`)), await identity(phone), 'two devices, two identities');
  await click(phone, '[data-action="link-start"]');
  await phone.waitForSelector('#linkBox:not(.d-none)', { state: 'attached' });
  const link = await phone.inputValue('#linkUrl');
  assert.match(link, /#link=[A-Za-z0-9_-]{22}$/);
  assert.ok((await phone.getAttribute('#linkQr', 'src')).startsWith('data:image/svg+xml'), 'the code is drawn on the device');
  const privateD = await E(phone, async () => (await crypto.subtle.exportKey('jwk', window.fileroomContacts._state.self.priv)).d);

  // Somebody who did not see the code cannot get anything, even from inside the room.
  await go(thief, link.replace(/#link=.*/, '#link=AAAAAAAAAAAAAAAAAAAAAA'));
  await thief.waitForTimeout(3500);
  assert.notEqual(await identity(thief), await identity(phone));

  await tablet.goto(link); // both sides confirm (dialogs are accepted)
  await tablet.waitForFunction((pub) => window.fileroomContacts?._state.self?.pub === pub && window.fileroom?.ready, await identity(phone), { timeout: 30000 });
  await tablet.waitForFunction(() => window.fileroom?.ready && window.fileroom.keys && window.fileroomContacts?._state.self, null, { timeout: 20000 }); // after its restart
  await ready(tablet);
  assert.deepEqual(await lists(tablet), before, 'known devices, favourite, group and name arrived');
  assert.equal(await kid(tablet), await kid(phone), 'the tablet also got the key of the room they are in');
  assert.equal(new URL(tablet.url()).hash.includes('link='), false, 'the one-time secret is gone from the address');
  assert.equal(await E(tablet, () => window.fileroom.user.name), 'Alice');
  const wire = JSON.stringify(mock.seen.signals);
  assert.ok(!wire.includes(privateD) && !wire.includes(await E(phone, () => window.fileroom.secret)), 'the server relayed only ciphertext');
  step('tablet scanned the code: same identity, same known devices, favourites, group, name and room key');

  // The code worked once. A second device with the same link gets nothing.
  await go(carol, link);
  await carol.waitForTimeout(3500);
  assert.notEqual(await identity(carol), await identity(phone), 'a code links one device only');
  step('wrong code: nothing; used code: nothing');

  console.log('The linked device is the same person to everybody else');
  const room = `LATER${stamp}`;
  await go(bob, `${mock.url}/room/${room}`);
  await go(tablet, `${mock.url}/room/${room}`); // Bob has never seen the tablet
  await reachable(tablet, 'alice-tablet');
  await Promise.all([bob, tablet].map((p) => p.waitForFunction(() => window.fileroom.keys, null, { timeout: 15000 })));
  assert.equal(await kid(bob), await kid(tablet));
  await bob.waitForSelector('#usersList .user-known', { state: 'attached' });
  step('Bob recognises the tablet as Alice; the room encrypts itself');

  // Bob now knows two addresses for Alice: an invitation goes to both of her devices.
  await bob.waitForFunction(() => [...window.fileroomContacts._state.contacts.values()].some((c) => c.name === 'Alice' && Object.keys(c.pushes || {}).length === 2));
  await tablet.goto('about:blank');
  await bob.waitForFunction(() => window.fileroom.users.length === 1, null, { timeout: 15000 });
  mock.seen.pushes.length = 0;
  const result = await E(bob, async () => window.fileroomContacts.invite([[...window.fileroomContacts._state.contacts.values()].find((c) => c.name === 'Alice').id]));
  assert.equal(result.sent, 1, JSON.stringify([result, mock.seen.pushes.length]));
  assert.deepEqual(mock.seen.pushes.map((p) => p.endpoint.split('/').pop()).sort(), ['alice-phone', 'alice-tablet']);
  step('an invitation for Alice reaches her phone and her tablet');

  console.log('Lists stay in line');
  await go(tablet, `${mock.url}/room/HOME${stamp}`);
  await phone.waitForFunction(() => document.querySelector('#usersList .bi-phone-fill'), null, { timeout: 15000 });
  await E(tablet, (id) => { document.querySelector('[data-action="open-people"]').click(); document.querySelector(`[data-action="people-fav"][data-id="${id}"]`).click(); }, ids.Carol);
  await phone.waitForFunction(() => [...window.fileroomContacts._state.contacts.values()].find((c) => c.name === 'Carol')?.fav, null, { timeout: 10000 });
  await click(phone, '[data-action="open-people"]');
  await click(phone, '[data-action="people-group-delete"]');
  await tablet.waitForFunction(() => (window.fileroom.storage.get('fileroom_groups') || []).length === 0, null, { timeout: 10000 });
  step('own devices in one room: a new favourite on the tablet appears on the phone, a deleted group disappears on the tablet');

  console.log('Unlinking');
  await click(tablet, '[data-action="contacts-forget"]');
  await tablet.waitForFunction((pub) => window.fileroomContacts._state.self.pub !== pub && window.fileroomContacts._state.contacts.size === 0, await identity(phone));
  step('"Forget known devices & reset identity" on the tablet: it is a separate device again');

  // A device set up before linking existed has an identity that cannot be copied: it gets a new one first.
  console.log('Identity from an older version');
  await E(thief, () => new Promise((resolve, reject) => {
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']).then(async (pair) => {
      const pub = window.FileRoomCrypto.b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
      const open = indexedDB.open('fileroom-identity', 1);
      open.onsuccess = () => { const t = open.result.transaction('self', 'readwrite'); t.objectStore('self').put({ priv: pair.privateKey, pub, created: 1 }, 'identity'); t.oncomplete = resolve; t.onerror = reject; };
    });
  }));
  await thief.reload(); await ready(thief);
  const oldPub = await identity(thief);
  assert.equal(await E(thief, () => window.fileroomContacts._state.self.priv.extractable), false);
  await click(thief, '[data-action="link-start"]'); // the explanation is confirmed
  await thief.waitForSelector('#linkBox:not(.d-none)', { state: 'attached' });
  assert.notEqual(await identity(thief), oldPub);
  assert.equal(await E(thief, () => window.fileroomContacts._state.self.priv.extractable), true);
  step('old, locked identity: replaced by a new one (after asking) before a code is shown');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll linked-device tests passed');
} finally {
  await browser.close();
  await mock.close();
}
