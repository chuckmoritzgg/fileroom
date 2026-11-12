// Favourites, groups and invitations: calling known devices into a room from anywhere.
//   NODE_PATH=$(npm root -g) node tests/e2e/favorites.e2e.mjs
// There is no real push service here: the mock relay records what would be sent, the test decrypts it
// like the receiving browser would and hands it to that phone's page (the service worker's job).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { startMockServer } from './mock-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const chromePath = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const mock = await startMockServer();
const browser = await chromium.launch({ executablePath: chromePath });
const errors = [];
const stamp = Date.now() % 100000;
const subtle = webcrypto.subtle;

async function device(name) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Family' : undefined));
  // A push subscription as the browser would create it; the test keeps the private key to read the pushes.
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  page.push = { ua, uaPublic: Buffer.from(await subtle.exportKey('raw', ua.publicKey)), auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))), endpoint: `https://fcm.googleapis.com/fcm/send/${name}` };
  return page;
}
async function go(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.fileroom?.ready && window.fileroom.online && window.fileroomContacts?._state.self);
  return page;
}
const E = (page, fn, arg) => page.evaluate(fn, arg);
const setName = (page, name) => E(page, (n) => {
  document.querySelector('[data-action="change-name"]').click();
  document.getElementById('profileName').value = n;
  document.getElementById('profileForm').requestSubmit();
}, name);
const reachable = (page) => E(page, async ({ endpoint, p256dh, auth }) => window.fileroomContacts._setPush(
  { sub: { endpoint, keys: { p256dh, auth } }, vapid: await window.FileRoomCrypto.generateVapid() }),
{ endpoint: page.push.endpoint, p256dh: page.push.uaPublic.toString('base64url'), auth: page.push.auth.toString('base64url') });
async function readPush(page, push) { // RFC 8291, like the receiving browser
  const { ua, uaPublic, auth } = page.push;
  const body = Buffer.from(push.body, 'base64url');
  const asPublic = body.subarray(21, 21 + body[20]);
  const hkdf = async (salt, ikm, info, len) => Buffer.from(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const shared = Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, ua.privateKey, 256));
  const ikm = await hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = await hkdf(body.subarray(0, 16), ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(body.subarray(0, 16), ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.subarray(21 + body[20])));
  return JSON.parse(plain.subarray(0, -1).toString());
}
const pushesFor = (page) => mock.seen.pushes.filter((p) => p.endpoint === page.push.endpoint);
const kid = (page) => E(page, () => window.fileroom.keys?.kid || null);
const click = (page, selector) => E(page, (s) => document.querySelector(s).click(), selector);
const step = (text) => console.log(`  ✓ ${text}`);

