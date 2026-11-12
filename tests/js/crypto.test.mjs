// Run: node tests/js/crypto.test.mjs   (Node 20+; uses the same WebCrypto API as the browser)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

globalThis.window = globalThis;
(0, eval)(readFileSync(new URL('../../static/js/e2ee.js', import.meta.url), 'utf8'));
const C = globalThis.FileRoomCrypto;
const rejects = (p) => p.then(() => { throw new Error('expected a rejection'); }, () => true);

const keys = await C.deriveRoomKeys('correct horse', 'ROOM1');
const same = await C.deriveRoomKeys('correct horse', 'ROOM1');
const otherSecret = await C.deriveRoomKeys('wrong horse', 'ROOM1');
const otherRoom = await C.deriveRoomKeys('correct horse', 'ROOM2');
assert.equal(keys.kid, same.kid);
assert.notEqual(keys.kid, otherSecret.kid);
assert.notEqual(keys.kid, otherRoom.kid); // the same password in another room gives other keys

// Messages
const sealed = await C.seal(keys, 'msg', { t: 'text', text: 'hällo 👶' });
assert.match(sealed, /^[A-Za-z0-9_.-]+$/);
assert.deepEqual(await C.open(same, 'msg', sealed), { t: 'text', text: 'hällo 👶' });
await assert.rejects(C.open(otherSecret, 'msg', sealed), (e) => e.wrongKey === true);
await rejects(C.open(keys, 'meta', sealed)); // a message cannot be replayed as file metadata
const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
await rejects(C.open(keys, 'msg', tampered));

// Signaling is bound to sender and receiver
const sig = await C.sealSignal(keys, 'alice', 'bob', { t: 'sdp' });
assert.deepEqual(await C.openSignal(same, 'alice', 'bob', sig), { t: 'sdp' });
await rejects(C.openSignal(keys, 'mallory', 'bob', sig));
await rejects(C.openSignal(keys, 'alice', 'carol', sig));
await rejects(C.openSignal(keys, 'alice', null, sig));

// Files: empty, small, exactly one chunk, several chunks
for (const size of [0, 1, 1000, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024 + 17]) {
  const plain = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) webcrypto.getRandomValues(plain.subarray(i, Math.min(size, i + 65536)));
  const encrypted = await C.encryptFile(keys, new Blob([plain]));
  assert.equal(encrypted.size, C.encryptedSize(size), `size ${size}`);
  const back = new Uint8Array(await (await C.decryptFile(same, encrypted)).arrayBuffer());
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(plain)), 0, `roundtrip ${size}`);
  await rejects(C.decryptFile(otherSecret, encrypted));
  if (size > 1024 * 1024) {
    // Dropping the last chunk (truncation) or swapping chunks must be detected.
    const step = 1024 * 1024 + 16;
    await rejects(C.decryptFile(keys, encrypted.slice(0, 20 + step)));
    if (size > 2 * step) {
      const swapped = new Blob([encrypted.slice(0, 20), encrypted.slice(20 + step, 20 + 2 * step), encrypted.slice(20, 20 + step), encrypted.slice(20 + 2 * step)]);
      await rejects(C.decryptFile(keys, swapped));
    }
  }
}

// Safety code is symmetric
assert.equal(await C.safetyCode('AA:BB', 'cc:dd'), await C.safetyCode('CC:DD', 'aa:bb'));
assert.match(await C.safetyCode('AA:BB', 'CC:DD'), /^\d{3} \d{3}$/);

// Web Push: emit a vector that tests/js/verify_push.py decrypts with an independent implementation.
const ua = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await webcrypto.subtle.exportKey('raw', ua.publicKey));
const auth = webcrypto.getRandomValues(new Uint8Array(16));
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: C.b64(uaPublic), auth: C.b64(auth) } };
const vapid = await C.generateVapid();
const payload = { t: 'baby', k: 'noise', room: 'ROOM1', name: 'Nursery' };
const request = await C.pushRequest(subscription, vapid, payload, { subject: 'https://fileroom.example', topic: 'baby' });
assert.match(request.auth, /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, ?k=[A-Za-z0-9_-]{80,100}$/);
if (process.argv[2]) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[2], JSON.stringify({
    request, payload, auth: C.b64(auth), uaPublic: C.b64(uaPublic),
    uaPrivate: await webcrypto.subtle.exportKey('jwk', ua.privateKey), vapidPublic: vapid.publicKey,
  }));
}
console.log('crypto tests passed');
