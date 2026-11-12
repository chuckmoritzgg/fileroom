/**
 * FileRoom known devices: rooms are temporary, trust between two phones does not have to be.
 *
 * Every device has an identity: an ECDH key pair created on first use. The private key never leaves
 * the browser (stored non-extractable in IndexedDB) and is never shown to the server.
 *
 * Getting to know each other
 *   Devices that share an end-to-end encrypted room exchange their public keys *inside* that
 *   encryption. Each remembers the other as a "known device". From the two key pairs both can compute
 *   the same pair secret at any later time, without talking to each other first.
 *
 * Meeting again - in any room, also one without a key
 *   1. Recognising. A device broadcasts a random number (probe). Every device answers with one short
 *      HMAC tag per known device, computed with that pair's secret over the probe, the room and both
 *      user ids, mixed with random dummies. Only the right device can find "its" tag in the list. To the
 *      server and to strangers the lists are noise, different every time - nothing links a device to
 *      its earlier rooms, and a name is not needed (it can stay anonymous).
 *   2. Reusing the secret. A device that holds the room key hands it to a recognised device, encrypted
 *      with the pair secret. In a room without a key, where everybody present is a known device, one of
 *      them (lowest user id) creates a key and hands it out: the room becomes end-to-end encrypted by
 *      itself. If strangers are present too, the app only offers it - they would be locked out.
 *
 * The name a device chose for itself travels the same way: encrypted, to known devices only. Publicly
 * it may show that name, or a random one per room.
 *
 * Favourites, groups and invitations
 *   A room can only be reached from inside. To call somebody *into* a room, known devices also tell
 *   each other (encrypted) how to send them a Web Push notification. An invitation is such a push:
 *   it contains the room and its key, sealed with the pair secret, so the receiving phone knows for
 *   sure which known device sent it - and the push service and the server learn nothing. The phone
 *   shows "… invites you to a room"; a tap joins, with the key already in place. It works while the
 *   other phone is in another room or has the app closed. Favourites and groups are just lists on
 *   this device for ticking several people at once.
 *
 * Linked devices (one person, several devices)
 *   "Link another device" shows a QR code with a one-time secret (in the link's fragment, which is
 *   never sent to the server). The other device opens it, lands in the same room and receives -
 *   encrypted with that secret, after a confirmation on both sides - a copy of the identity key,
 *   the known devices, favourites, groups and the name. From then on it *is* the same identity:
 *   everybody who knows one of the devices recognises all of them.
 *   Linked devices recognise each other like known devices do and merge their lists whenever they
 *   are in a room together. Each keeps its own push address; an invitation goes to all of them.
 */
