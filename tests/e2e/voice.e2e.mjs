/**
 * Browser tests for end-to-end encryption, voice calls and the babyphone.
 *
 *   NODE_PATH=$(npm root -g) node tests/e2e/voice.e2e.mjs
 *
 * Needs the `playwright` and `ws` packages and Chrome (CHROME_PATH, default: Playwright's Chromium).
 * Chrome's fake microphone (a beep every second) stands in for the baby.
 * Set FILEROOM_URL=http://localhost:8181 to run against a real server instead of the built-in mock
 * (the "what did the server see" assertions are skipped then).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { startMockServer } from './mock-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const mock = process.env.FILEROOM_URL ? null : await startMockServer();
const BASE = process.env.FILEROOM_URL || mock.url;
const chromePath = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const browser = await chromium.launch({
  executablePath: chromePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--allow-loopback-in-peer-connection',
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const errors = [];
async function open(url, name) {
  const context = await browser.newContext({ serviceWorkers: 'block', permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ServiceWorker|service worker/i.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(name) : d.accept()));
  await page.goto(url);
  await page.waitForFunction(() => window.fileroom?.ready && window.fileroom.online);
  await page.evaluate((n) => { document.querySelector('[data-action="change-name"]').click(); document.getElementById('profileName').value = n; document.getElementById('profileForm').requestSubmit(); }, name);
  await page.waitForFunction((n) => window.fileroom.user?.name === n, name);
  return page;
}
const state = (page, fn) => page.evaluate(fn);
const connected = (page, count = 1) => page.waitForFunction((n) => {
  const peers = [...window.fileroomVoice._state.peers.values()];
  return peers.filter((p) => p.pc?.connectionState === 'connected' && p.dc?.readyState === 'open').length >= n;
}, count, { timeout: 20000 });
const inboundBytes = (page) => page.evaluate(async () => {
  let bytes = 0;
  for (const p of window.fileroomVoice._state.peers.values()) {
    (await p.pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += s.bytesReceived; });
  }
  return bytes;
});
const step = (text) => console.log(`  ✓ ${text}`);

try {
  // ---------------------------------------------------------------- encrypted room
  console.log('Encrypted room');
  const alice = await open(`${BASE}/room/E2E${Date.now() % 100000}?new=1`, 'Alice');
  const invite = await state(alice, () => window.fileroom.inviteUrl());
  assert.match(invite, /#k=[A-Za-z0-9_-]{22}$/, 'a new random room gets a key in the URL fragment');
  assert.equal(new URL(await alice.url()).search, '', 'the "new" marker is removed from the URL');
  const bob = await open(invite, 'Bob');
  const eve = await open(invite.split('#')[0], 'Eve'); // knows the room name, not the key
  step('new room has a key; invite link carries it in the fragment');

  await alice.fill('#messageInput', 'the secret plan 🤫');
  await alice.click('[data-action="send"]');
  await bob.waitForFunction(() => document.querySelector('.message.text .message-content')?.textContent.includes('the secret plan'));
  await eve.waitForFunction(() => document.querySelector('.message.locked'));
  assert.equal(await eve.locator('.message.text').count(), 0);
  step('text message: readable with the key, locked without it');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await alice.setInputFiles('#fileInput', { name: 'baby-photo.png', mimeType: 'image/png', buffer: png });
  await bob.waitForFunction(() => {
    const img = document.querySelector('.message.image img');
    return img?.src.startsWith('blob:') && img.naturalWidth === 1;
  }, null, { timeout: 15000 });
  assert.match(await bob.locator('.message.image .file-caption').textContent(), /baby-photo\.png/);
  step('image: uploaded as ciphertext, decrypted and displayed on the other device');

  if (mock) {
    const everything = mock.seen.bodies.join('\n') + JSON.stringify([...mock.messages.values()].map(({ body, ...m }) => m));
    assert.ok(!everything.includes('secret plan') && !everything.includes('baby-photo') && !everything.includes('image/png'), 'server saw plaintext');
    assert.ok(!Buffer.concat([...mock.messages.values()].filter((m) => m.body).map((m) => m.body)).includes(png.subarray(0, 16)), 'server saw the file');
    step('the server stored only ciphertext (text, file content, file name and type)');
  }

  const qr = await state(alice, () => { document.querySelector('[data-action="open-qr"]').click(); return document.getElementById('qrImage').src; });
  assert.ok(qr.startsWith('data:image/svg+xml'), 'QR code is generated on the device');
  await alice.keyboard.press('Escape');
  step('QR code is drawn locally (the key is not sent to /api/qr)');

  // ---------------------------------------------------------------- voice call
  console.log('Voice call');
  await alice.click('#voiceHeaderBtn');
  await alice.click('[data-action="voice-call"]');
  await bob.waitForSelector('#ringBanner:not(.d-none)', { timeout: 10000 });
  assert.match(await bob.locator('#ringText').textContent(), /Alice is calling/);
  step('the other device rings');
  await bob.click('[data-action="ring-join"]');
  await Promise.all([connected(alice), connected(bob)]);
  await alice.waitForTimeout(1500);
  assert.ok(await inboundBytes(alice) > 500 && await inboundBytes(bob) > 500, 'audio flows in both directions');
  assert.match(await alice.locator('#vbSecure').textContent(), /End-to-end encrypted/);
  step('call connected peer-to-peer, audio flows both ways');
  // Eve has no key: she must neither ring nor connect, and she gets a hint.
  assert.equal(await state(eve, () => window.fileroomVoice._state.roster.size), 0);
  assert.ok(await eve.locator('#ringBanner.d-none').count() === 1);
  if (mock) {
    // Eve (no key) may ask "is there a call?" in the clear; everything from the key holders is sealed.
    const sealed = mock.seen.signals.filter((s) => s.startsWith('s.'));
    const plain = mock.seen.signals.filter((s) => s.startsWith('p.'));
    // Known-device frames (c.) carry random numbers, HMAC tags and sealed blobs - nothing readable.
    const contact = mock.seen.signals.filter((s) => s.startsWith('c.')).map((s) => JSON.parse(s.slice(2)));
    assert.equal(sealed.length + plain.length + contact.length, mock.seen.signals.length);
    assert.ok(sealed.length > 5, 'call setup went through the relay');
    assert.ok(plain.every((s) => JSON.parse(s.slice(2)).t === 'hello'), 'only key-less "hello" frames are readable');
    assert.ok(contact.every((m) => ['probe', 'tags', 'hi', 'id', 'key'].includes(m.t) && Object.keys(m).every((k) => 'tnkgd'.includes(k))));
    assert.ok(!mock.seen.signals.some((s) => /Alice|Bob|Carol/.test(s)), 'no names in signaling');
    assert.ok(!mock.seen.signals.some((s) => /fingerprint|candidate|opus/.test(s)));
    step(`signaling relayed by the server is opaque (${sealed.length} sealed frames)`);
  }
  // A third device with the key joins: full mesh.
  const carol = await open(invite, 'Carol');
  await carol.waitForFunction(() => document.getElementById('voiceBadge').textContent === '2');
  await carol.click('#voiceHeaderBtn');
  assert.match(await carol.locator('#voiceCallTitle').textContent(), /Join voice call \(2 in call\)/);
  await carol.click('[data-action="voice-call"]');
  await Promise.all([connected(alice, 2), connected(bob, 2), connected(carol, 2)]);
  step('third device joins: everybody is connected to everybody');
  await bob.click('[data-action="voice-mute"]');
  await alice.waitForFunction(() => [...window.fileroomVoice._state.peers.values()].some((p) => p.remoteMuted));
  await carol.click('[data-action="voice-stop"]');
  await bob.click('[data-action="voice-stop"]');
  await alice.waitForFunction(() => window.fileroomVoice._state.peers.size === 0);
  await alice.click('[data-action="voice-stop"]');
  await carol.close();
  step('mute is shown to the others; hanging up closes the connections');

  // ---------------------------------------------------------------- babyphone
  console.log('Babyphone');
  await alice.click('#voiceHeaderBtn');
  await alice.click('[data-action="voice-baby"]');
  await alice.waitForSelector('#voiceBar.baby');
  await bob.waitForFunction(() => document.getElementById('voiceBadge').textContent === '1');
  await bob.click('#voiceHeaderBtn');
  assert.match(await bob.locator('#voiceParentHint').textContent(), /Online: Alice/);
  await bob.click('[data-action="voice-parent"]');
  await Promise.all([connected(alice), connected(bob)]);
  step('baby station and parent unit connect');

  // The fake microphone beeps: the detector must report sound, the parent gets level data and an alarm.
  await bob.waitForFunction(() => [...window.fileroomVoice._state.peers.values()].some((p) => p.cfg && p.level > -80 && p.alarmAt), null, { timeout: 30000 });
  const baby = await state(alice, () => { const d = window.fileroomVoice._state.baby.det; return { active: d.active, floor: d.floor, threshold: d.threshold, pending: window.fileroomVoice._state.baby.pending.size }; });
  assert.ok(baby.threshold > baby.floor, 'threshold is above the noise floor');
  await alice.waitForFunction(() => window.fileroomVoice._state.baby.pending.size === 0, null, { timeout: 6000 });
  step(`sound detected on the baby station (floor ${baby.floor.toFixed(0)} dB, threshold ${baby.threshold.toFixed(0)} dB); alarm delivered and acknowledged`);

  // "Alerts only": the speaker is open while sound is reported, and the meter is drawn.
  assert.equal(await state(bob, () => window.fileroomVoice._state.parent.mode), 'alerts');
  await bob.waitForFunction(() => { const p = [...window.fileroomVoice._state.peers.values()][0]; return p.active && p.audio && !p.audio.muted; }, null, { timeout: 15000 });
  await bob.waitForFunction(() => parseFloat(document.querySelector('.vb-station .vb-meter-fill').style.width) > 0);
  assert.ok(await inboundBytes(bob) > 500, 'baby audio arrives at the parent unit');
  step('parent unit: speaker opens on sound, level meter is live, audio arrives');

  // Remote control: sensitivity is set from the parent unit.
  await bob.selectOption('#vbSens', '5');
  await alice.waitForFunction(() => window.fileroomVoice._state.baby.cfg.sens === 5);
  await bob.waitForFunction(() => [...window.fileroomVoice._state.peers.values()][0].cfg.sens === 5);
  step('sensitivity changed remotely from the parent unit');

  // Talk-back: hold the button, the baby station receives audio and pauses its detector.
  const before = await inboundBytes(alice);
  await bob.dispatchEvent('#vbTalk', 'pointerdown', { pointerId: 1, bubbles: true });
  await alice.waitForFunction(() => [...window.fileroomVoice._state.peers.values()][0].talking === true);
  await alice.waitForTimeout(1500);
  assert.ok(await inboundBytes(alice) > before + 500, 'talk-back audio arrives at the baby station');
  assert.equal(await state(alice, () => window.fileroomVoice._state.baby.suppressUntil), Infinity);
  await bob.dispatchEvent('#vbTalk', 'pointerup', { pointerId: 1, bubbles: true });
  await alice.waitForFunction(() => [...window.fileroomVoice._state.peers.values()][0].talking === false);
  step('talk-back reaches the baby station; detection pauses while the parent speaks');

  // Push fallback: a registered parent unit that is not connected gets an encrypted Web Push.
  if (mock) {
    const ua = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublic = Buffer.from(await webcrypto.subtle.exportKey('raw', ua.publicKey));
    const auth = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)));
    await alice.evaluate(async ({ p256dh, auth }) => {
      const B = window.fileroomVoice._state.baby;
      B.targets.set('sleeping-parent', { sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh, auth } }, vapid: await window.FileRoomCrypto.generateVapid(), at: Date.now() });
      B.det.lastAlarm = -1e9; B.det.active = false; B.det.score = 0; // let the next beep raise a new alarm
    }, { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') });
    const deadline = Date.now() + 20000;
    while (!mock.seen.pushes.length && Date.now() < deadline) await alice.waitForTimeout(250);
    const push = mock.seen.pushes[0];
    assert.ok(push, 'push request reached the relay');
    assert.equal(push.endpoint, 'https://fcm.googleapis.com/fcm/send/test');
    assert.match(push.auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    // Decrypt like the parent's browser would (RFC 8291).
    const body = Buffer.from(push.body, 'base64url');
    const asPublic = body.subarray(21, 21 + body[20]);
    const hkdf = async (salt, ikm, info, len) => Buffer.from(await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info },
      await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
    const shared = Buffer.from(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: await webcrypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, ua.privateKey, 256));
    const ikm = await hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
    const cek = await hkdf(body.subarray(0, 16), ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(body.subarray(0, 16), ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
    const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.subarray(21 + body[20])));
    const payload = JSON.parse(plain.subarray(0, -1).toString());
    assert.deepEqual({ t: payload.t, k: payload.k, name: payload.name }, { t: 'baby', k: 'noise', name: 'Alice' });
    assert.ok(!Buffer.from(push.body, 'base64url').includes('Alice'), 'the relay sees no plaintext');
    step('unreachable parent unit: alarm sent as Web Push, encrypted on the baby station');
  }

  // Reload of the baby station (update, crash): the session resumes and the parent reconnects by itself.
  await alice.reload();
  await alice.waitForFunction(() => window.fileroomVoice?.role() === 'baby', null, { timeout: 15000 });
  await Promise.all([connected(alice), connected(bob)]);
  await bob.waitForFunction(() => { const p = [...window.fileroomVoice._state.peers.values()][0]; return p.everConnected && Date.now() - p.lastData < 1500; });
  assert.equal(await state(alice, () => window.fileroomVoice._state.baby.cfg.sens), 5, 'settings survive the reload');
  step('baby station reloaded: session resumed, parent unit reconnected automatically');

  // The baby station disappears without a word (battery empty, Wi-Fi gone): the parent unit raises an alarm.
  await alice.context().close();
  await bob.waitForSelector('#vbAlert:not(.d-none)', { timeout: 40000 });
  assert.match(await bob.locator('#vbAlert span').textContent(), /Connection to Alice lost/);
  assert.equal(await state(bob, () => window.fileroomVoice._state.alert.kind), 'lost');
  step('baby station vanished: "connection lost" alarm on the parent unit');
  await bob.click('[data-action="voice-stop"]');

  // ---------------------------------------------------------------- room without a key
  console.log('Room without a key');
  const room = `${BASE}/room/PLAIN${Date.now() % 100000}`;
  const dave = await open(room, 'Dave');
  const erin = await open(room, 'Erin');
  assert.equal(await state(dave, () => window.fileroom.keys), null, 'a typed room name has no key by default');
  await dave.click('#voiceHeaderBtn');
  await dave.click('[data-action="voice-call"]');
  await erin.waitForSelector('#ringBanner:not(.d-none)');
  await erin.click('[data-action="ring-join"]');
  await Promise.all([connected(dave), connected(erin)]);
  await dave.waitForFunction(() => [...window.fileroomVoice._state.peers.values()][0].sas);
  await erin.waitForFunction(() => [...window.fileroomVoice._state.peers.values()][0].sas);
  const codes = await Promise.all([dave, erin].map((p) => state(p, () => [...window.fileroomVoice._state.peers.values()][0].sas)));
  assert.match(codes[0], /^\d{3} \d{3}$/);
  assert.equal(codes[0], codes[1], 'both sides show the same security code');
  assert.match(await dave.locator('#vbSecure').textContent(), /not verified/);
  step(`call works; both phones show the same security code (${codes[0]})`);

  // Setting a password on both devices turns the room into an encrypted one.
  for (const page of [dave, erin]) {
    await page.click('[data-action="voice-stop"]');
    await page.click('#keyBtn');
    await page.fill('#keyInput', 'correct horse battery');
    await page.click('#keyForm button[type="submit"]');
    await page.waitForFunction(() => window.fileroom.keys && location.hash.startsWith('#k='));
  }
  await dave.fill('#messageInput', 'now encrypted');
  await dave.click('[data-action="send"]');
  await erin.waitForFunction(() => [...document.querySelectorAll('.message.text .message-content')].some((el) => el.textContent === 'now encrypted'));
  assert.equal(await erin.locator('.message.text .msg-lock').count(), 1);
  step('same password on both devices: messages are end-to-end encrypted');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll browser tests passed');
} finally {
  await browser.close();
  await mock?.close();
}