try {
  const alice = await device('Alice'), bob = await device('Bob'), carol = await device('Carol'), dave = await device('Dave');

  console.log('Known devices that can be reached');
  await go(alice, `${mock.url}/room/MEET${stamp}?new=1`);
  await setName(alice, 'Alice');
  const meet = await E(alice, () => window.fileroom.inviteUrl());
  await go(bob, meet); await setName(bob, 'Bob'); await reachable(bob);
  await go(carol, meet); await setName(carol, 'Carol'); await reachable(carol);
  await go(dave, meet); await setName(dave, 'Dave'); // Dave never allowed notifications
  await alice.waitForFunction(() => { const c = [...window.fileroomContacts._state.contacts.values()]; return c.length === 3 && c.filter((x) => Object.keys(x.pushes || {}).length).length === 2 && c.every((x) => x.name); });
  assert.ok(!JSON.stringify(mock.seen.signals).includes('fcm.googleapis.com'), 'push addresses are exchanged encrypted');
  step('Alice knows Bob, Carol and Dave; Bob and Carol told her (encrypted) how to notify them');

  // Everybody goes somewhere else.
  await go(bob, `${mock.url}/room/BOBSPLACE${stamp}`);
  await carol.goto('about:blank'); // app closed
  await go(dave, `${mock.url}/room/DAVESPLACE${stamp}`);

  console.log('Inviting favourites into a room');
  const room = `PARTY${stamp}`;
  await go(alice, `${mock.url}/room/${room}?new=1`);
  await alice.fill('#messageInput', 'photos from today');
  await alice.click('[data-action="send"]');
  await click(alice, '[data-action="open-people"]');
  await alice.waitForFunction(() => document.querySelectorAll('#peopleList li').length === 3);
  const ids = await E(alice, () => Object.fromEntries([...window.fileroomContacts._state.contacts.values()].map((c) => [c.name, c.id])));
  await click(alice, `[data-action="people-fav"][data-id="${ids.Bob}"]`);
  await alice.waitForFunction(() => document.querySelector('#peopleList li .people-btn.on'));
  assert.match(await alice.locator('#peopleList li').first().textContent(), /Bob/, 'favourites come first');
  assert.equal(await alice.locator('#peopleList li.muted').count(), 1, 'Dave is shown as not reachable');
  for (const name of ['Bob', 'Carol', 'Dave']) await E(alice, (id) => document.querySelector(`#peopleList input[data-contact="${id}"]`).click(), ids[name]);
  await click(alice, '[data-action="people-save-group"]'); // prompt answered with "Family"
  await alice.waitForFunction(() => /Family \(3\)/.test(document.getElementById('peopleGroups').textContent));
  await alice.fill('#peopleText', 'come and look');
  await click(alice, '[data-action="people-invite"]');
  await alice.waitForFunction(() => !document.getElementById('peopleModal').classList.contains('show'));
  assert.equal(mock.seen.pushes.length, 2, 'one push per reachable device');
  const secret = await E(alice, () => window.fileroom.secret);
  const forBob = await readPush(bob, pushesFor(bob)[0]);
  assert.deepEqual({ t: forBob.t, room: forBob.room, name: forBob.name }, { t: 'invite', room, name: 'Alice' });
  assert.ok(!JSON.stringify(forBob).includes(secret) && !JSON.stringify(forBob).includes('come and look'), 'key and note are sealed inside the push, for Bob\'s identity only');
  assert.ok(!JSON.stringify(mock.seen.pushes).includes(room), 'the relay cannot even see which room');
  step('favourite starred, group "Family" saved, 2 of 3 invited by encrypted push (Dave cannot be reached)');

  console.log('Receiving an invitation');
  // Bob has FileRoom open in another room: banner, one tap, he is in - with the key.
  assert.equal(await E(bob, (p) => window.fileroomContacts.receiveInvite(p), forBob), true);
  await bob.waitForSelector('#inviteBanner:not(.d-none)', { state: 'attached' });
  assert.match(await bob.locator('#inviteText').textContent(), new RegExp(`Alice invites you to room ${room}`));
  await click(bob, '#inviteBanner [data-action="invite-join"]');
  await bob.waitForFunction((r) => window.fileroom?.ready && window.fileroom.roomCode === r && window.fileroom.keys, room, { timeout: 15000 });
  assert.equal(await kid(bob), await kid(alice));
  await bob.waitForFunction(() => [...document.querySelectorAll('.message.text')].some((m) => m.textContent.includes('photos from today')));
  step('phone in another room: banner "Alice invites you…", one tap switches rooms and the content is readable');

  // Carol had the app closed: the notification opens the room with the invitation in the link.
  const forCarol = await readPush(carol, pushesFor(carol)[0]);
  const sw = readFileSync(path.join(root, 'pwa/sw.template.js'), 'utf8');
  const inviteNotification = new Function(`${sw.slice(sw.indexOf('function inviteNotification'), sw.indexOf('async function showInvite'))}; return inviteNotification;`)();
  const shown = inviteNotification(forCarol, forCarol.room);
  assert.equal(shown.title, 'Alice invites you to a room');
  await go(carol, mock.url + shown.options.data.url);
  await carol.waitForFunction(() => window.fileroom.keys, null, { timeout: 15000 });
  assert.equal(await kid(carol), await kid(alice));
  assert.equal(new URL(carol.url()).search, '', 'the invitation is removed from the address');
  step('app closed: tapping the notification opens the room, key included');

  // Not from a known device, or changed on the way: ignored.
  const elsewhere = `${mock.url}/room/DAVESPLACE${stamp}`;
  assert.equal(await E(dave, (p) => window.fileroomContacts.receiveInvite(p), forBob), false, 'an invitation sealed for Bob means nothing to Dave');
  await go(bob, elsewhere);
  const forged = { ...forBob, d: forBob.d.slice(0, -4) + (forBob.d.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  assert.equal(await E(bob, (p) => window.fileroomContacts.receiveInvite(p), forged), false, 'a modified invitation is rejected');
  assert.equal(await bob.locator('#inviteBanner.d-none').count(), 1);
  step('invitations that are not from a known device, or were altered, are ignored');

  console.log('Sharing from another app to a group');
  await alice.goto(`${mock.url}/?share=local`);
  await E(alice, () => new Promise((resolve, reject) => {
    const open = indexedDB.open('fileroom-share', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('pending');
    open.onsuccess = () => { const tx = open.result.transaction('pending', 'readwrite');
      tx.objectStore('pending').put({ created: Date.now(), title: null, text: 'look at this', url: null, files: [new File(['IMG'], 'pic.txt', { type: 'text/plain' })] }, 'share');
      tx.oncomplete = resolve; tx.onerror = reject; };
  }));
  await alice.reload();
  await alice.waitForFunction(() => document.querySelectorAll('#sharePeopleList li').length === 2);
  assert.match(await alice.locator('#sharePeopleList li').first().textContent(), /Bob/);
  await click(alice, '#sharePeopleGroups [data-group]');
  await alice.waitForFunction(() => !document.getElementById('sharePeopleBtn').disabled);
  mock.seen.pushes.length = 0;
  await click(alice, '#sharePeopleBtn');
  await alice.waitForFunction(() => window.fileroom?.ready && window.fileroom.keys && document.querySelectorAll('.message').length === 2, null, { timeout: 20000 });
  const deadline = Date.now() + 10000;
  while (mock.seen.pushes.length < 2 && Date.now() < deadline) await alice.waitForTimeout(200);
  assert.equal(mock.seen.pushes.length, 2, 'both reachable group members are invited');
  const shareRoom = await E(alice, () => window.fileroom.roomCode);
  const again = await readPush(bob, pushesFor(bob)[0]);
  assert.equal(again.room, shareRoom);
  assert.equal(await E(bob, (p) => window.fileroomContacts.receiveInvite(p, { open: true }), again), true); // tap on the notification, app open
  await bob.waitForFunction((r) => window.fileroom?.ready && window.fileroom.roomCode === r && document.querySelectorAll('.message').length === 2, shareRoom, { timeout: 15000 });
  assert.equal(await bob.locator('.message.locked').count(), 0, 'Bob can read what was shared');
  const stored = (await (await fetch(`${mock.url}/api/room/${shareRoom}/data`)).json()).messages;
  assert.ok(stored.every((m) => m.type === 'sealed' || m.enc), 'the server only has ciphertext');
  step('share sheet: tick a group, content goes into a new encrypted room, members are invited and can read it');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll favourites tests passed');
} finally {
  await browser.close();
  await mock.close();
}