(() => {
    'use strict';
    const FR = window.fileroom;
    const C = window.FileRoomCrypto;
    const subtle = window.crypto?.subtle;
    if (!FR || !C || !subtle || !window.indexedDB) return;

    const MAX_CONTACTS = 100;
    const MAX_AGE = 5 * 60000;           // sealed pair messages older than this are ignored
    const PAGE_START = Date.now();
    const utf8 = (text) => new TextEncoder().encode(text);
    const random = (n) => crypto.getRandomValues(new Uint8Array(n));
    const log = (...args) => console.debug('[contacts]', ...args);

    const S = {
        self: null,                 // {priv: CryptoKey, pub: base64url raw public key, created}
        contacts: new Map(),        // id -> {id, pub, name, first, last}
        pair: new Map(),            // id -> Promise<{mac, aes}>
        nonce: C.b64(random(12)),   // my probe for this page load
        peers: new Map(),           // user id -> {nonce, kid, probed, answered}: what others told about themselves
        known: new Map(),           // user id -> contact id (recognised in this room)
        sentKey: new Set(),         // user ids that got the room key from this device
        greeted: new Set(),
        introduced: new Set(),      // user ids this device introduced itself to (encrypted rooms)
        push: null,                 // how known devices can notify this one: {sub, vapid}
        ticked: new Set(),          // contact ids ticked in the "People" sheet
        dev: null,                  // id of this device (linked devices share the identity, not this)
        link: null,                 // source: {secret, until} while "Link another device" is open
        linkJoin: null,             // target: the one-time secret from the link
        linkParts: null,
        synced: new Set(),          // user ids of own devices that already got our lists
        syncTimer: null,
        offer: false,               // known devices present, but encrypting would lock strangers out
        hinted: false,
        timer: null,
        ready: null,
    };

    // ------------------------------------------------------------------ storage (IndexedDB)
    function db() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('fileroom-identity', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('self');
                request.result.createObjectStore('contacts', { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function tx(store, mode, action) {
        const database = await db();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = database.transaction(store, mode);
                const request = action(transaction.objectStore(store));
                transaction.oncomplete = () => resolve(request?.result);
                transaction.onerror = transaction.onabort = () => reject(transaction.error);
            });
        } finally {
            database.close();
        }
    }

    async function load() {
        let self = await tx('self', 'readonly', (s) => s.get('identity'));
        if (!self?.priv || !self.pub) {
            // Extractable only so that it can be copied to the owner's other devices ("Link another device").
            const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
            self = { priv: pair.privateKey, pub: C.b64(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), created: Date.now() };
            await tx('self', 'readwrite', (s) => s.put(self, 'identity'));
        }
        self.id = C.b64(new Uint8Array(await subtle.digest('SHA-256', C.unb64(self.pub))).slice(0, 12));
        S.self = self;
        S.dev = FR.storage.get('fileroom_device');
        if (!S.dev) { S.dev = C.b64(random(6)); FR.storage.set('fileroom_device', S.dev); }
        S.contacts = new Map(((await tx('contacts', 'readonly', (s) => s.getAll())) || []).map((c) => [c.id, c]));
    }

    // This identity on another device of the same person: recognised like a known device.
    const selfContact = () => ({ id: S.self.id, pub: S.self.pub, own: true, name: null, first: 0, last: 0 });
    const contactById = (id) => (id && id === S.self?.id ? selfContact() : S.contacts.get(id));
    const everyone = () => [selfContact(), ...S.contacts.values()];
    /** Push addresses of a contact, one per device it uses. */
    function pushesOf(contact) {
        if (!contact.pushes) { contact.pushes = contact.push ? { first: contact.push } : {}; delete contact.push; }
        return contact.pushes;
    }
    const reachable = (contact) => Object.keys(pushesOf(contact)).length > 0;
    /** Contact ids of the known devices that are in this room right now (not: were, a moment ago). */
    const presentContacts = () => new Set(FR.users.filter((u) => S.known.has(u.id)).map((u) => S.known.get(u.id)));

    async function saveContact(contact) {
        if (contact.own) return;
        S.contacts.set(contact.id, contact);
        await tx('contacts', 'readwrite', (s) => s.put(contact)).catch((err) => log('could not store', err));
        if (S.contacts.size > MAX_CONTACTS) {
            const oldest = [...S.contacts.values()].sort((a, b) => a.last - b.last)[0];
            S.contacts.delete(oldest.id);
            S.pair.delete(oldest.id);
            await tx('contacts', 'readwrite', (s) => s.delete(oldest.id)).catch(() => {});
        }
    }

    // ------------------------------------------------------------------ pair secrets
    /** The secret two devices share: ECDH of their identities. Both sides compute the same keys. */
    function pairKeys(contact) {
        if (!S.pair.has(contact.id)) {
            S.pair.set(contact.id, (async () => {
                const theirs = await subtle.importKey('raw', C.unb64(contact.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
                const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, S.self.priv, 256);
                const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
                const info = utf8([S.self.pub, contact.pub].sort().join('|'));
                const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8('fileroom-known-device-v1'), info }, ikm, 512));
                return {
                    mac: await subtle.importKey('raw', bits.slice(0, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
                    aes: await subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']),
                };
            })());
        }
        return S.pair.get(contact.id);
    }

    async function tagFor(contact, prober, responder, nonce) {
        const { mac } = await pairKeys(contact);
        const text = `tag|${FR.roomCode}|${prober}|${responder}|${nonce}`;
        return C.b64(new Uint8Array(await subtle.sign('HMAC', mac, utf8(text))).slice(0, 12));
    }

    const aad = (kind, from, to) => utf8(`${kind}|${FR.roomCode}|${from}|${to}`);
    async function sealFor(contact, kind, to, value) {
        const { aes } = await pairKeys(contact);
        const iv = random(12);
        const body = utf8(JSON.stringify({ ...value, ts: Math.round(FR.serverNow() * 1000) }));
        const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, FR.user.id, to) }, aes, body));
        return `${C.b64(iv)}.${C.b64(sealed)}`;
    }
    /** Open a pair message without knowing who wrote it: whoever's key fits is the sender. */
    async function openFrom(kind, from, sealed) {
        const [iv, body] = String(sealed).split('.');
        if (!iv || !body) return null;
        const first = contactById(S.known.get(from));
        for (const contact of [first, ...everyone()]) {
            if (!contact) continue;
            try {
                const { aes } = await pairKeys(contact);
                const plain = await subtle.decrypt({ name: 'AES-GCM', iv: C.unb64(iv), additionalData: aad(kind, from, FR.user.id) }, aes, C.unb64(body));
                const value = JSON.parse(new TextDecoder().decode(plain));
                if (Math.abs(FR.serverNow() * 1000 - Number(value.ts)) > MAX_AGE) return null;
                return { contact, value };
            } catch { /* not this one */ }
        }
        return null;
    }

    // ------------------------------------------------------------------ protocol
    const send = (to, message) => FR.sendSignal(to, `c.${JSON.stringify(message)}`);
    const myKid = () => FR.keys?.kid || null;
    const privateName = () => FR.profile?.name || null;
    const peer = (id) => { if (!S.peers.has(id)) S.peers.set(id, { nonce: null, kid: undefined, probed: 0, answered: 0 }); return S.peers.get(id); };

    function probe(to = null) {
        if (!FR.user) return;
        if (to) peer(to).probed = Date.now();
        send(to, { t: 'probe', n: S.nonce, k: myKid() });
        if (!to && FR.keys) introduce();
    }

    /** In an encrypted room: tell the others who this device is. Only holders of the room key can read it. */
    async function introduce(to = null) {
        if (!FR.keys || !FR.user) return;
        if (to) S.introduced.add(to);
        const sealed = await C.sealSignal(FR.keys, FR.user.id, to, { pub: S.self.pub, name: privateName(), ts: Math.round(FR.serverNow() * 1000) });
        send(to, { t: 'id', d: sealed });
    }

    async function onProbe(from, m) {
        if (typeof m.n !== 'string' || m.n.length > 40) return;
        const p = peer(from);
        p.nonce = m.n;
        p.kid = typeof m.k === 'string' ? m.k : null;
        if (Date.now() - p.answered > 1500) {
            p.answered = Date.now();
            const tags = await Promise.all(everyone().map((c) => tagFor(c, from, FR.user.id, m.n)));
            // Dummies hide how many devices this one knows; the order says nothing either.
            const size = Math.max(8, 2 ** Math.ceil(Math.log2(tags.length + 1)));
            while (tags.length < size) tags.push(C.b64(random(12)));
            tags.sort();
            send(from, { t: 'tags', n: m.n, g: tags, k: myKid() });
        }
        if (Date.now() - p.probed > 5000 && !S.known.has(from)) probe(from); // get to know it, too
        // A device that arrived with the same room key missed our introduction: repeat it.
        if (FR.keys && p.kid === myKid() && !S.introduced.has(from)) introduce(from);
        evaluate();
    }

    async function onTags(from, m) {
        if (m.n !== S.nonce || !Array.isArray(m.g) || m.g.length > 256) return;
        peer(from).kid = typeof m.k === 'string' ? m.k : null;
        const tags = new Set(m.g);
        for (const contact of everyone()) {
            if (tags.has(await tagFor(contact, FR.user.id, from, S.nonce))) { await recognise(from, contact); break; }
        }
        evaluate();
    }

    async function recognise(userId, contact, name, push, dev) {
        const isNew = S.known.get(userId) !== contact.id;
        S.known.set(userId, contact.id);
        if (contact.own) {
            // Another device of this person: no entry of its own, but the lists are brought in line.
            if (!S.greeted.has(userId) && FR.user) { S.greeted.add(userId); await greet(userId, contact); }
            if (isNew) { FR.renderUsers(); render(); }
            if (!S.synced.has(userId)) { S.synced.add(userId); await sendSync(userId); }
            return;
        }
        let changed = name !== undefined && (name || null) !== contact.name;
        if (changed) contact.name = name ? String(name).slice(0, 20) : null;
        // Only ever replaced by a newer address: "none right now" may just be a browser that is still
        // starting. An address that died is removed when the push service says so (invite()).
        const slot = typeof dev === 'string' && dev.length <= 16 ? dev : 'first';
        if (push && JSON.stringify(push.sub) !== JSON.stringify(pushesOf(contact)[slot]?.sub || null)) {
            const pushes = pushesOf(contact);
            pushes[slot] = { sub: push.sub, vapid: push.vapid, at: Date.now() };
            // A person has a handful of devices, not dozens: keep the most recent ones.
            for (const old of Object.keys(pushes).sort((a, b) => pushes[b].at - pushes[a].at).slice(6)) delete pushes[old];
            changed = true;
        }
        if (isNew || changed || Date.now() - contact.last > 60000) { contact.last = Date.now(); await saveContact(contact); }
        if (!S.greeted.has(userId) && FR.user) {
            S.greeted.add(userId);
            await greet(userId, contact);
        }
        if (isNew || changed) { FR.renderUsers(); render(); }
    }

    /** For known devices only: our name (also when everybody else sees a random one) and how to invite us. */
    let greetings = Promise.resolve();
    function greet(userId, contact) {
        // One after the other: a greeting must never be overtaken by an older one with outdated content.
        greetings = greetings.then(async () => {
            if (FR.user) send(userId, { t: 'hi', d: await sealFor(contact, 'hi', userId, { name: privateName(), push: S.push, dev: S.dev }) });
        }).catch((err) => log('greeting failed', err));
        return greetings;
    }

    function validPush(push) {
        const ok = push && typeof push.sub?.endpoint === 'string' && push.sub.endpoint.startsWith('https://') && push.sub.endpoint.length < 1000
            && typeof push.sub.keys?.p256dh === 'string' && typeof push.sub.keys?.auth === 'string'
            && typeof push.vapid?.publicKey === 'string' && push.vapid?.privateJwk?.d;
        return ok ? { sub: { endpoint: push.sub.endpoint, keys: { p256dh: push.sub.keys.p256dh, auth: push.sub.keys.auth } }, vapid: push.vapid } : null;
    }

    async function onHi(from, m) {
        const opened = await openFrom('hi', from, m.d);
        if (opened) await recognise(from, opened.contact, opened.value.name || null, validPush(opened.value.push), opened.value.dev);
        evaluate();
    }

    async function onId(from, m, to) {
        const keys = FR.keys;
        if (!keys) return;
        let value;
        try { value = await C.openSignal(keys, from, to, m.d); } catch { return; } // another key: not for us
        if (!value || typeof value.pub !== 'string' || value.pub === S.self.pub) return;
        if (Math.abs(FR.serverNow() * 1000 - Number(value.ts)) > MAX_AGE) return;
        let raw;
        try { raw = C.unb64(value.pub); } catch { return; }
        if (raw.length !== 65 || raw[0] !== 4) return; // an uncompressed P-256 point
        const id = C.b64(new Uint8Array(await subtle.digest('SHA-256', raw)).slice(0, 12));
        let contact = S.contacts.get(id);
        if (!contact) {
            contact = { id, pub: value.pub, name: null, first: Date.now(), last: 0 };
            log('new known device', id);
        }
        await recognise(from, contact, value.name || null);
    }

    async function onKey(from, m) {
        const opened = await openFrom('key', from, m.d);
        if (!opened || typeof opened.value.s !== 'string' || opened.value.s.length > 200) return;
        await recognise(from, opened.contact);
        if (FR.keys) return; // this device already has a key for the room; never replaced silently
        await idle();
        if (FR.keys) return;
        await FR.setSecret(opened.value.s);
        if (FR.keys) FR.showToast(`End-to-end encrypted. Room key received from ${label(opened.contact)}, a known device.`, 'success', 6000);
    }

    /** Changing the key ends a running call or babyphone session: wait until there is none. */
    async function idle() {
        while (window.fileroomVoice?.active()) await new Promise((r) => setTimeout(r, 2000));
    }

    const label = (contact) => (contact?.own ? 'your other device' : contact?.alias || contact?.name || 'a known device');

    function evaluate() {
        clearTimeout(S.timer);
        S.timer = setTimeout(() => decide().catch((err) => log('decide failed', err)), 1200);
    }

    async function decide() {
        const me = FR.user;
        if (!me || !FR.online) return;
        const others = FR.users.filter((u) => u.id !== me.id);
        const known = others.filter((u) => S.known.has(u.id));
        let offer = false;
        if (FR.keys) {
            // This device has the room key: known devices that are here without one get it.
            for (const user of known) {
                if (S.sentKey.has(user.id) || S.peers.get(user.id)?.kid !== null) continue; // has a key, or has not said yet
                const contact = contactById(S.known.get(user.id));
                S.sentKey.add(user.id);
                send(user.id, { t: 'key', d: await sealFor(contact, 'key', user.id, { s: FR.secret }) });
                FR.showToast(`Room key shared with ${label(contact)} (known device).`, 'info', 4000);
            }
        } else if (known.length) {
            const keyHolder = known.some((u) => S.peers.get(u.id)?.kid); // it will send the key by itself
            const allKnown = known.length === others.length;
            const settled = others.every((u) => S.peers.get(u.id)?.kid !== undefined);
            if (!keyHolder && allKnown && settled) {
                // Everybody here is a known device: encrypt without asking. One device creates the key.
                if (others.every((u) => me.id < u.id)) await createKey(true);
            } else if (!keyHolder && !allKnown) {
                offer = true;
            }
        }
        if (offer !== S.offer) { S.offer = offer; render(); }
        if (offer && !S.hinted) {
            S.hinted = true;
            FR.showToast(`${known.map((u) => label(contactById(S.known.get(u.id)))).join(', ')}: known device here. Tap the lock to encrypt this room for known devices.`, 'info', 7000);
        }
    }

    async function createKey(automatic) {
        await idle();
        if (FR.keys) return;
        await FR.setSecret(C.randomSecret());
        if (!FR.keys) return;
        FR.showToast(automatic
            ? 'End-to-end encrypted automatically: everyone here is a known device.'
            : 'Room key created and shared with the known devices. Others need the invite link or QR code.', 'success', 6000);
        // The key change is announced below ('key' event): known devices then receive the key.
    }

    function forget(userId) {
        S.known.delete(userId);
        S.peers.delete(userId);
        S.sentKey.delete(userId);
        S.greeted.delete(userId);
        S.introduced.delete(userId);
        S.synced.delete(userId);
    }

    // ------------------------------------------------------------------ user interface
    function render() {
        renderPeople();
        renderBanner();
        const hint = document.getElementById('contactHint');
        if (hint) {
            hint.classList.toggle('d-none', !S.offer);
            if (S.offer) {
                const names = FR.users.filter((u) => S.known.has(u.id)).map((u) => label(contactById(S.known.get(u.id))));
                hint.querySelector('span').textContent = `${names.join(', ')} ${names.length > 1 ? 'are known devices' : 'is a known device'}. Encrypt this room for known devices? Everyone else needs the invite link.`;
            }
        }
        const count = document.getElementById('profileKnown');
        if (count) count.textContent = S.contacts.size ? `${S.contacts.size} known device${S.contacts.size > 1 ? 's' : ''}` : 'No known devices yet';
        const list = document.getElementById('profileContacts');
        if (list) {
            const here = presentContacts();
            list.innerHTML = [...S.contacts.values()].sort((a, b) => b.last - a.last).slice(0, 30).map((c) => `<li>
                <i class="bi ${here.has(c.id) ? 'bi-person-check-fill' : 'bi-person'}"></i>
                <span>${c.fav ? '<i class="bi bi-star-fill"></i> ' : ''}${FR.esc(displayName(c))}</span>
                <small>${here.has(c.id) ? 'in this room' : new Date(c.last || c.first).toLocaleDateString()}</small></li>`).join('');
        }
    }

    Object.assign(FR.actions, {
        'contacts-encrypt': () => createKey(false),
        'contacts-forget': async () => {
            if (!confirm('Forget all known devices and create a new identity for this device? Rooms you share right now stay as they are; automatic encryption with these devices stops until you meet again in an encrypted room.')) return;
            await resetIdentity();
            FR.showToast('Known devices forgotten. This device has a new identity and is no longer linked to your other devices.', 'success', 5000);
        },
    });

    async function resetIdentity() {
        await tx('contacts', 'readwrite', (s) => s.clear()).catch(() => {});
        await tx('self', 'readwrite', (s) => s.delete('identity')).catch(() => {});
        clearSession();
        await load();
        FR.renderUsers();
        render();
        hello();
    }
    function clearSession() {
        S.pair.clear(); S.known.clear(); S.peers.clear(); S.sentKey.clear(); S.greeted.clear(); S.introduced.clear(); S.synced.clear();
        S.nonce = C.b64(random(12));
        S.offer = false;
        S.link = null;
    }

    // ------------------------------------------------------------------ linked devices: keeping the lists in line
    const deletedGroups = () => FR.storage.get('fileroom_groups_gone') || [];
    /** Split a list into pieces that fit into one signaling frame after sealing. */
    function pieces(items, limit = 5000) {
        const out = [[]];
        let size = 0;
        for (const item of items) {
            const length = JSON.stringify(item).length;
            if (size + length > limit && out[out.length - 1].length) { out.push([]); size = 0; }
            out[out.length - 1].push(item);
            size += length;
        }
        return out;
    }
    const exportContact = (c) => ({ id: c.id, pub: c.pub, name: c.name, alias: c.alias || null, fav: Boolean(c.fav), first: c.first, last: c.last, mod: c.mod || 0, pushes: pushesOf(c) });
    const sharedLists = () => ({ groups: FR.storage.get('fileroom_groups') || [], gone: deletedGroups(), profile: FR.storage.get('fileroom_profile') || null });

    async function sendSync(userId) {
        if (!FR.user || S.known.get(userId) !== S.self.id) return;
        const parts = pieces([...S.contacts.values()].map(exportContact));
        for (let i = 0; i < parts.length; i++) {
            send(userId, { t: 'sync', d: await sealFor(selfContact(), 'sync', userId, { contacts: parts[i], ...(i === 0 ? sharedLists() : {}) }) });
        }
    }
    /** A list changed here: tell the own devices that are in this room right now. */
    function syncSoon() {
        clearTimeout(S.syncTimer);
        S.syncTimer = setTimeout(() => {
            for (const [userId, contactId] of S.known) if (contactId === S.self.id) sendSync(userId).catch((err) => log('sync', err));
        }, 800);
    }

    function validContact(c) {
        return c && typeof c.id === 'string' && c.id.length < 40 && typeof c.pub === 'string' && c.pub.length < 120 && c.id !== S.self.id;
    }
    async function mergeLists(value) {
        for (const theirs of Array.isArray(value.contacts) ? value.contacts.slice(0, MAX_CONTACTS) : []) {
            if (!validContact(theirs)) continue;
            const mine = S.contacts.get(theirs.id);
            const merged = mine || { id: theirs.id, pub: theirs.pub, name: null, first: Number(theirs.first) || Date.now(), last: 0 };
            if (!mine || (Number(theirs.mod) || 0) > (merged.mod || 0)) { // favourite and own name: the newer edit wins
                merged.fav = Boolean(theirs.fav);
                merged.alias = theirs.alias ? String(theirs.alias).slice(0, 20) : null;
                merged.mod = Number(theirs.mod) || 0;
            }
            if (!merged.name && theirs.name) merged.name = String(theirs.name).slice(0, 20);
            merged.first = Math.min(merged.first || Infinity, Number(theirs.first) || Infinity);
            merged.last = Math.max(merged.last || 0, Number(theirs.last) || 0);
            const pushes = pushesOf(merged);
            for (const [dev, push] of Object.entries(theirs.pushes || {}).slice(0, 6)) {
                const valid = validPush(push);
                if (valid && (!pushes[dev] || (Number(push.at) || 0) > pushes[dev].at)) pushes[dev] = { ...valid, at: Number(push.at) || 0 };
            }
            await saveContact(merged);
        }
        if (Array.isArray(value.gone) || Array.isArray(value.groups)) {
            const gone = [...new Set([...deletedGroups(), ...(value.gone || [])].filter((id) => typeof id === 'string'))].slice(-100);
            const byId = new Map(groups().map((g) => [g.id, g]));
            for (const g of (value.groups || []).slice(0, 30)) {
                if (!g || typeof g.id !== 'string' || !Array.isArray(g.members)) continue;
                const mine = byId.get(g.id);
                if (!mine || (Number(g.mod) || 0) > (mine.mod || 0)) byId.set(g.id, { id: g.id, name: String(g.name || 'Group').slice(0, 30), members: g.members.filter((m) => typeof m === 'string').slice(0, MAX_CONTACTS), mod: Number(g.mod) || 0 });
            }
            FR.storage.set('fileroom_groups_gone', gone);
            FR.storage.set('fileroom_groups', [...byId.values()].filter((g) => !gone.includes(g.id)).slice(-30));
        }
        const profile = value.profile;
        const current = FR.storage.get('fileroom_profile') || {};
        if (profile && typeof profile === 'object' && (Number(profile.mod) || 0) > (current.mod || 0)) {
            FR.storage.set('fileroom_profile', { name: String(profile.name || '').slice(0, 20), public: profile.public !== false, mod: Number(profile.mod) });
        }
    }

    async function onSync(from, m) {
        const opened = await openFrom('sync', from, m.d);
        if (!opened?.contact.own) return; // only this identity's own devices may write into the lists
        await mergeLists(opened.value);
        FR.renderUsers();
        render();
    }

    // ------------------------------------------------------------------ linking a device
    const LINK_TTL = 5 * 60000;
    async function linkKey(secret) {
        const ikm = await subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveBits']);
        const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8('fileroom-link-v1'), info: utf8(FR.roomCode) }, ikm, 256);
        return subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    async function sealLink(secret, to, value) {
        const iv = random(12);
        const sealed = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad('link', FR.user.id, to || '*') }, await linkKey(secret), utf8(JSON.stringify(value)));
        return `${C.b64(iv)}.${C.b64(new Uint8Array(sealed))}`;
    }
    async function openLink(secret, from, to, sealed) {
        try {
            const [iv, body] = String(sealed).split('.');
            const plain = await subtle.decrypt({ name: 'AES-GCM', iv: C.unb64(iv), additionalData: utf8(`link|${FR.roomCode}|${from}|${to || '*'}`) }, await linkKey(secret), C.unb64(body));
            return JSON.parse(new TextDecoder().decode(plain));
        } catch { return null; }
    }

    /** This device shows the code: the other one scans it. */
    async function startLink() {
        await S.ready;
        if (!S.self.priv.extractable) {
            // Identities made before linking existed are locked into the browser and cannot be copied.
            if (!confirm('The identity of this device was created by an older version and cannot be copied. Create a new one now? Devices that know this one have to meet it once more in an encrypted room (scan a QR code).')) return;
            await resetIdentity();
        }
        await FR.ensureJoined();
        S.link = { secret: C.b64(random(16)), until: Date.now() + LINK_TTL };
        const url = `${location.origin}/room/${encodeURIComponent(FR.roomCode)}#link=${S.link.secret}`;
        const svg = window.FileRoomQR?.svg(url);
        const box = document.getElementById('linkBox');
        document.getElementById('linkQr').src = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : '';
        document.getElementById('linkUrl').value = url;
        box.classList.remove('d-none');
        setTimeout(() => { if (S.link && Date.now() >= S.link.until) { S.link = null; box.classList.add('d-none'); } }, LINK_TTL + 500);
    }

    async function onLinkRequest(from, m) {
        const link = S.link;
        if (!link || Date.now() > link.until) return;
        const request = await openLink(link.secret, from, null, m.d);
        if (!request) return; // did not see the code
        S.link = null; // one device per code
        document.getElementById('linkBox')?.classList.add('d-none');
        const who = FR.users.find((u) => u.id === from)?.name || 'A device';
        if (!confirm(`Link the device "${who}"? It gets a copy of this device's identity, known devices, favourites and name, and can act as you. Only confirm if this is your own device.`)) {
            send(from, { t: 'link', d: await sealLink(link.secret, from, { refused: true }) });
            return;
        }
        const identity = { jwk: await subtle.exportKey('jwk', S.self.priv), pub: S.self.pub, created: S.self.created };
        const parts = pieces([...S.contacts.values()].map(exportContact));
        for (let i = 0; i < parts.length; i++) {
            const head = i === 0 ? { identity, ...sharedLists(), secret: FR.secret || null } : {};
            send(from, { t: 'link', d: await sealLink(link.secret, from, { i, n: parts.length, contacts: parts[i], ...head }) });
        }
        FR.showToast(`"${who}" is now linked to this device.`, 'success', 5000);
    }

    /** The other device: ask for the identity with the secret from the code. */
    async function requestLink() {
        const secret = S.linkJoin;
        if (!secret) return;
        if (!confirm('Link this device? It takes over the identity, known devices, favourites and name of the device that shows the code. What this device knows so far is replaced.')) { S.linkJoin = null; return; }
        S.linkParts = [];
        for (let attempt = 0; attempt < 4 && S.linkJoin; attempt++) {
            if (FR.online) send(null, { t: 'link-req', d: await sealLink(secret, null, { dev: S.dev }) });
            await new Promise((r) => setTimeout(r, 2500 + attempt * 2500));
            if (S.linkParts?.length) return; // the transfer is running (the other side may still be confirming otherwise)
        }
        if (S.linkJoin && !S.linkParts?.length) FR.showToast('The other device did not answer. Open "Link another device" there again and scan the new code.', 'warning', 8000);
    }

    async function onLink(from, m) {
        if (!S.linkJoin || !S.linkParts) return;
        const part = await openLink(S.linkJoin, from, FR.user.id, m.d);
        if (!part) return;
        if (part.refused) { S.linkJoin = null; FR.showToast('The other device declined.', 'warning', 5000); return; }
        S.linkParts[part.i] = part;
        if (S.linkParts.filter(Boolean).length < part.n) return;
        const all = S.linkParts;
        S.linkJoin = S.linkParts = null;
        try {
            const head = all[0];
            const jwk = head.identity.jwk;
            const priv = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
            // The public key is taken from the private key itself, not from what the message claims.
            const pub = C.b64(new Uint8Array([4, ...C.unb64(jwk.x), ...C.unb64(jwk.y)]));
            await tx('contacts', 'readwrite', (s) => s.clear());
            await tx('self', 'readwrite', (s) => s.put({ priv, pub, created: Number(head.identity.created) || Date.now() }, 'identity'));
            S.contacts.clear();
            FR.storage.set('fileroom_groups', []);
            FR.storage.set('fileroom_profile', { name: '', public: true, mod: -1 });
            clearSession();
            await load();
            for (const p of all) await mergeLists(p);
            if (head.secret && typeof head.secret === 'string') FR.storage.set(`fileroom_key_${FR.roomCode}`, head.secret);
            FR.showToast('This device is linked. Loading…', 'success', 3000);
            setTimeout(() => location.reload(), 800); // start clean: new identity, name and room key
        } catch (err) {
            log('link failed', err);
            FR.showToast('Linking failed. Nothing was changed on the other device; try again with a new code.', 'danger', 7000);
        }
    }

    // ------------------------------------------------------------------ wiring
    let chain = Promise.resolve();
    FR.on('signal', (from, data, to) => {
        if (!data.startsWith('c.') || data.length > 12000) return;
        chain = chain.then(async () => {
            await S.ready;
            const me = FR.user;
            if (!me || !S.self || from === me.id || (to && to !== me.id)) return;
            let m;
            try { m = JSON.parse(data.slice(2)); } catch { return; }
            if (!m || typeof m !== 'object') return;
            if (m.t === 'probe') await onProbe(from, m);
            else if (m.t === 'tags') await onTags(from, m);
            else if (m.t === 'hi') await onHi(from, m);
            else if (m.t === 'id') await onId(from, m, to);
            else if (m.t === 'key') await onKey(from, m);
            else if (m.t === 'sync') await onSync(from, m);
            else if (m.t === 'link-req') await onLinkRequest(from, m);
            else if (m.t === 'link') await onLink(from, m);
        }).catch((err) => log('message failed', err));
    });

    const hello = () => S.ready.then(() => { if (FR.online && S.self) { probe(); evaluate(); } }).catch(() => {});
    FR.on('ws-open', hello);
    FR.on('ready', hello);
    FR.on('users', () => {
        if (!S.self || !FR.user) return;
        // Somebody we have not exchanged a probe with (it joined while we were busy): ask.
        for (const user of FR.users) {
            if (user.id !== FR.user.id && !S.peers.has(user.id) && FR.online) probe(user.id);
        }
        evaluate();
    });
    FR.on('user-left', (id) => forget(id));
    FR.on('rejoin', () => { S.known.clear(); S.peers.clear(); S.sentKey.clear(); S.greeted.clear(); S.introduced.clear(); S.synced.clear(); });
    FR.on('key', () => {
        // Others must learn that this device has (another) key now; known devices without one get it.
        S.sentKey.clear();
        S.introduced.clear();
        S.offer = false;
        render();
        hello();
    });
    /** Name or reachability changed: tell the known devices in this room. */
    function greetAll() {
        S.greeted.clear();
        return S.ready.then(async () => {
            for (const [userId, contactId] of S.known) {
                const contact = S.contacts.get(contactId);
                if (contact && FR.user) { S.greeted.add(userId); await greet(userId, contact); }
            }
            if (FR.keys) introduce();
        }).catch(() => {});
    }
    FR.on('profile', () => { greetAll(); syncSoon(); });

    // ------------------------------------------------------------------ invitations (Web Push between known devices)
    const INVITE_MAX_AGE = 2 * 3600000;
    const displayName = (contact) => contact?.alias || contact?.name || 'Unnamed device';
    const sameRoom = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
    const invites = () => (FR.storage.get('fileroom_invites') || []).filter((i) => Date.now() - i.at < INVITE_MAX_AGE);
    const groups = () => (FR.storage.get('fileroom_groups') || []).filter((g) => g && g.id && Array.isArray(g.members));

    /** This phone's push subscription (the same one the babyphone uses). Asking needs a tap. */
    async function setupPush(ask = false) {
        try {
            if (!('PushManager' in window) || !navigator.serviceWorker || !('Notification' in window)) return null;
            if (ask && Notification.permission === 'default') await Notification.requestPermission();
            if (Notification.permission !== 'granted') return null;
            const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
            if (!registration?.pushManager) return null;
            let vapid = FR.storage.get('fileroom_vapid');
            let subscription = await registration.pushManager.getSubscription();
            const current = subscription?.options?.applicationServerKey ? C.b64(new Uint8Array(subscription.options.applicationServerKey)) : null;
            if (subscription && (!vapid?.privateJwk || current !== vapid.publicKey)) { await subscription.unsubscribe(); subscription = null; }
            if (!vapid?.privateJwk) { vapid = await C.generateVapid(); FR.storage.set('fileroom_vapid', vapid); }
            if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: C.unb64(vapid.publicKey) });
            const json = subscription.toJSON();
            return { sub: { endpoint: json.endpoint, keys: json.keys }, vapid };
        } catch (err) {
            log('push not available', err);
            return null;
        }
    }

    async function refreshPush(ask = false) {
        const push = await setupPush(ask);
        if (JSON.stringify(push?.sub || null) !== JSON.stringify(S.push?.sub || null)) {
            S.push = push;
            await greetAll();
        }
        render();
        return push;
    }

    const inviteAad = (from, to) => utf8(`invite|${from}|${to}`);
    async function sealInvite(contact, value) {
        const { aes } = await pairKeys(contact);
        const iv = random(12);
        const sealed = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: inviteAad(S.self.id, contact.id) }, aes, utf8(JSON.stringify({ ...value, ts: Date.now() })));
        return `${C.b64(iv)}.${C.b64(new Uint8Array(sealed))}`;
    }
    async function openInvite(sealed) {
        const [iv, body] = String(sealed).split('.');
        if (!iv || !body) return null;
        for (const contact of S.contacts.values()) {
            try {
                const { aes } = await pairKeys(contact);
                const plain = await subtle.decrypt({ name: 'AES-GCM', iv: C.unb64(iv), additionalData: inviteAad(contact.id, S.self.id) }, aes, C.unb64(body));
                const value = JSON.parse(new TextDecoder().decode(plain));
                return Math.abs(Date.now() - Number(value.ts)) < INVITE_MAX_AGE ? { contact, value } : null;
            } catch { /* not from this one */ }
        }
        return null;
    }

    /** Offer the ticked known devices to join this room. Returns {sent, failed, here, unreachable}. */
    async function invite(contactIds, text = '') {
        await S.ready;
        const result = { sent: 0, failed: 0, here: 0, unreachable: 0 };
        const me = await FR.ensureJoined();
        const here = presentContacts();
        for (const id of new Set(contactIds)) {
            const contact = S.contacts.get(id);
            if (!contact) continue;
            // Somebody listed as "here" may have left a moment ago (or be here with one device only):
            // send the notification anyway; a phone that is in this room just shows a short note.
            if (!reachable(contact)) { if (here.has(id)) result.here++; else result.unreachable++; continue; }
            let delivered = false, dead = false;
            try {
                const d = await sealInvite(contact, { room: FR.roomCode, s: FR.secret || null, text: String(text || '').slice(0, 120) });
                // One push per device of that person. Outside the seal only what the notification needs;
                // the receiving page trusts the sealed part alone.
                for (const [dev, push] of Object.entries(pushesOf(contact))) {
                    const request = await C.pushRequest(push.sub, push.vapid,
                        { t: 'invite', room: FR.roomCode, name: privateName() || me.name, d },
                        { subject: location.protocol === 'https:' ? location.origin : 'mailto:fileroom@localhost.invalid', ttl: 3600 });
                    const answer = await FR.api('/api/push', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: me.id, ...request }),
                    });
                    if (answer.status === 404 || answer.status === 410) { delete contact.pushes[dev]; dead = true; } // that address is gone
                    else if (answer.status < 400) delivered = true;
                }
                if (dead) { await saveContact(contact); syncSoon(); }
                if (delivered) result.sent++;
                else if (!reachable(contact)) result.unreachable++;
                else result.failed++;
            } catch (err) {
                log('invite failed', err);
                if (delivered) result.sent++; else result.failed++;
            }
        }
        render();
        return result;
    }

    function inviteSummary(r) {
        const parts = [];
        if (r.sent) parts.push(`${r.sent} invited`);
        if (r.here) parts.push(`${r.here} already here`);
        if (r.unreachable) parts.push(`${r.unreachable} cannot be reached (notifications off on that phone)`);
        if (r.failed) parts.push(`${r.failed} failed`);
        return parts.join(' · ') || 'Nobody ticked';
    }

    /** An invitation arrived (from the service worker, or in the link of a notification). */
    async function receiveInvite(payload, { open = false } = {}) {
        await S.ready;
        if (!payload || typeof payload.d !== 'string' || payload.d.length > 4000) return false;
        const opened = await openInvite(payload.d);
        const value = opened?.value;
        if (!value || typeof value.room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.room)) return false; // not from a known device
        const { contact } = opened;
        const secret = typeof value.s === 'string' && value.s.length <= 200 ? value.s : null;
        if (sameRoom(value.room, FR.roomCode)) {
            if (secret && !FR.keys) { await idle(); if (!FR.keys) await FR.setSecret(secret); }
            FR.showToast(`${displayName(contact)} invited you to this room.`, 'info', 4000);
            return true;
        }
        // The key waits where the room page looks for it: joining needs no link with a key in it.
        if (secret) FR.storage.set(`fileroom_key_${value.room.toUpperCase()}`, secret);
        const list = invites().filter((i) => !sameRoom(i.room, value.room));
        list.unshift({ room: value.room, from: contact.id, text: String(value.text || '').slice(0, 120), at: Date.now() });
        FR.storage.set('fileroom_invites', list.slice(0, 20));
        render();
        if (open) joinRoom(value.room);
        return true;
    }

    function dismissInvite(room) {
        FR.storage.set('fileroom_invites', invites().filter((i) => !sameRoom(i.room, room)));
        render();
    }
    function joinRoom(room) {
        dismissInvite(room);
        location.href = `/room/${encodeURIComponent(room)}`;
    }

    function peopleHtml() {
        const here = presentContacts();
        const reach = (c) => Number(reachable(c) || here.has(c.id));
        const list = [...S.contacts.values()].sort((a, b) => (Number(Boolean(b.fav)) - Number(Boolean(a.fav))) || (reach(b) - reach(a)) || (b.last - a.last));
        if (!list.length) return '<p class="sheet-note">No known devices yet. Share an encrypted room with somebody once (scan the QR code) – after that you can invite each other from anywhere.</p>';
        return list.map((c) => {
            const id = FR.esc(c.id);
            const state = here.has(c.id) ? 'in this room' : reachable(c) ? '' : 'cannot be reached';
            return `<li class="${reachable(c) || here.has(c.id) ? '' : 'muted'}">
                <label><input type="checkbox" data-contact="${id}"${S.ticked.has(c.id) ? ' checked' : ''}> <span>${FR.esc(displayName(c))}</span></label>
                <small>${state}</small>
                <button type="button" class="people-btn" data-action="people-rename" data-id="${id}" title="Rename"><i class="bi bi-pencil"></i></button>
                <button type="button" class="people-btn${c.fav ? ' on' : ''}" data-action="people-fav" data-id="${id}" title="Favourite"><i class="bi ${c.fav ? 'bi-star-fill' : 'bi-star'}"></i></button>
            </li>`;
        }).join('');
    }

    function renderPeople() {
        const list = document.getElementById('peopleList');
        if (!list) return;
        list.innerHTML = peopleHtml();
        document.getElementById('peopleGroups').innerHTML = groups().map((g) => {
            const members = g.members.filter((id) => S.contacts.has(id));
            const all = members.length && members.every((id) => S.ticked.has(id));
            return `<span class="people-group${all ? ' on' : ''}"><button type="button" data-action="people-group" data-id="${FR.esc(g.id)}"><i class="bi bi-people-fill"></i> ${FR.esc(g.name)} (${members.length})</button><button type="button" data-action="people-group-delete" data-id="${FR.esc(g.id)}" title="Delete group"><i class="bi bi-x"></i></button></span>`;
        }).join('');
        const ticked = [...S.ticked].filter((id) => S.contacts.has(id)).length;
        document.getElementById('peopleInvite').disabled = !ticked;
        document.getElementById('peopleInviteCount').textContent = ticked ? ` (${ticked})` : '';
        document.getElementById('peopleSaveGroup').disabled = ticked < 2;
        const canAsk = 'Notification' in window && Notification.permission === 'default';
        document.getElementById('peoplePush').classList.toggle('d-none', Boolean(S.push));
        document.getElementById('peoplePushText').textContent = S.push ? '' : canAsk
            ? 'Others cannot invite this phone yet: allow notifications.'
            : 'Others cannot invite this phone: notifications are blocked or the app is not installed (needs HTTPS).';
        document.getElementById('peoplePushBtn').classList.toggle('d-none', !canAsk);
        const pending = invites();
        document.getElementById('peopleInvites').innerHTML = pending.map((i) => `<li>
            <span><strong>${FR.esc(displayName(S.contacts.get(i.from)))}</strong> invites you to <strong>${FR.esc(i.room)}</strong>${i.text ? `<br><small>${FR.esc(i.text)}</small>` : ''}</span>
            <button type="button" class="btn btn-primary btn-sm" data-action="invite-join" data-room="${FR.esc(i.room)}">Join</button>
            <button type="button" class="people-btn" data-action="invite-dismiss" data-room="${FR.esc(i.room)}" title="Dismiss"><i class="bi bi-x-lg"></i></button></li>`).join('');
        document.getElementById('peopleInvitesTitle').classList.toggle('d-none', !pending.length);
    }

    function renderBanner() {
        const banner = document.getElementById('inviteBanner');
        if (!banner) return;
        const pending = invites().filter((i) => !sameRoom(i.room, FR.roomCode));
        banner.classList.toggle('d-none', !pending.length);
        if (!pending.length) return;
        const [first] = pending;
        document.getElementById('inviteText').textContent = `${displayName(S.contacts.get(first.from))} invites you to room ${first.room}${pending.length > 1 ? ` (+${pending.length - 1} more)` : ''}`;
        banner.querySelector('[data-action="invite-join"]').dataset.room = first.room;
        banner.querySelector('[data-action="invite-dismiss"]').dataset.room = first.room;
    }

    const mutate = async (id, change) => { const c = S.contacts.get(id); if (c) { change(c); c.mod = Date.now(); await saveContact(c); FR.renderUsers(); render(); syncSoon(); } };
    Object.assign(FR.actions, {
        'open-people': () => {
            for (const id of ['qrModal', 'profileModal', 'keyModal']) document.getElementById(id)?.classList.remove('show');
            render();
            document.getElementById('peopleModal').classList.add('show');
            refreshPush();
        },
        'close-people': () => document.getElementById('peopleModal').classList.remove('show'),
        'people-push': () => refreshPush(true),
        'people-fav': (el) => mutate(el.dataset.id, (c) => { c.fav = !c.fav; }),
        'people-rename': (el) => {
            const contact = S.contacts.get(el.dataset.id);
            if (!contact) return;
            const alias = prompt('Your name for this device (only on this phone). Empty: the name it gave itself.', contact.alias || contact.name || '');
            if (alias !== null) mutate(contact.id, (c) => { c.alias = alias.trim().slice(0, 20) || null; });
        },
        'people-group': (el) => {
            const group = groups().find((g) => g.id === el.dataset.id);
            if (!group) return;
            const members = group.members.filter((id) => S.contacts.has(id));
            const all = members.every((id) => S.ticked.has(id));
            for (const id of members) { if (all) S.ticked.delete(id); else S.ticked.add(id); }
            render();
        },
        'people-group-delete': (el) => {
            const group = groups().find((g) => g.id === el.dataset.id);
            if (!group || !confirm(`Delete the group "${group.name}"? The devices stay known.`)) return;
            FR.storage.set('fileroom_groups', groups().filter((g) => g.id !== group.id));
            FR.storage.set('fileroom_groups_gone', [...deletedGroups(), group.id].slice(-100));
            render();
            syncSoon();
        },
        'people-save-group': () => {
            const members = [...S.ticked].filter((id) => S.contacts.has(id));
            const name = prompt('Name of the group:', '');
            if (!name || !name.trim()) return;
            FR.storage.set('fileroom_groups', [...groups(), { id: C.b64(random(6)), name: name.trim().slice(0, 30), members, mod: Date.now() }].slice(-30));
            render();
            syncSoon();
        },
        'people-invite': async () => {
            const button = document.getElementById('peopleInvite');
            button.disabled = true;
            const result = await invite([...S.ticked], document.getElementById('peopleText').value);
            FR.showToast(inviteSummary(result), result.sent ? 'success' : 'warning', 6000);
            if (result.sent) { S.ticked.clear(); document.getElementById('peopleText').value = ''; document.getElementById('peopleModal').classList.remove('show'); }
            render();
        },
        'link-start': () => startLink().catch((err) => { log('link', err); FR.showToast('Could not create a code for linking.', 'danger'); }),
        'link-copy': () => { navigator.clipboard?.writeText(document.getElementById('linkUrl').value).then(() => FR.showToast('Link copied. Open it on your other device within 5 minutes.', 'success', 4000)).catch(() => {}); },
        'invite-join': (el) => joinRoom(el.dataset.room),
        'invite-dismiss': (el) => dismissInvite(el.dataset.room),
    });
    document.getElementById('peopleList')?.addEventListener('change', (e) => {
        const id = e.target.dataset?.contact;
        if (!id) return;
        if (e.target.checked) S.ticked.add(id); else S.ticked.delete(id);
        renderPeople();
    });
    document.getElementById('peopleModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('peopleModal')?.classList.remove('show'); });
    navigator.serviceWorker?.addEventListener('message', (e) => {
        if (e.data?.type === 'FILEROOM_INVITE') receiveInvite(e.data.invite, { open: Boolean(e.data.open) }).catch((err) => log('invite', err));
    });
    window.addEventListener('storage', (e) => { if (e.key === 'fileroom_invites') render(); }); // another tab handled it

    // "#link=<one-time secret>": this device was sent here to be linked. The fragment never reached the server.
    const linkMatch = location.hash.match(/^#link=([A-Za-z0-9_-]{16,40})$/);
    if (linkMatch) {
        S.linkJoin = linkMatch[1];
        history.replaceState(null, '', location.pathname + location.search);
    }

    // An invitation in the link (tap on the notification while the app was closed).
    let linkInvite = null;
    try { linkInvite = JSON.parse(new URLSearchParams(location.search).get('invite') || 'null'); } catch { /* ignore */ }

    /** People picked on the share page ("send to …"): invite them as soon as this room is ready. */
    async function inviteAfterShare() {
        const after = FR.storage.get('fileroom_invite_after');
        if (!after || !Array.isArray(after.ids)) return;
        try { localStorage.removeItem('fileroom_invite_after'); } catch { /* ignore */ }
        if (Date.now() - after.at > 5 * 60000 || !after.ids.length) return;
        const result = await invite(after.ids);
        FR.showToast(inviteSummary(result), result.sent ? 'success' : 'warning', 6000);
    }

    S.ready = load().then(async () => {
        S.push = await setupPush(false);
        render();
        FR.renderUsers();
    }).catch((err) => { log('identity not available', err); });
    const afterReady = () => S.ready.then(async () => {
        if (linkInvite) { const invite_ = linkInvite; linkInvite = null; await receiveInvite(invite_); }
        await inviteAfterShare();
        if (S.linkJoin) await requestLink();
    }).catch((err) => log('startup', err));
    if (FR.ready) { hello(); afterReady(); } else FR.on('ready', afterReady);

    window.fileroomContacts = {
        /** For the user list: is this user a known device? Since when, under which name? */
        known(userId) {
            const contact = contactById(S.known.get(userId));
            if (!contact) return null;
            if (contact.own) return { name: 'your device', first: 0, old: true, fav: false, own: true };
            return { name: contact.alias || contact.name, first: contact.first, old: contact.first < PAGE_START, fav: Boolean(contact.fav) };
        },
        render, invite, receiveInvite,
        _state: S,
        _setPush(push) { S.push = push; return greetAll(); }, // tests: stands in for a real push subscription
    };
})();
