/**
 * FileRoom end-to-end encryption (WebCrypto only, no dependencies).
 *
 * Room secret  : a random key from the invite link (URL fragment "#k=…", never sent to the server)
 *                or a password that everybody types. PBKDF2 turns it into the room master key.
 * Sub keys     : HKDF from the master key - messages, call signaling, files and a public key id.
 * Text/location: AES-256-GCM, "<kid>.<iv>.<ciphertext>" (base64url).
 * Files        : a random per-file key (HKDF), 1 MiB chunks, each AES-256-GCM with its index and a
 *                "last chunk" flag as additional data (no reordering, no truncation).
 * Calls        : WebRTC is already encrypted (DTLS-SRTP) between the two phones. Sealing the
 *                signaling (and with it the DTLS fingerprints) with the room key is what stops the
 *                server from sitting in the middle. Without a room key a 6-digit code can be compared.
 * Web Push     : RFC 8291 payload encryption + RFC 8292 VAPID, done by the sending phone, so the
 *                server and the push service only ever see ciphertext.
 */
(() => {
    'use strict';
    const subtle = crypto.subtle;
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const PBKDF2_ITERATIONS = 150000;
    const CHUNK = 1024 * 1024;
    const TAG = 16;
    const FILE_MAGIC = enc.encode('FRE1');
    const FILE_HEADER = FILE_MAGIC.length + 16;

    const utf8 = (s) => enc.encode(s);
    function b64(bytes) {
        const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function unb64(str) {
        const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function concat(...parts) {
        const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
        const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
        let pos = 0;
        for (const a of arrays) { out.set(a, pos); pos += a.length; }
        return out;
    }
    const random = (n) => crypto.getRandomValues(new Uint8Array(n));
    const randomSecret = () => b64(random(16)); // 128 bit, 22 characters

    async function hkdfBits(ikm, salt, info, length) {
        const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
    }
    const aesKey = (raw, usages) => subtle.importKey('raw', raw, 'AES-GCM', false, usages);

    // ------------------------------------------------------------------ room keys
    async function deriveRoomKeys(secret, roomCode) {
        const base = await subtle.importKey('raw', utf8(String(secret).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
        const master = new Uint8Array(await subtle.deriveBits(
            { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(`fileroom-e2ee-v1\u0000${roomCode}`), iterations: PBKDF2_ITERATIONS }, base, 256));
        const none = new Uint8Array(0);
        const [msg, sig, file, kid] = await Promise.all([
            hkdfBits(master, none, utf8('fileroom/message'), 32),
            hkdfBits(master, none, utf8('fileroom/signal'), 32),
            hkdfBits(master, none, utf8('fileroom/file'), 32),
            hkdfBits(master, none, utf8('fileroom/key-id'), 6),
        ]);
        return {
            room: roomCode,
            kid: b64(kid), // public: lets a client tell "wrong key" from "damaged message"
            msgKey: await aesKey(msg, ['encrypt', 'decrypt']),
            sigKey: await aesKey(sig, ['encrypt', 'decrypt']),
            fileMaster: file,
        };
    }

    // ------------------------------------------------------------------ small sealed JSON values
    async function sealWith(key, value, aad) {
        const iv = random(12);
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(JSON.stringify(value)));
        return `${b64(iv)}.${b64(ct)}`;
    }
    async function openWith(key, sealed, aad) {
        const [iv, ct] = String(sealed).split('.');
        const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: utf8(aad) }, key, unb64(ct));
        return JSON.parse(dec.decode(pt));
    }
    const kidOf = (sealed) => String(sealed).split('.')[0];
    /** Text, location or file metadata -> "<kid>.<iv>.<ct>". `kind` separates the uses. */
    async function seal(keys, kind, value) {
        return `${keys.kid}.${await sealWith(keys.msgKey, value, `${kind}|${keys.room}`)}`;
    }
    async function open(keys, kind, sealed) {
        const s = String(sealed);
        const dot = s.indexOf('.');
        if (dot < 0 || s.slice(0, dot) !== keys.kid) throw Object.assign(new Error('other key'), { wrongKey: true });
        return openWith(keys.msgKey, s.slice(dot + 1), `${kind}|${keys.room}`);
    }
    /** Call signaling: bound to room, sender and receiver, so the server cannot re-address it. */
    const sealSignal = (keys, from, to, value) => sealWith(keys.sigKey, value, `signal|${keys.room}|${from}|${to || '*'}`);
    const openSignal = (keys, from, to, sealed) => openWith(keys.sigKey, sealed, `signal|${keys.room}|${from}|${to || '*'}`);

    // ------------------------------------------------------------------ files
    const encryptedSize = (size) => FILE_HEADER + size + Math.max(1, Math.ceil(size / CHUNK)) * TAG;
    function chunkAad(index, last) {
        const aad = new Uint8Array(5);
        new DataView(aad.buffer).setUint32(0, index);
        aad[4] = last ? 1 : 0;
        return aad;
    }
    function chunkIv(index) {
        const iv = new Uint8Array(12);
        new DataView(iv.buffer).setUint32(8, index);
        return iv;
    }
    const fileKey = async (keys, salt) => aesKey(await hkdfBits(keys.fileMaster, salt, utf8('fileroom/file-key'), 32), ['encrypt', 'decrypt']);

    /** Blob -> encrypted Blob. Works chunk by chunk so a 100 MB video does not need 200 MB of RAM. */
    async function encryptFile(keys, blob, onProgress) {
        const salt = random(16);
        const key = await fileKey(keys, salt);
        const parts = [new Blob([FILE_MAGIC, salt])];
        const count = Math.max(1, Math.ceil(blob.size / CHUNK));
        for (let i = 0; i < count; i++) {
            const plain = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
            const ct = await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(i), additionalData: chunkAad(i, i === count - 1) }, key, plain);
            parts.push(new Blob([ct]));
            onProgress?.((i + 1) / count);
        }
        return new Blob(parts, { type: 'application/octet-stream' });
    }
    async function decryptFile(keys, blob, type = 'application/octet-stream') {
        if (blob.size < FILE_HEADER + TAG) throw new Error('File is damaged');
        const header = new Uint8Array(await blob.slice(0, FILE_HEADER).arrayBuffer());
        if (FILE_MAGIC.some((b, i) => header[i] !== b)) throw new Error('Unknown file format');
        const key = await fileKey(keys, header.subarray(FILE_MAGIC.length));
        const step = CHUNK + TAG;
        const count = Math.ceil((blob.size - FILE_HEADER) / step);
        const parts = [];
        for (let i = 0; i < count; i++) {
            const ct = await blob.slice(FILE_HEADER + i * step, FILE_HEADER + (i + 1) * step).arrayBuffer();
            const plain = await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(i), additionalData: chunkAad(i, i === count - 1) }, key, ct);
            parts.push(new Blob([plain]));
        }
        return new Blob(parts, { type });
    }

    // ------------------------------------------------------------------ call verification code
    /** Short authentication string from both DTLS fingerprints (for rooms without a key). */
    async function safetyCode(fingerprintA, fingerprintB) {
        const sorted = [String(fingerprintA).toUpperCase(), String(fingerprintB).toUpperCase()].sort().join('|');
        const hash = new Uint8Array(await subtle.digest('SHA-256', utf8(`fileroom-sas|${sorted}`)));
        const n = (((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0) % 1000000;
        const s = String(n).padStart(6, '0');
        return `${s.slice(0, 3)} ${s.slice(3)}`;
    }

    // ------------------------------------------------------------------ Web Push (RFC 8291 / 8292)
    const P256 = { name: 'ECDH', namedCurve: 'P-256' };
    async function generateVapid() {
        const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
        return {
            publicKey: b64(await subtle.exportKey('raw', pair.publicKey)),
            privateJwk: await subtle.exportKey('jwk', pair.privateKey),
        };
    }
    async function vapidAuthorization(vapid, endpoint, subject, lifetime = 12 * 3600) {
        const jwk = { kty: 'EC', crv: 'P-256', x: vapid.privateJwk.x, y: vapid.privateJwk.y, d: vapid.privateJwk.d };
        const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const part = (obj) => b64(utf8(JSON.stringify(obj)));
        const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
            aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + lifetime, sub: subject,
        })}`;
        const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned));
        return `vapid t=${unsigned}.${b64(signature)}, k=${vapid.publicKey}`;
    }
    /** Encrypt a payload for one push subscription ({endpoint, keys: {p256dh, auth}}) - aes128gcm. */
    async function pushEncrypt(subscription, payload) {
        const uaPublic = unb64(subscription.keys.p256dh);
        const authSecret = unb64(subscription.keys.auth);
        const pair = await subtle.generateKey(P256, true, ['deriveBits']);
        const asPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
        const uaKey = await subtle.importKey('raw', uaPublic, P256, false, []);
        const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));
        const ikm = await hkdfBits(shared, authSecret, concat(utf8('WebPush: info\u0000'), uaPublic, asPublic), 32);
        const salt = random(16);
        const cek = await hkdfBits(ikm, salt, utf8('Content-Encoding: aes128gcm\u0000'), 16);
        const nonce = await hkdfBits(ikm, salt, utf8('Content-Encoding: nonce\u0000'), 12);
        const data = typeof payload === 'string' ? utf8(payload) : payload;
        const key = await aesKey(cek, ['encrypt']);
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, [2])); // 0x02: last record
        const header = new Uint8Array(21);
        header.set(salt, 0);
        new DataView(header.buffer).setUint32(16, 4096);
        header[20] = asPublic.length;
        return concat(header, asPublic, ct);
    }
    /** Everything the relay (POST /api/push) needs to forward one notification. */
    async function pushRequest(subscription, vapid, payload, { subject, ttl = 120, topic } = {}) {
        return {
            endpoint: subscription.endpoint,
            auth: await vapidAuthorization(vapid, subscription.endpoint, subject),
            body: b64(await pushEncrypt(subscription, JSON.stringify(payload))),
            ttl, urgency: 'high', topic,
        };
    }

    window.FileRoomCrypto = {
        b64, unb64, utf8, randomSecret, deriveRoomKeys, seal, open, kidOf, sealSignal, openSignal,
        encryptFile, decryptFile, encryptedSize, safetyCode,
        generateVapid, vapidAuthorization, pushEncrypt, pushRequest,
    };
})();
