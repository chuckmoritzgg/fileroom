/**
 * FileRoom voice: peer-to-peer calls and the babyphone (baby monitor) built on top of them.
 *
 * Every device in a room can take one voice role:
 *   talk   - participant of the room's voice call (full mesh, everybody hears everybody)
 *   baby   - baby station: microphone + sound detection, sends to every parent unit
 *   parent - parent unit: hears the baby stations, gets alerts, can talk back
 * talk<->talk and baby<->parent are connected with one RTCPeerConnection each (audio + a data
 * channel). Audio never passes through the FileRoom server.
 *
 * Signaling goes through the room WebSocket as opaque strings. With a room key they are sealed
 * (AES-GCM, bound to room, sender and receiver), which also authenticates the DTLS fingerprints:
 * the call is end-to-end encrypted and the server cannot put itself in the middle. The server keeps
 * no call state; devices in a session announce themselves every 15 s.
 *
 * Babyphone specifics
 *   - The level is measured on the audio thread (AudioWorklet), with an adaptive noise floor, so a
 *     fan or white-noise machine does not trigger alerts.
 *   - The audio sent to the parents is delayed by 0.4 s while "sound detected" travels over the data
 *     channel at once. A parent unit in "alerts only" mode therefore opens its speaker *before* the
 *     sound arrives - nothing is cut off, and silence costs almost no data (Opus DTX).
 *   - An alarm that is not acknowledged within 4 s (parent phone asleep, browser suspended, out of
 *     Wi-Fi) is sent again as a Web Push notification, encrypted on the baby station.
 *   - The parent unit raises an alarm of its own when the baby station stops reporting.
 *   - A parent unit has no microphone open, so Android would put the page to sleep with the screen
 *     off. A looped, inaudible tone (30 Hz) makes it a media player: Chrome then keeps it running and
 *     shows a playback notification.
 *
 * Calls
 *   - Chrome on Android lists the phone's audio routes as *microphones* ("Headset earpiece",
 *     "Speakerphone", "Bluetooth headset", ...): opening one of them selects where the call is heard.
 *     A call starts on the earpiece like a phone call; the speaker button switches.
 *   - Tuned for low delay: 10 ms Opus frames, no DTX, smallest jitter buffer. The bar shows the
 *     measured network round trip and buffer, and whether the audio is relayed.
 */
(() => {
    'use strict';
    const FR = window.fileroom;
    const C = window.FileRoomCrypto;
    if (!FR || !C) return;
    const $ = (id) => document.getElementById(id);
    const esc = FR.esc;
    const build = document.querySelector('meta[name="app-build"]')?.content || '';
    const SUPPORTED = Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia && window.isSecureContext);

    const MAX_PEERS = 6;                 // mesh: fine for audio, keeps phones cool
    const ANNOUNCE_MS = 15000;           // "I am in a session" broadcast
    const ROSTER_TTL = 45000;            // forget a silent device after this long
    const SIGNAL_MAX_AGE = 5 * 60000;    // replay window for signaling
    const PREROLL = 0.4;                 // seconds the baby audio is delayed (see above)
    const HOLD_MS = 6000;                // "sound" stays active this long after the last loud moment
    const ALARM_COOLDOWN = 20000;
    const ACK_TIMEOUT = 4000;            // unacknowledged alarm -> push notification
    const LOST_AFTER = 20000;            // parent: no data from the baby station -> alarm
    const GONE_AFTER = 45000;            // baby: parent unit vanished without saying bye -> push
    const RESUME_WINDOW = 10 * 60000;    // reload/update/crash: resume a babyphone session
    // Sensitivity 1 (only loud crying) .. 5 (every rustle): dB above the noise floor, absolute minimum
    const SENSITIVITY = [null, { margin: 24, min: -38 }, { margin: 18, min: -44 }, { margin: 14, min: -50 },
        { margin: 10, min: -55 }, { margin: 7, min: -60 }];
    const BITRATE = { talk: 40000, baby: 24000, parent: 24000 };
    // Audio routes of an Android phone, as Chrome names them (fixed English labels in Chromium).
    const ROUTES = [
        { kind: 'earpiece', match: /earpiece/i, icon: 'bi-phone-fill', label: 'Earpiece' },
        { kind: 'speaker', match: /speakerphone/i, icon: 'bi-volume-up-fill', label: 'Speaker' },
        { kind: 'bluetooth', match: /bluetooth/i, icon: 'bi-bluetooth', label: 'Bluetooth headset' },
        { kind: 'wired', match: /wired headset|usb audio/i, icon: 'bi-headphones', label: 'Headset' },
    ];
    const ALERT_RANK = { lost: 4, mic: 3, blocked: 2, battery: 1 };
    const ROLE_LABEL = { talk: 'Voice call', baby: 'Baby station', parent: 'Parent unit' };
    const SESSION_KEY = () => `fileroom_voice_${FR.roomCode}`;
    const BABY_KEY = () => `fileroom_baby_${FR.roomCode}`;

    const randomId = () => C.b64(crypto.getRandomValues(new Uint8Array(9)));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const wants = (a, b) => (a === 'talk' && b === 'talk') || (a === 'baby' && b === 'parent') || (a === 'parent' && b === 'baby');
    // Fixed roles for the offer: the parent unit calls the baby station; in a call the smaller id calls.
    const isOfferer = (myRole, myId, peerId) => (myRole === 'parent' ? true : myRole === 'baby' ? false : myId < peerId);

    const V = {
        inst: randomId(),           // this page load
        seq: 0,
        seen: new Map(),            // remote instance -> highest sequence number (replay protection)
        role: null,
        since: 0,
        ringUntil: 0,
        roster: new Map(),          // user id -> {id, inst, role, name, seen, ring}
        peers: new Map(),           // user id -> peer
        ice: null, iceAt: 0, iceTtl: 3600000, pushRelay: true,
        mic: null,                  // {stream, track} (call microphone / talk-back microphone)
        muted: false,
        alertCtx: null,             // AudioContext for ring tones and alarms
        baby: null,                 // baby station pipeline
        parent: { mode: 'alerts', talking: false, push: null, lost: new Map(), micTimer: null },
        ring: null,                 // incoming call {id, inst, timer}
        dismissed: new Set(),
        alerts: new Map(),          // kind -> {kind, text, repeat}; several can be active at once
        alert: null,                // the most important of them (shown in the banner)
        alertTimer: null,
        routes: {},                 // kind -> microphone deviceId that selects this audio route
        route: null,                // route in use during a call
        keep: null,                 // parent unit: inaudible loop that keeps the page alive in the background
        ticker: null, lastTick: 0, lastAnnounce: 0,
        releaseLock: null,
        wakeLock: null, wantWake: false,
        night: { auto: false, last: Date.now() },
        blocked: false,             // audio playback needs a tap
        notes: new Map(),
        helloAt: new Map(),
    };

    const log = (...args) => console.debug('[voice]', ...args);
    const nameOf = (id) => FR.users.find((u) => u.id === id)?.name || V.roster.get(id)?.name || 'Someone';
    const others = (role) => [...V.roster.values()].filter((r) => r.role === role);
    const channelOpen = (p) => p?.dc?.readyState === 'open';

    // ======================================================================
    // Signaling (sealed with the room key when there is one)
    // ======================================================================
    let sendChain = Promise.resolve();
    let recvChain = Promise.resolve();

    function signal(to, type, body = {}) {
        // Queued: encryption is asynchronous, but the order must be kept (sequence numbers, SDP before ICE).
        const job = sendChain.then(async () => {
            const me = FR.user;
            if (!me) return false;
            const payload = { v: 1, i: V.inst, n: ++V.seq, ts: Math.round(FR.serverNow() * 1000), t: type, ...body };
            const keys = FR.keys;
            const data = keys ? `s.${await C.sealSignal(keys, me.id, to, payload)}` : `p.${JSON.stringify(payload)}`;
            return FR.sendSignal(to, data);
        });
        sendChain = job.catch((err) => log('send failed', err));
        return job;
    }

    function note(kind, text) {
        if (Date.now() - (V.notes.get(kind) || 0) < 60000) return;
        V.notes.set(kind, Date.now());
        FR.showToast(text, 'warning', 8000);
    }

    function foreign(kind) {
        if (V.foreign === kind) return;
        V.foreign = kind;
        update();
    }

    async function receive(from, data, to) {
        const me = FR.user;
        if (!me || from === me.id || (to && to !== me.id)) return;
        const keys = FR.keys;
        let msg;
        if (data.startsWith('s.')) {
            // Devices with another (or no) key cannot be called. No pop-up for that - every device says
            // "hello" when it connects - but the call sheet explains it.
            if (!keys) return foreign('needKey');
            try { msg = await C.openSignal(keys, from, to, data.slice(2)); } catch { return foreign('otherKey'); }
        } else if (data.startsWith('p.')) {
            // Never accept unencrypted signaling in an encrypted room (no downgrade).
            if (keys) return foreign('noKey');
            try { msg = JSON.parse(data.slice(2)); } catch { return; }
        } else {
            return;
        }
        if (!msg || msg.v !== 1 || typeof msg.i !== 'string' || msg.i === V.inst || !Number.isInteger(msg.n)) return;
        if (Math.abs(FR.serverNow() * 1000 - Number(msg.ts)) > SIGNAL_MAX_AGE) return;
        if (msg.n <= (V.seen.get(msg.i) || 0)) return; // replayed or reordered
        V.seen.set(msg.i, msg.n);
        if (V.seen.size > 500) V.seen.delete(V.seen.keys().next().value);
        await handleSignal(from, msg);
    }

    async function handleSignal(from, msg) {
        switch (msg.t) {
            case 'hello':
                if (V.role && Date.now() - (V.helloAt.get(from) || 0) > 2000) {
                    V.helloAt.set(from, Date.now());
                    announce(from);
                    const waiting = V.peers.get(from);
                    if (waiting?.offerer) recover(waiting, true); // it may have missed our offer
                }
                break;
            case 'state':
                onState(from, msg);
                break;
            case 'sdp':
            case 'ice':
            case 'restart': {
                // An offer introduces its sender, in case it overtook the announcement.
                if (msg.t === 'sdp' && msg.role && V.roster.get(from)?.inst !== msg.i) onState(from, { ...msg, ring: 0 });
                const peer = V.peers.get(from);
                if (!peer || peer.inst !== msg.i) {
                    // We do not know this device (yet): ask it to introduce itself; it will offer again.
                    if (V.role && msg.t === 'sdp') signal(from, 'hello');
                    break;
                }
                if (msg.t === 'sdp') onSdp(peer, msg);
                else if (msg.t === 'ice') onIce(peer, msg);
                else if (peer.offerer) recover(peer, true);
                break;
            }
            case 'decline':
                if (V.role === 'talk' && Date.now() < V.ringUntil) FR.showToast(`${nameOf(from)} declined the call`, 'info', 3000);
                break;
        }
    }

    function announce(to = null) {
        return signal(to, 'state', {
            role: V.role, name: FR.user?.name, since: V.since,
            ring: V.role === 'talk' && Date.now() < V.ringUntil ? 1 : 0,
        });
    }

    function onState(from, msg) {
        const known = V.roster.get(from);
        if (!['talk', 'baby', 'parent'].includes(msg.role)) {
            if (known && known.inst === msg.i) dropDevice(from, true);
            return;
        }
        if (known && known.inst !== msg.i) dropDevice(from, false); // the page was reloaded
        const entry = { id: from, inst: msg.i, role: msg.role, name: String(msg.name || '').slice(0, 20), seen: Date.now(), ring: Boolean(msg.ring) };
        const changed = !known || known.inst !== entry.inst || known.role !== entry.role;
        V.roster.set(from, entry);
        if (entry.role === 'talk' && entry.ring && !V.role && !V.dismissed.has(entry.inst)) startRing(entry);
        else if (V.ring?.id === from && !entry.ring) stopRing();
        if (changed) { reconcile(); update(); }
    }

    /** A device left its session (said so, expired or was replaced). */
    function dropDevice(id, graceful) {
        const entry = V.roster.get(id);
        V.roster.delete(id);
        const peer = V.peers.get(id);
        if (peer) {
            if (V.role === 'parent' && peer.role === 'baby') {
                if (graceful) {
                    FR.showToast(`${nameOf(id)} stopped the baby station`, 'warning', 6000);
                    beep('chime');
                } else if (peer.everConnected) {
                    markLost(peer);
                }
            }
            closePeer(peer);
        }
        if (V.ring?.id === id) stopRing();
        if (entry) update();
    }

    // ======================================================================
    // Peer connections
    // ======================================================================
    async function iceServers(force = false) {
        if (!force && V.ice && Date.now() - V.iceAt < V.iceTtl / 2) return V.ice;
        try {
            const data = await FR.api(`/api/ice?user_id=${encodeURIComponent(FR.user.id)}`);
            V.ice = Array.isArray(data.iceServers) ? data.iceServers : [];
            V.iceAt = Date.now();
            V.iceTtl = (Number(data.ttl) || 3600) * 1000;
            V.pushRelay = data.push_relay !== false;
        } catch (err) {
            log('no ICE configuration', err);
            V.ice = V.ice || [];
        }
        return V.ice;
    }

    function reconcile() {
        const me = FR.user;
        if (!me) return;
        for (const peer of [...V.peers.values()]) {
            const entry = V.roster.get(peer.id);
            if (!V.role || !entry || entry.inst !== peer.inst || !wants(V.role, entry.role)) closePeer(peer);
        }
        if (!V.role) return;
        for (const entry of V.roster.values()) {
            if (!wants(V.role, entry.role) || V.peers.has(entry.id)) continue;
            if (V.peers.size >= MAX_PEERS) {
                note('full', `Only ${MAX_PEERS} direct connections are possible at once.`);
                break;
            }
            const peer = {
                id: entry.id, inst: entry.inst, role: entry.role, offerer: isOfferer(V.role, me.id, entry.id),
                pc: null, dc: null, tx: null, gen: 0, pending: [], audio: null, attempts: 0, timer: null, closed: false,
                everConnected: false, lastData: 0, sas: null, path: null, lastRecover: Date.now(),
                level: -90, floor: -70, threshold: -50, active: false, holdUntil: 0, micOk: true, battery: null, cfg: null,
                remoteMuted: false, talking: false,
                chain: Promise.resolve(),
            };
            peer.run = (fn) => (peer.chain = peer.chain.then(() => (peer.closed ? null : fn())).catch((err) => log('peer task failed', err)));
            V.peers.set(entry.id, peer);
            if (peer.offerer) startOffer(peer, false);
        }
    }

    function outTrack() {
        if (V.role === 'talk') return V.mic?.track || null;
        if (V.role === 'baby') return V.baby?.outTrack || null;
        return V.parent.talking ? V.mic?.track || null : null;
    }

    function teardownPc(peer) {
        clearTimeout(peer.timer);
        const pc = peer.pc;
        peer.pc = null; peer.dc = null; peer.tx = null; peer.pending = [];
        if (pc) {
            pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null;
            try { pc.close(); } catch { /* ignore */ }
        }
    }

    async function buildPc(peer) {
        teardownPc(peer);
        const pc = new RTCPeerConnection({ iceServers: await iceServers(), bundlePolicy: 'max-bundle' });
        if (peer.closed) { pc.close(); return null; }
        peer.pc = pc;
        // Negotiated in advance on both sides: no extra round trip, always the same channel.
        const dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
        peer.dc = dc;
        dc.onopen = () => { if (peer.dc === dc) onChannelOpen(peer); };
        dc.onclose = () => update();
        dc.onmessage = (e) => { if (peer.dc === dc) onChannelMessage(peer, e.data); };
        pc.onicecandidate = (e) => { if (e.candidate && peer.pc === pc) signal(peer.id, 'ice', { g: peer.gen, c: e.candidate.toJSON() }); };
        pc.ontrack = (e) => { if (peer.pc === pc) attachRemote(peer, e.track); };
        pc.onconnectionstatechange = () => { if (peer.pc === pc) onConnectionState(peer); };
        return pc;
    }

    function startOffer(peer, iceRestart) {
        return peer.run(async () => {
            let pc = peer.pc;
            if (!pc || !iceRestart || pc.signalingState !== 'stable') {
                iceRestart = false;
                peer.gen = Date.now();
                pc = await buildPc(peer);
                if (!pc) return;
                peer.tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
                await peer.tx.sender.replaceTrack(outTrack());
            } else {
                try { pc.setConfiguration({ iceServers: await iceServers(true), bundlePolicy: 'max-bundle' }); } catch { /* keep the old servers */ }
            }
            await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
            await signal(peer.id, 'sdp', { g: peer.gen, role: V.role, name: FR.user?.name, d: { type: 'offer', sdp: pc.localDescription.sdp } });
            clearTimeout(peer.timer);
            peer.timer = setTimeout(() => recover(peer), 15000); // nobody answered / no route found
            update();
        });
    }

    function onSdp(peer, msg) {
        const d = msg.d;
        if (!d || typeof d.sdp !== 'string' || d.sdp.length > 20000) return;
        peer.run(async () => {
            if (d.type === 'offer') {
                if (peer.offerer) return;
                let pc = peer.pc;
                if (!pc || peer.gen !== msg.g) {
                    peer.gen = msg.g;
                    pc = await buildPc(peer);
                    if (!pc) return;
                }
                await pc.setRemoteDescription({ type: 'offer', sdp: tuneOpus(d.sdp, V.role) });
                const tx = pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'audio');
                if (tx) {
                    peer.tx = tx;
                    tx.direction = 'sendrecv';
                    await tx.sender.replaceTrack(outTrack());
                }
                await flushIce(peer);
                await pc.setLocalDescription(await pc.createAnswer());
                await signal(peer.id, 'sdp', { g: peer.gen, d: { type: 'answer', sdp: pc.localDescription.sdp } });
            } else if (d.type === 'answer') {
                const pc = peer.pc;
                if (!peer.offerer || !pc || msg.g !== peer.gen || pc.signalingState !== 'have-local-offer') return;
                await pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(d.sdp, V.role) });
                await flushIce(peer);
            } else {
                return;
            }
            limitBitrate(peer);
            updateSafetyCode(peer);
        });
    }

    function onIce(peer, msg) {
        peer.run(async () => {
            if (!peer.pc || msg.g !== peer.gen || !msg.c) return;
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.c).catch(() => {});
            else if (peer.pending.length < 100) peer.pending.push(msg.c);
        });
    }

    async function flushIce(peer) {
        for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
    }

    /**
     * Opus settings for *our* encoder (they are read from the remote description): DTX sends next to
     * nothing during silence - ideal for a baby monitor -, in-band FEC survives Wi-Fi packet loss.
     */
    function tuneOpus(sdp, role) {
        const map = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
        if (!map) return sdp;
        const pt = map[1];
        const call = role === 'talk';
        // A conversation wants every bit of delay removed: no DTX (its comfort-noise gaps make the
        // receiver's jitter buffer grow) and 10 ms frames instead of 20 ms.
        const wanted = { usedtx: call ? 0 : 1, useinbandfec: 1, stereo: 0, maxaveragebitrate: BITRATE[role] || 32000, minptime: 10 };
        const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
        if (!fmtp.test(sdp)) {
            const params = Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';');
            sdp = sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000[^\\r\\n]*)`, 'i'), `$1\r\na=fmtp:${pt} ${params}`);
        } else {
            sdp = sdp.replace(fmtp, (line, params) => {
                const values = new Map(params.split(';').map((s) => s.trim()).filter(Boolean).map((kv) => kv.split('=')));
                for (const [k, v] of Object.entries(wanted)) values.set(k, String(v));
                return `a=fmtp:${pt} ${[...values].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';')}`;
            });
        }
        if (call) sdp = sdp.replace(/a=(?:max)?ptime:\d+\r\n/g, '').replace(fmtp, (line) => `${line}\r\na=ptime:10`);
        return sdp;
    }

    function limitBitrate(peer) {
        try {
            const sender = peer.tx?.sender;
            const params = sender?.getParameters();
            if (!params?.encodings?.length) return;
            params.encodings[0].maxBitrate = (BITRATE[V.role] || 32000) + 8000;
            // Voice goes first: ahead of other traffic of this page and, where the network honours it
            // (Wi-Fi WMM), ahead of other devices' downloads.
            params.encodings[0].priority = 'high';
            params.encodings[0].networkPriority = 'high';
            sender.setParameters(params).catch(() => {});
        } catch { /* optional */ }
    }

    async function updateSafetyCode(peer) {
        const print = (sdp) => sdp?.match(/a=fingerprint:\S+ (\S+)/)?.[1];
        const a = print(peer.pc?.localDescription?.sdp), b = print(peer.pc?.remoteDescription?.sdp);
        if (!a || !b) return;
        peer.sas = await C.safetyCode(a, b);
        update();
    }

    function attachRemote(peer, track) {
        if (!peer.audio) {
            peer.audio = document.createElement('audio');
            peer.audio.autoplay = true;
            peer.audio.playsInline = true;
            peer.audio.className = 'd-none';
            document.body.append(peer.audio);
        }
        peer.audio.srcObject = new MediaStream([track]);
        try {
            // Baby -> parent: a steadier buffer (no drop-outs on weak Wi-Fi) matters more than delay.
            // Calls keep the default: as short as the network allows.
            const receiver = peer.pc.getReceivers().find((r) => r.track === track);
            if (receiver && V.role === 'parent') receiver.jitterBufferTarget = 150;
        } catch { /* optional */ }
        applyGate(peer);
        playAudio(peer);
    }

    function playAudio(peer) {
        peer.audio?.play().then(() => {
            if (V.blocked) { V.blocked = false; clearAlert('blocked'); update(); }
        }).catch((err) => {
            if (err.name !== 'NotAllowedError') return;
            V.blocked = true;
            // After a reload the browser may refuse sound until the page is touched: say so loudly.
            if (V.role === 'parent') raiseAlert('blocked', 'Sound is off – tap here to hear the baby station');
            update();
        });
    }

    /** Parent unit: "alerts only" keeps the speaker closed until the baby station reports sound. */
    function applyGate(peer) {
        if (!peer.audio) return;
        const open = V.role !== 'parent' || peer.role !== 'baby' || V.parent.mode === 'live' || peer.active || Date.now() < peer.holdUntil;
        peer.audio.muted = !open;
    }

    function onConnectionState(peer) {
        const state = peer.pc.connectionState;
        if (state === 'connected') {
            clearTimeout(peer.timer);
            peer.attempts = 0;
            peer.everConnected = true;
            peer.lastData = Date.now();
            if (V.role === 'talk' && V.ringUntil) { V.ringUntil = 0; announce(); } // somebody picked up
            updateSafetyCode(peer);
            probeStats(peer);
        } else if (state === 'failed') {
            clearTimeout(peer.timer);
            peer.timer = setTimeout(() => recover(peer), 300);
        } else if (state === 'disconnected') {
            clearTimeout(peer.timer);
            peer.timer = setTimeout(() => recover(peer), 4000); // short Wi-Fi hiccups heal on their own
        }
        update();
    }

    /** Repair a connection: ICE restart first, a completely new connection if that does not help. */
    function recover(peer, requested = false) {
        if (peer.closed || !V.role) return;
        const state = peer.pc?.connectionState;
        if (state === 'connected') return;
        if (requested && Date.now() - peer.lastRecover < 3000) return;
        peer.lastRecover = Date.now();
        clearTimeout(peer.timer);
        peer.timer = setTimeout(() => recover(peer), Math.min(30000, 8000 + peer.attempts * 4000));
        if (!FR.online) return; // signaling is down: try again when it is back
        peer.attempts++;
        if (peer.offerer) startOffer(peer, peer.attempts <= 2 && Boolean(peer.pc?.remoteDescription));
        else signal(peer.id, 'restart');
    }

    /** Route (direct or relayed), network round trip and current jitter buffer of a connection. */
    async function probeStats(peer) {
        try {
            const pc = peer.pc;
            if (!pc || pc.connectionState !== 'connected') return;
            const stats = await pc.getStats();
            let pair = null, inbound = null;
            stats.forEach((s) => {
                if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
                if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
            });
            if (pair) {
                const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
                peer.path = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relayed' : 'direct';
                if (Number.isFinite(pair.currentRoundTripTime)) peer.rtt = Math.round(pair.currentRoundTripTime * 1000);
            }
            if (inbound && Number.isFinite(inbound.jitterBufferDelay)) {
                const delay = inbound.jitterBufferDelay - (peer.jbDelay || 0), count = inbound.jitterBufferEmittedCount - (peer.jbCount || 0);
                if (count > 0) peer.buffer = Math.round((delay / count) * 1000);
                peer.jbDelay = inbound.jitterBufferDelay;
                peer.jbCount = inbound.jitterBufferEmittedCount;
            }
            update();
        } catch { /* optional */ }
    }

    function closePeer(peer) {
        peer.closed = true;
        teardownPc(peer);
        if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); peer.audio = null; }
        if (V.peers.get(peer.id) === peer) V.peers.delete(peer.id);
        for (const [key, timer] of V.baby?.pending || []) {
            if (key.endsWith(`|${peer.id}`)) { clearTimeout(timer); V.baby.pending.delete(key); }
        }
    }

    function sendTo(peer, message) {
        if (!channelOpen(peer)) return false;
        try { peer.dc.send(JSON.stringify(message)); return true; } catch { return false; }
    }
    const sendAll = (message) => { for (const peer of V.peers.values()) sendTo(peer, message); };

    // ----- Data channel (already encrypted and authenticated end to end by DTLS) -------------
    function onChannelOpen(peer) {
        peer.lastData = Date.now();
        if (V.role === 'talk') sendTo(peer, { t: 'mute', on: V.muted });
        if (V.role === 'baby') { sendTo(peer, { t: 'cfg', ...V.baby.cfg }); sendLevels(peer); }
        if (V.role === 'parent') sendTo(peer, { t: 'push', ...(V.parent.push || { sub: null }) });
        update();
    }

    function onChannelMessage(peer, raw) {
        if (typeof raw !== 'string' || raw.length > 8192) return;
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m.t !== 'string') return;
        peer.lastData = Date.now();
        if (V.role === 'talk' && m.t === 'mute') {
            peer.remoteMuted = Boolean(m.on);
            update();
        } else if (V.role === 'parent' && peer.role === 'baby') {
            onBabyMessage(peer, m);
        } else if (V.role === 'baby' && peer.role === 'parent') {
            onParentMessage(peer, m);
        }
    }

    // ======================================================================
    // Microphone (calls and talk-back)
    // ======================================================================
    function micError(err) {
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return 'Microphone access was denied. Allow the microphone for this site and try again.';
        if (err?.name === 'NotFoundError') return 'No microphone found on this device.';
        if (err?.name === 'NotReadableError') return 'The microphone is in use by another app.';
        return `Could not start: ${err?.message || err}`;
    }

    /** Which audio routes does this phone offer? (Labels are only visible once the microphone was allowed.) */
    async function scanRoutes() {
        const routes = {};
        try {
            const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.label);
            for (const route of ROUTES) {
                const device = inputs.find((d) => route.match.test(d.label));
                if (device) routes[route.kind] = device.deviceId;
            }
        } catch { /* no device list: the browser's default route is used */ }
        V.routes = routes;
        return routes;
    }

    /** Like a phone: a connected headset first, otherwise the earpiece - unless the user chose the speaker. */
    function preferredRoute() {
        const wish = FR.storage.get('fileroom_call_route');
        if (V.routes.bluetooth) return 'bluetooth';
        if (V.routes.wired) return 'wired';
        if (wish === 'speaker' && V.routes.speaker) return 'speaker';
        return V.routes.earpiece ? 'earpiece' : V.routes.speaker ? 'speaker' : null;
    }

    async function openMic(route = null) {
        if (V.mic?.track.readyState === 'live' && V.mic.route === route) return V.mic;
        const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
        // A phone has one call route at a time: release the microphone that is open before taking another.
        V.mic?.stream.getTracks().forEach((t) => t.stop());
        V.mic = null;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: route && V.routes[route] ? { ...audio, deviceId: { exact: V.routes[route] } } : audio, video: false,
            });
        } catch (err) {
            if (!route || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(err?.name)) throw err;
            route = null; // that route just went away (headset unplugged): take whatever the phone offers
            stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        }
        const track = stream.getAudioTracks()[0];
        V.mic = { stream, track, route };
        track.addEventListener('ended', () => {
            if (V.mic?.track !== track) return;
            V.mic = null;
            if (V.role === 'talk') { FR.showToast('The microphone was stopped by the system. Trying to reopen it…', 'warning'); reopenMic(); }
        });
        return V.mic;
    }

    /** Call: move the audio to another route (earpiece, speaker, headset). */
    async function setRoute(kind, remember = false) {
        if (V.role !== 'talk' || V.routeBusy || !V.routes[kind] || kind === V.route) return;
        V.routeBusy = true;
        try {
            // Only one route can be open at a time: close the current microphone first.
            V.mic?.stream.getTracks().forEach((t) => t.stop());
            V.mic = null;
            await openMic(kind);
            V.route = V.mic.route;
            V.mic.track.enabled = !V.muted;
            for (const peer of V.peers.values()) await peer.tx?.sender.replaceTrack(outTrack()).catch(() => {});
            if (remember && (kind === 'speaker' || kind === 'earpiece')) FR.storage.set('fileroom_call_route', kind);
        } catch (err) {
            FR.showToast(micError(err), 'danger', 6000);
            if (V.role === 'talk') await reopenMic();
        } finally {
            V.routeBusy = false;
            update();
        }
    }

    /** A headset was connected or removed during a call. */
    async function onDeviceChange() {
        if (!V.role) return;
        const before = V.routes;
        await scanRoutes();
        if (V.role !== 'talk') return;
        const headset = ['bluetooth', 'wired'].find((kind) => V.routes[kind] && !before[kind]);
        if (headset) await setRoute(headset);
        else if (V.route && !V.routes[V.route]) { V.route = null; await setRoute(preferredRoute()); }
        update();
    }

    async function reopenMic() {
        try {
            await openMic(V.role === 'talk' ? V.route : V.role === 'parent' && V.routes.speaker ? 'speaker' : null);
            V.mic.track.enabled = !V.muted;
            for (const peer of V.peers.values()) await peer.tx?.sender.replaceTrack(outTrack()).catch(() => {});
        } catch (err) {
            FR.showToast(micError(err), 'danger', 7000);
        }
    }

    function closeMic() {
        clearTimeout(V.parent.micTimer);
        V.mic?.stream.getTracks().forEach((t) => t.stop());
        V.mic = null;
    }

    // ======================================================================
    // Baby station
    // ======================================================================
    function loadBabyStore() {
        const stored = FR.storage.get(BABY_KEY(), {}) || {};
        const global = FR.storage.get('fileroom_baby_cfg', {}) || {};
        return {
            cfg: { sens: clamp(Number(global.sens) || 3, 1, 5), gain: clamp(Number(global.gain) || 4, 1, 8) },
            // Push registrations of parent units survive a reload of the baby station (24 h).
            targets: new Map((Array.isArray(stored.targets) ? stored.targets : []).filter(([, t]) => Date.now() - (t.at || 0) < 24 * 3600000)),
        };
    }
    function saveBabyStore() {
        const B = V.baby;
        if (!B) return;
        FR.storage.set('fileroom_baby_cfg', B.cfg);
        FR.storage.set(BABY_KEY(), { targets: [...B.targets].map(([id, t]) => [id, { sub: t.sub, vapid: t.vapid, name: t.name, at: t.at }]) });
    }

    async function startBabyAudio() {
        const B = V.baby;
        // No noise suppression / gain control: they would hide exactly the quiet sounds we want to hear
        // and make level measurements meaningless. Echo cancellation keeps talk-back out of the detector.
        const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
        // Always the phone's own microphone and loudspeaker - never a Bluetooth headset or earbuds
        // that happen to be connected to this phone and lie in another room.
        await scanRoutes();
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: V.routes.speaker ? { ...audio, deviceId: { exact: V.routes.speaker } } : audio, video: false });
        } catch (err) {
            if (!V.routes.speaker || err?.name === 'NotAllowedError' || err?.name === 'SecurityError') throw err;
            stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        }
        const ctx = new AudioContext({ latencyHint: 'playback' });
        await ctx.audioWorklet.addModule(`/static/js/level-worklet.js?v=${build}`);
        const source = ctx.createMediaStreamSource(stream);
        const meter = new AudioWorkletNode(ctx, 'fileroom-level', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
        meter.port.onmessage = (e) => onLevel(e.data.db, e.data.peak);
        source.connect(meter);
        // What the parents hear: delayed (pre-roll), amplified and limited, so whimpering is audible
        // and screaming does not distort.
        const delay = ctx.createDelay(1);
        delay.delayTime.value = PREROLL;
        const gain = ctx.createGain();
        gain.gain.value = B.cfg.gain;
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -18; limiter.knee.value = 12; limiter.ratio.value = 12;
        limiter.attack.value = 0.003; limiter.release.value = 0.25;
        const out = ctx.createMediaStreamDestination();
        source.connect(delay).connect(gain).connect(limiter).connect(out);
        ctx.onstatechange = () => { if (V.baby?.ctx === ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };
        const track = stream.getAudioTracks()[0];
        track.addEventListener('ended', () => { if (V.baby?.stream === stream) restartBabyAudio('the microphone was stopped'); });
        // Android mutes the track while another app (a phone call, a voice assistant) holds the microphone.
        // Audio frames keep coming then - as pure silence - so this is the only sign that nobody is listening.
        track.addEventListener('mute', () => { if (V.baby?.stream === stream) { B.mutedSince = Date.now(); log('microphone muted by the system'); } });
        track.addEventListener('unmute', () => { if (V.baby?.stream === stream) B.mutedSince = 0; });
        B.mutedSince = track.muted ? Date.now() : 0;
        B.zeroFrames = 0;
        // Without a tap (session resumed after a reload) Chrome may keep the context suspended until
        // the user touches the page - never wait for that here.
        await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
        Object.assign(B, { stream, ctx, gain, outTrack: out.stream.getAudioTracks()[0], lastFrame: Date.now(), micOk: true });
    }

    function stopBabyAudio() {
        const B = V.baby;
        if (!B) return;
        B.stream?.getTracks().forEach((t) => t.stop());
        B.outTrack?.stop();
        if (B.ctx) { B.ctx.onstatechange = null; B.ctx.close().catch(() => {}); }
        B.stream = B.ctx = B.gain = B.outTrack = null;
    }

    async function restartBabyAudio(reason) {
        const B = V.baby;
        if (!B || B.restarting || Date.now() - (B.lastRestart || 0) < 10000) return; // not in a tight loop
        B.restarting = true;
        B.lastRestart = Date.now();
        log('restarting baby audio:', reason);
        try {
            stopBabyAudio();
            await startBabyAudio();
            for (const peer of V.peers.values()) await peer.tx?.sender.replaceTrack(B.outTrack).catch(() => {});
        } catch (err) {
            B.micOk = false;
            FR.showToast(`Baby station: ${micError(err)}`, 'danger', 8000);
        } finally {
            B.restarting = false;
            update();
        }
    }

    function newDetector() {
        return { smooth: null, bucketMin: 0, frames: 0, buckets: [], floor: -70, threshold: -50, score: 0, active: false, lastLoud: 0, lastAlarm: -1e9, db: -90 };
    }

    /**
     * Called ten times per second from the audio thread.
     * Noise floor = the quietest moment of the last 30 s. A steady noise (fan, white noise, rain)
     * lifts the floor and stops triggering; crying never does, because it has pauses.
     */
    function onLevel(db, peak) {
        const B = V.baby;
        if (!B) return;
        const d = B.det, now = performance.now();
        B.lastFrame = Date.now();
        // Frames arrive, but is it the microphone? Not while the system has muted it for more than 5 s.
        const ok = !B.mutedSince || Date.now() - B.mutedSince < 5000;
        if (ok !== B.micOk) { B.micOk = ok; if (ok) V.blocked = false; sendLevels(); update(); }
        // A working microphone never delivers a full minute of exact digital silence: reopen it quietly.
        B.zeroFrames = peak === 0 ? (B.zeroFrames || 0) + 1 : 0;
        if (B.zeroFrames === 600 && Date.now() - (B.lastZeroRestart || 0) > 10 * 60000) {
            B.lastZeroRestart = Date.now();
            restartBabyAudio('only digital silence');
        }
        const suppressed = now < B.suppressUntil; // a parent is talking through the speaker
        if (!suppressed) {
            d.smooth = d.smooth === null ? db : d.smooth * 0.65 + db * 0.35;
            if (d.frames === 0 || d.smooth < d.bucketMin) d.bucketMin = d.smooth;
            if (++d.frames >= 30) {
                d.buckets.push(d.bucketMin);
                if (d.buckets.length > 10) d.buckets.shift();
                d.frames = 0;
            }
            d.floor = clamp(Math.min(d.bucketMin, ...d.buckets), -85, -25);
        }
        const s = SENSITIVITY[B.cfg.sens];
        d.threshold = Math.max(s.min, d.floor + s.margin);
        d.db = db;
        const loud = !suppressed && db >= d.threshold;
        d.score = loud ? Math.min(1000, d.score + 100) : Math.max(0, d.score - 50);
        if (loud) d.lastLoud = now;
        const was = d.active;
        if (!d.active && d.score >= 400) d.active = true;             // ~0.4 s of sound, not a single click
        else if (d.active && now - d.lastLoud > HOLD_MS) { d.active = false; d.score = 0; }
        if (d.active && (!was || (now - d.lastAlarm > 60000 && now - d.lastLoud < 1000))) babyAlarm('noise');
        if (d.active !== was || now - B.lastSent >= 500) sendLevels();
        if (d.active !== was) update();
        drawMeter('self', d.db, d.threshold, d.active);
    }

    function sendLevels(only = null) {
        const B = V.baby;
        if (!B) return;
        const d = B.det;
        const message = {
            t: 'lv', db: Math.round(d.db * 10) / 10, fl: Math.round(d.floor), th: Math.round(d.threshold),
            a: d.active ? 1 : 0, ok: B.micOk ? 1 : 0, b: B.battery,
        };
        B.lastSent = performance.now();
        if (only) sendTo(only, message); else sendAll(message);
    }

    function babyAlarm(kind) {
        const B = V.baby;
        const now = performance.now();
        if (kind === 'noise') {
            if (now - B.det.lastAlarm < ALARM_COOLDOWN) return;
            B.det.lastAlarm = now;
        }
        const id = randomId();
        const reached = new Set();
        for (const peer of V.peers.values()) {
            if (!sendTo(peer, { t: 'alarm', id, k: kind, db: Math.round(B.det.db) })) continue;
            reached.add(peer.id);
            // No acknowledgement = the parent's browser is not really awake: use push.
            B.pending.set(`${id}|${peer.id}`, setTimeout(() => { B.pending.delete(`${id}|${peer.id}`); pushTo(peer.id, kind); }, ACK_TIMEOUT));
        }
        for (const id_ of B.targets.keys()) if (!reached.has(id_)) pushTo(id_, kind);
    }

    async function pushTo(userId, kind) {
        const B = V.baby;
        const target = B?.targets.get(userId);
        if (!target || !V.pushRelay || !FR.user) return;
        const last = target.sent?.[kind] || 0;
        if (Date.now() - last < 30000) return;
        target.sent = { ...target.sent, [kind]: Date.now() };
        try {
            const request = await C.pushRequest(target.sub, target.vapid,
                { t: 'baby', k: kind, room: FR.roomCode, name: FR.user.name, at: Date.now() },
                { subject: location.protocol === 'https:' ? location.origin : 'mailto:fileroom@localhost.invalid', ttl: kind === 'noise' ? 120 : 600, topic: `fr-${kind}` });
            const result = await FR.api('/api/push', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: FR.user.id, ...request }),
            });
            if (result.status === 404 || result.status === 410) { B.targets.delete(userId); saveBabyStore(); } // subscription is gone
            log('push', kind, result.status);
        } catch (err) {
            log('push failed', err);
        }
    }

    function onParentMessage(peer, m) {
        const B = V.baby;
        switch (m.t) {
            case 'ack': {
                const key = `${m.id}|${peer.id}`;
                clearTimeout(B.pending.get(key));
                B.pending.delete(key);
                break;
            }
            case 'set':
                if (Number.isFinite(m.sens)) B.cfg.sens = clamp(Math.round(m.sens), 1, 5);
                if (Number.isFinite(m.gain)) { B.cfg.gain = clamp(Number(m.gain), 1, 8); if (B.gain) B.gain.gain.value = B.cfg.gain; }
                saveBabyStore();
                sendAll({ t: 'cfg', ...B.cfg });
                update();
                break;
            case 'talk':
                peer.talking = Boolean(m.on);
                // Do not let the parent's own voice from the speaker trigger an alert.
                B.suppressUntil = peer.talking ? Infinity : performance.now() + 1500;
                update();
                break;
            case 'push':
                if (m.sub && typeof m.sub.endpoint === 'string' && m.sub.keys?.p256dh && m.sub.keys?.auth && m.vapid?.publicKey && m.vapid?.privateJwk?.d) {
                    B.targets.set(peer.id, { sub: m.sub, vapid: m.vapid, name: nameOf(peer.id), at: Date.now(), gone: 0, lostSent: false });
                } else {
                    B.targets.delete(peer.id);
                }
                saveBabyStore();
                update();
                break;
            case 'bye': // the parent unit was switched off on purpose: no "connection lost" push
                B.targets.delete(peer.id);
                saveBabyStore();
                break;
        }
    }

    function babyWatchdog() {
        const B = V.baby;
        if (!B) return;
        const silent = Date.now() - B.lastFrame;
        if (B.mutedSince && Date.now() - B.mutedSince > 60000) restartBabyAudio('muted by the system for a minute');
        if (silent > 3000 && !B.restarting) {
            B.micOk = false;
            sendLevels(); // tells the parents that the microphone is not delivering
            if (B.ctx && B.ctx.state !== 'running') {
                B.ctx.resume().catch(() => {});
                V.blocked = true; // needs a tap (autoplay policy) - shown in the status line
            } else if (silent > 10000) {
                restartBabyAudio('no audio frames');
            }
            update();
        }
        // A registered parent unit that disappeared without saying bye gets one push.
        for (const [id, target] of B.targets) {
            if (channelOpen(V.peers.get(id))) { target.gone = 0; target.lostSent = false; continue; }
            if (!target.gone) target.gone = Date.now();
            else if (!target.lostSent && Date.now() - target.gone > GONE_AFTER) { target.lostSent = true; pushTo(id, 'lost'); }
        }
        if (B.battery && B.battery[0] <= 15 && !B.battery[1] && !B.batteryWarned) { B.batteryWarned = true; babyAlarm('battery'); }
        if (B.battery && (B.battery[1] || B.battery[0] > 20)) B.batteryWarned = false;
    }

    async function watchBattery() {
        try {
            const battery = await navigator.getBattery?.();
            if (!battery) return;
            const read = () => { if (V.baby) { V.baby.battery = [Math.round(battery.level * 100), battery.charging ? 1 : 0]; update(); } };
            battery.addEventListener('levelchange', read);
            battery.addEventListener('chargingchange', read);
            read();
        } catch { /* not available */ }
    }

    // ======================================================================
    // Parent unit
    // ======================================================================
    function onBabyMessage(peer, m) {
        switch (m.t) {
            case 'lv': {
                const wasActive = peer.active;
                peer.level = Number(m.db) || -90;
                peer.floor = Number(m.fl) || -70;
                peer.threshold = Number(m.th) || -50;
                peer.active = Boolean(m.a);
                peer.battery = Array.isArray(m.b) ? m.b : null;
                const ok = m.ok !== 0;
                if (ok !== peer.micOk) {
                    peer.micOk = ok;
                    if (!ok) raiseAlert('mic', `${nameOf(peer.id)}: the microphone stopped delivering sound`);
                    else clearAlert('mic');
                    update();
                }
                if (peer.active) peer.holdUntil = Date.now() + 1500; // keep the speaker open over the pre-roll delay
                if (V.parent.lost.delete(peer.id)) { clearAlert('lost'); update(); }
                if (wasActive !== peer.active) { applyGate(peer); update(); }
                else if (!peer.active) applyGate(peer);
                drawMeter(peer.id, peer.level, peer.threshold, peer.active);
                break;
            }
            case 'alarm':
                sendTo(peer, { t: 'ack', id: m.id });
                if (m.k === 'battery') {
                    raiseAlert('battery', `${nameOf(peer.id)}: battery low – connect the charger`);
                } else {
                    peer.alarmAt = Date.now();
                    if (V.parent.mode === 'alerts') { beep('chime'); navigator.vibrate?.([200, 100, 200]); }
                    showNotification('baby', `${nameOf(peer.id)}: sound detected`, `Babyphone in room ${FR.roomCode}`);
                    update();
                }
                break;
            case 'cfg':
                peer.cfg = { sens: clamp(Number(m.sens) || 3, 1, 5), gain: clamp(Number(m.gain) || 4, 1, 8) };
                update();
                break;
        }
    }

    function markLost(peer) {
        if (V.parent.lost.has(peer.id)) return;
        V.parent.lost.set(peer.id, { name: nameOf(peer.id), since: Date.now() });
        raiseAlert('lost', `Connection to ${nameOf(peer.id)} lost`, true);
    }

    function parentWatchdog() {
        for (const peer of V.peers.values()) {
            if (peer.role !== 'baby' || !peer.everConnected) continue;
            if (Date.now() - peer.lastData > LOST_AFTER) markLost(peer);
            else if (Date.now() >= peer.holdUntil) applyGate(peer);
        }
    }

    /** Push subscription of this phone. The baby station gets it (and the signing key) over the encrypted channel. */
    async function setupPush() {
        try {
            if (!('PushManager' in window) || !navigator.serviceWorker || Notification.permission !== 'granted') return null;
            const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
            if (!registration?.pushManager) return null;
            let vapid = FR.storage.get('fileroom_vapid');
            let subscription = await registration.pushManager.getSubscription();
            const current = subscription?.options?.applicationServerKey ? C.b64(subscription.options.applicationServerKey) : null;
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

    async function setTalking(on) {
        if (V.role !== 'parent' || V.parent.talking === on) return;
        if (on) {
            V.parent.wantTalk = true;
            try {
                if (!Object.keys(V.routes).length) await scanRoutes();
                // Opening a microphone switches Android to call mode: stay on the loudspeaker, the baby must stay audible.
                await openMic(V.routes.speaker ? 'speaker' : null);
                if (!Object.keys(V.routes).length) await scanRoutes(); // labels appear with the first permission
            } catch (err) { FR.showToast(micError(err), 'danger', 6000); return; }
            if (!V.parent.wantTalk || V.role !== 'parent') return; // released while the permission prompt was open
            clearTimeout(V.parent.micTimer);
        } else {
            V.parent.wantTalk = false;
            if (!V.parent.talking) return;
            // Release the microphone (and Android's "recording" indicator) when talk-back is not used.
            clearTimeout(V.parent.micTimer);
            V.parent.micTimer = setTimeout(() => { if (!V.parent.talking && V.role === 'parent') closeMic(); }, 20000);
        }
        V.parent.talking = on;
        for (const peer of V.peers.values()) {
            if (peer.role !== 'baby') continue;
            peer.tx?.sender.replaceTrack(outTrack()).catch(() => {});
            sendTo(peer, { t: 'talk', on });
        }
        $('vbTalk')?.classList.toggle('active', on);
    }

    // ======================================================================
    // Sounds, alerts, notifications, screen
    // ======================================================================
    function alertContext() {
        try {
            if (!V.alertCtx || V.alertCtx.state === 'closed') V.alertCtx = new AudioContext();
            if (V.alertCtx.state !== 'running') V.alertCtx.resume().catch(() => {});
        } catch { /* no audio */ }
        return V.alertCtx;
    }

    const TONES = {
        chime: [[880, 0, 0.16], [1175, 0.2, 0.22]],
        alarm: [[740, 0, 0.25], [520, 0.3, 0.25], [740, 0.6, 0.25], [520, 0.9, 0.35]],
        ring: [[440, 0, 0.4], [480, 0, 0.4], [440, 0.6, 0.4], [480, 0.6, 0.4]],
    };
    function beep(kind) {
        const ctx = alertContext();
        if (!ctx || ctx.state !== 'running') return;
        const start = ctx.currentTime + 0.02;
        for (const [freq, at, length] of TONES[kind]) {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, start + at);
            gain.gain.exponentialRampToValueAtTime(kind === 'alarm' ? 0.5 : 0.25, start + at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start + at);
            osc.stop(start + at + length + 0.02);
        }
    }

    async function showNotification(tag, title, body) {
        if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
        const options = {
            body, tag: `fileroom-${tag}`, renotify: true, requireInteraction: true, vibrate: [300, 120, 300, 120, 500],
            icon: '/static/icons/icon-192x192.png', badge: '/static/icons/icon-96x96.png',
            data: { url: location.pathname },
        };
        try {
            const registration = await navigator.serviceWorker?.getRegistration();
            if (registration) return void await registration.showNotification(title, options);
        } catch { /* fall through */ }
        try { new Notification(title, options); } catch { /* not allowed outside a service worker on Android */ }
    }

    async function clearNotifications() {
        try {
            const registration = await navigator.serviceWorker?.getRegistration();
            for (const n of await registration?.getNotifications() || []) if (n.tag?.startsWith('fileroom-')) n.close();
        } catch { /* ignore */ }
    }

    /** A banner in the voice bar; `repeat` keeps sounding until it is acknowledged or resolved. */
    function alertSound(repeat) {
        beep(repeat ? 'alarm' : 'chime');
        navigator.vibrate?.(repeat ? [400, 150, 400, 150, 400] : [200, 100, 200]);
    }
    function syncAlerts() {
        // Several problems can exist at once (connection lost *and* battery low): none may hide or
        // silence another. The banner shows the most serious one.
        V.alert = [...V.alerts.values()].sort((a, b) => (ALERT_RANK[b.kind] || 0) - (ALERT_RANK[a.kind] || 0))[0] || null;
        const repeat = [...V.alerts.values()].some((a) => a.repeat);
        if (repeat && !V.alertTimer) V.alertTimer = setInterval(() => alertSound(true), 5000);
        else if (!repeat && V.alertTimer) { clearInterval(V.alertTimer); V.alertTimer = null; }
        update();
    }
    function raiseAlert(kind, text, repeat = false) {
        const known = V.alerts.get(kind);
        V.alerts.set(kind, { kind, text, repeat });
        if (!known || known.text !== text) {
            alertSound(repeat);
            showNotification(kind, text, `FileRoom babyphone · room ${FR.roomCode}`);
        }
        syncAlerts();
    }
    function clearAlert(kind = null) {
        if (kind ? !V.alerts.delete(kind) : !V.alerts.size) return;
        if (!kind) V.alerts.clear();
        syncAlerts();
    }

    /**
     * Parent unit: keep the page alive while the phone is locked. Without a microphone the browser has
     * no reason to stay awake; a playing media element is one. The loop is a 30 Hz tone 50 dB below
     * full scale - no phone speaker can reproduce it, but it is not "silence" to the browser.
     */
    function humWav() {
        const rate = 8000, seconds = 10, n = rate * seconds;
        const view = new DataView(new ArrayBuffer(44 + n * 2));
        const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
        text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        text(36, 'data'); view.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(104 * Math.sin((2 * Math.PI * 30 * i) / rate)), true);
        return new Blob([view], { type: 'audio/wav' });
    }

    function keepAlive(on) {
        const session = navigator.mediaSession;
        if (!on) {
            const audio = V.keep;
            V.keep = null;
            if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
            try { if (session) { session.metadata = null; session.playbackState = 'none'; } } catch { /* ignore */ }
            return;
        }
        if (!V.keep) {
            const audio = new Audio(URL.createObjectURL(humWav()));
            audio.loop = true;
            audio.addEventListener('pause', () => {
                // Paused from the notification or by another app that plays sound. Start again - but do not
                // fight: if it is paused again right away, wait until the user comes back to this page.
                if (V.keep !== audio || V.role !== 'parent') return;
                const again = Date.now() - (audio.pausedAt || 0) < 15000;
                audio.pausedAt = Date.now();
                if (!again) setTimeout(() => { if (V.keep === audio) audio.play().catch(() => {}); }, 1500);
                update();
            });
            audio.addEventListener('playing', () => update());
            V.keep = audio;
            try {
                session.metadata = new MediaMetadata({
                    title: 'Babyphone – parent unit', artist: `FileRoom · room ${FR.roomCode}`,
                    artwork: [{ src: '/static/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
                });
                // The buttons of the playback notification must not switch the babyphone off by accident.
                for (const action of ['play', 'pause', 'stop']) session.setActionHandler(action, () => { V.keep?.play().catch(() => {}); });
            } catch { /* no media session */ }
        }
        V.keep.play().catch(() => {}); // needs a tap once; resumeAudio() tries again
    }

    async function setWakeLock(on) {
        V.wantWake = on;
        try {
            if (on && !V.wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
                const lock = await navigator.wakeLock.request('screen');
                V.wakeLock = lock;
                lock.addEventListener('release', () => { if (V.wakeLock === lock) V.wakeLock = null; });
                if (!V.wantWake) lock.release().catch(() => {});
            } else if (!on && V.wakeLock) {
                const lock = V.wakeLock;
                V.wakeLock = null;
                await lock.release();
            }
        } catch { /* e.g. battery saver */ }
    }

    /** Night screen: black, so the display can stay on (most reliable on Android) without lighting the room. */
    function setNight(on) {
        const overlay = $('nightOverlay');
        if (!overlay) return;
        overlay.classList.toggle('d-none', !on);
        V.night.last = Date.now();
        if (on) {
            $('nightText').textContent = V.role === 'baby' ? 'Baby station is listening' : V.role === 'parent' ? 'Parent unit is listening' : 'Call active';
            // Move the dim text a little each time so nothing burns into an OLED screen.
            $('nightInner').style.transform = `translate(${Math.round(Math.random() * 40 - 20)}vw, ${Math.round(Math.random() * 50 - 25)}vh)`;
            setWakeLock(true);
        } else if (V.role !== 'baby') {
            setWakeLock(false);
        }
    }

    function resumeAudio() {
        if (V.alertCtx && V.alertCtx.state === 'suspended') V.alertCtx.resume().catch(() => {});
        if (V.baby?.ctx && V.baby.ctx.state === 'suspended') V.baby.ctx.resume().catch(() => {});
        if (V.blocked) for (const peer of V.peers.values()) playAudio(peer);
        if (V.keep?.paused && V.role === 'parent') V.keep.play().catch(() => {});
    }

    // ======================================================================
    // Incoming call
    // ======================================================================
    function startRing(entry) {
        if (V.ring) return;
        const ringOnce = () => { beep('ring'); navigator.vibrate?.([400, 200, 400]); };
        V.ring = { id: entry.id, inst: entry.inst, sound: setInterval(ringOnce, 3000), timer: setTimeout(stopRing, 40000) };
        ringOnce();
        showNotification('call', `${nameOf(entry.id)} is calling`, `Voice call in room ${FR.roomCode}`);
        update();
    }
    function stopRing() {
        if (!V.ring) return;
        clearInterval(V.ring.sound);
        clearTimeout(V.ring.timer);
        V.dismissed.add(V.ring.inst);
        V.ring = null;
        clearNotifications();
        update();
    }

    // ======================================================================
    // Starting and stopping a role
    // ======================================================================
    async function acquireLock() {
        if (!navigator.locks) return true;
        // One voice session per browser: two tabs must not both answer or both use the microphone.
        return new Promise((resolve) => {
            navigator.locks.request('fileroom-voice', { ifAvailable: true }, (lock) => {
                if (!lock) { resolve(false); return null; }
                resolve(true);
                return new Promise((release) => { V.releaseLock = release; });
            }).catch(() => resolve(true));
        });
    }

    async function start(role, { resume = false } = {}) {
        if (!SUPPORTED) {
            FR.showToast('Calls need HTTPS (or localhost) and a browser with WebRTC and microphone access.', 'danger', 7000);
            return;
        }
        if (V.starting) return;
        if (V.role === role) return;
        V.starting = true;
        try {
            if (V.role) await stop();
            await FR.ensureJoined();
            if (!(await acquireLock())) {
                FR.showToast('A call or babyphone session is already running in another tab of this browser.', 'warning', 6000);
                return;
            }
            if (!resume) alertContext(); // created inside the tap, so alarms may sound later
            if (role === 'parent') keepAlive(true); // also inside the tap
            try {
                if (role === 'talk') {
                    // Routes are only named once the microphone was allowed: look, open, look again.
                    await scanRoutes();
                    await openMic(preferredRoute());
                    if (!Object.keys(V.routes).length && Object.keys(await scanRoutes()).length && preferredRoute()) {
                        await openMic(preferredRoute());
                    }
                    V.route = V.mic.route;
                    V.muted = false;
                } else if (role === 'baby') {
                    V.baby = { ...loadBabyStore(), det: newDetector(), pending: new Map(), suppressUntil: 0, lastSent: 0, battery: null, micOk: true };
                    await startBabyAudio();
                    watchBattery();
                } else {
                    V.parent.mode = FR.storage.get('fileroom_parent_mode') === 'live' ? 'live' : 'alerts';
                    V.parent.lost.clear();
                    // Ask inside the tap: alerts must get through when the phone is locked or the app suspended.
                    if (!resume && 'Notification' in window && Notification.permission === 'default') {
                        try { await Notification.requestPermission(); } catch { /* ignore */ }
                    }
                    V.parent.push = await setupPush();
                }
            } catch (err) {
                stopBabyAudio();
                V.baby = null;
                keepAlive(false);
                V.releaseLock?.(); V.releaseLock = null;
                if (!resume) FR.showToast(micError(err), 'danger', 7000);
                return;
            }
            V.role = role;
            V.since = Date.now();
            V.ringUntil = role === 'talk' && !others('talk').length ? Date.now() + 30000 : 0;
            if (V.ring) stopRing();
            V.night.auto = role === 'baby';
            V.night.last = Date.now();
            if (role === 'baby') setWakeLock(true);
            FR.storage.set(SESSION_KEY(), { role, at: Date.now() });
            V.lastTick = V.lastAnnounce = Date.now();
            startTicker();
            buildBar();
            $('voiceModal')?.classList.remove('show');
            await announce();
            signal(null, 'hello');
            reconcile();
            update();
            if (role === 'parent' && !V.parent.push) {
                FR.showToast(window.Notification?.permission === 'granted'
                    ? 'Background alerts need the installed app (service worker). Alerts work while FileRoom stays open.'
                    : 'Notifications are off: alerts only reach you while FileRoom stays open on this phone.', 'warning', 8000);
            }
            if (resume) FR.showToast(`${ROLE_LABEL[role]} resumed`, 'info', 3000);
        } finally {
            V.starting = false;
        }
    }

    async function stop() {
        const role = V.role;
        if (!role) return;
        if (role === 'parent') { await setTalking(false); sendAll({ t: 'bye' }); }
        V.role = null;
        stopTicker();
        keepAlive(false);
        V.route = null;
        try { localStorage.removeItem(SESSION_KEY()); } catch { /* ignore */ }
        await signal(null, 'state', { role: null }).catch(() => {});
        // Give the data channel a moment to deliver "bye" before the connections are closed.
        if (role === 'parent') await new Promise((r) => setTimeout(r, 150));
        for (const peer of [...V.peers.values()]) closePeer(peer);
        closeMic();
        if (role === 'baby') {
            for (const timer of V.baby.pending.values()) clearTimeout(timer);
            stopBabyAudio();
            try { localStorage.removeItem(BABY_KEY()); } catch { /* ignore */ }
            V.baby = null;
        }
        V.parent.talking = false;
        V.parent.lost.clear();
        V.muted = false;
        V.ringUntil = 0;
        clearAlert();
        setNight(false);
        setWakeLock(false);
        V.releaseLock?.();
        V.releaseLock = null;
        buildBar();
        update();
    }

    /**
     * The 2 s heartbeat of a session comes from a worker: timers of a page in the background are
     * slowed down to once a minute by the browser, a worker's are not.
     */
    function startTicker() {
        stopTicker();
        try {
            const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 2000);'], { type: 'text/javascript' }));
            const worker = new Worker(url);
            worker.onmessage = () => { if (V.ticker === worker) tick(); };
            worker.onerror = () => { if (V.ticker === worker) { worker.terminate(); V.ticker = setInterval(tick, 2000); } };
            URL.revokeObjectURL(url);
            V.ticker = worker;
        } catch {
            V.ticker = setInterval(tick, 2000);
        }
    }
    function stopTicker() {
        if (V.ticker?.terminate) V.ticker.terminate(); else clearInterval(V.ticker);
        V.ticker = null;
    }

    /** Every 2 s while a session is active. */
    function tick() {
        const now = Date.now();
        if (!V.role) return;
        const gap = now - V.lastTick;
        V.lastTick = now;
        if (gap > 8000) {
            // The phone slept or the browser froze this page. Nobody talked to us meanwhile, which does
            // not mean anybody is gone: give everything a fresh start instead of raising false alarms,
            // and check the connections right away.
            log('suspended for', Math.round(gap / 1000), 's');
            for (const entry of V.roster.values()) entry.seen = now;
            for (const peer of V.peers.values()) { peer.lastData = now; if (peer.pc?.connectionState !== 'connected') recover(peer); }
            if (V.baby) V.baby.lastFrame = now;
            V.lastAnnounce = 0;
            resumeAudio();
        }
        if (now - V.lastAnnounce >= ANNOUNCE_MS) {
            V.lastAnnounce = now;
            announce();
            FR.storage.set(SESSION_KEY(), { role: V.role, at: now });
        }
        if (document.visibilityState === 'visible') for (const peer of V.peers.values()) probeStats(peer);
        for (const entry of [...V.roster.values()]) {
            // A live peer-to-peer connection outlives missing announcements (e.g. while signaling reconnects).
            if (now - entry.seen > ROSTER_TTL && V.peers.get(entry.id)?.pc?.connectionState !== 'connected') dropDevice(entry.id, false);
        }
        if (V.role === 'baby') babyWatchdog();
        if (V.role === 'parent') parentWatchdog();
        if (V.night.auto && now - V.night.last > 45000 && $('nightOverlay')?.classList.contains('d-none')) setNight(true);
        updateStatus();
    }

    // ======================================================================
    // User interface
    // ======================================================================
    const meterPos = (db) => clamp(((db + 80) / 70) * 100, 0, 100);
    function drawMeter(id, db, threshold, active) {
        if (document.visibilityState !== 'visible') return;
        for (const meter of document.querySelectorAll(`[data-meter="${CSS.escape(id)}"]`)) {
            meter.firstElementChild.style.width = `${meterPos(db)}%`;
            meter.lastElementChild.style.left = `${meterPos(threshold)}%`;
            meter.classList.toggle('active', Boolean(active));
        }
    }
    const meterHtml = (id) => `<div class="vb-meter" data-meter="${esc(id)}" title="Sound level; the mark is the alert threshold"><div class="vb-meter-fill"></div><div class="vb-meter-mark"></div></div>`;
    const sensOptions = (value) => ['1 · only loud crying', '2 · low', '3 · normal', '4 · high', '5 · every sound']
        .map((label, i) => `<option value="${i + 1}"${i + 1 === value ? ' selected' : ''}>${label}</option>`).join('');

    function buildBar() {
        const bar = $('voiceBar');
        if (!bar) return;
        bar.className = `voice-bar ${V.role || 'd-none'}`;
        if (!V.role) { bar.innerHTML = ''; return; }
        const icon = { talk: 'bi-telephone-fill', baby: 'bi-broadcast', parent: 'bi-ear-fill' }[V.role];
        const night = '<button type="button" class="vb-btn" data-action="voice-night" title="Dark screen (keeps the phone awake)"><i class="bi bi-moon-stars-fill"></i></button>';
        const mute = `<button type="button" class="vb-btn d-none" data-action="voice-route" id="vbRoute" title="Earpiece / speaker"><i class="bi bi-volume-up-fill"></i></button>
            <button type="button" class="vb-btn" data-action="voice-mute" id="vbMute" title="Mute microphone"><i class="bi bi-mic-fill"></i></button>`;
        let extra = '';
        if (V.role === 'baby') {
            extra = `${meterHtml('self')}
                <div class="vb-controls"><label>Sensitivity <select id="vbSens">${sensOptions(V.baby.cfg.sens)}</select></label></div>`;
        } else if (V.role === 'parent') {
            extra = `<div class="vb-controls">
                    <div class="vb-seg" role="group" aria-label="Listening mode">
                        <button type="button" data-action="voice-mode" data-mode="alerts" title="Silent until the baby station detects sound">Alerts only</button>
                        <button type="button" data-action="voice-mode" data-mode="live" title="Hear the room all the time">Live</button>
                    </div>
                    <label>Sensitivity <select id="vbSens">${sensOptions(3)}</select></label>
                    <button type="button" class="vb-test" data-action="voice-test" title="Play the alarm sound to check the volume of this phone"><i class="bi bi-bell-fill"></i> Test alarm</button>
                    <button type="button" class="vb-talk" id="vbTalk"><i class="bi bi-mic-fill"></i> Hold to talk</button>
                </div>`;
        }
        bar.innerHTML = `
            <div class="vb-alert d-none" id="vbAlert" role="alert"><i class="bi bi-exclamation-triangle-fill"></i><span></span>
                <button type="button" data-action="voice-ack">OK</button></div>
            <div class="vb-row">
                <i class="bi ${icon} vb-icon"></i>
                <div class="vb-text"><strong>${ROLE_LABEL[V.role]}</strong><small id="vbStatus"></small></div>
                <div class="vb-actions">${V.role === 'talk' ? mute : night}
                    <button type="button" class="vb-btn danger" data-action="voice-stop" title="${V.role === 'talk' ? 'Hang up' : 'Stop'}">
                        <i class="bi ${V.role === 'talk' ? 'bi-telephone-x-fill' : 'bi-stop-fill'}"></i></button>
                </div>
            </div>
            <div class="vb-peers" id="vbPeers"></div>
            ${extra}
            <div class="vb-secure" id="vbStats"></div>
            <div class="vb-secure" id="vbSecure"></div>`;
        $('vbSens')?.addEventListener('change', (e) => {
            const sens = clamp(Number(e.target.value), 1, 5);
            if (V.role === 'baby') { V.baby.cfg.sens = sens; saveBabyStore(); sendAll({ t: 'cfg', ...V.baby.cfg }); }
            else sendAll({ t: 'set', sens }); // set on the baby station from the parent's bed
        });
        const talk = $('vbTalk');
        if (talk) {
            talk.addEventListener('pointerdown', (e) => { e.preventDefault(); try { talk.setPointerCapture(e.pointerId); } catch { /* ignore */ } setTalking(true); });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) talk.addEventListener(type, () => setTalking(false));
            talk.addEventListener('contextmenu', (e) => e.preventDefault());
        }
    }

    const stateLabel = (peer) => {
        const state = peer.pc?.connectionState;
        if (state === 'connected') return channelOpen(peer) ? 'connected' : 'connecting';
        if (peer.everConnected) return 'reconnecting';
        return 'connecting';
    };

    function peersHtml() {
        if (V.role === 'parent') {
            const rows = [...V.peers.values()].filter((p) => p.role === 'baby').map((p) => {
                const state = stateLabel(p);
                const battery = p.battery ? `<span class="vb-battery${p.battery[0] <= 15 && !p.battery[1] ? ' low' : ''}" title="Battery of the baby station">
                    <i class="bi ${p.battery[1] ? 'bi-battery-charging' : 'bi-battery-half'}"></i>${p.battery[0]}%</span>` : '';
                return `<div class="vb-station ${state}${p.active ? ' active' : ''}">
                    <div class="vb-station-head"><span class="vb-dot"></span><strong>${esc(nameOf(p.id))}</strong>
                        <small>${state === 'connected' ? (p.micOk ? (p.active ? 'sound detected' : 'quiet') : 'microphone problem') : `${state}…`}</small>${battery}</div>
                    ${meterHtml(p.id)}</div>`;
            });
            for (const [id, lost] of V.parent.lost) {
                if (!V.peers.has(id)) rows.push(`<div class="vb-station lost"><div class="vb-station-head"><span class="vb-dot"></span><strong>${esc(lost.name)}</strong><small>connection lost</small></div></div>`);
            }
            return rows.join('') || '<div class="vb-empty">Waiting for a baby station in this room… Start “Baby station” on the phone that stays with the baby.</div>';
        }
        const chips = [...V.peers.values()].map((p) => {
            const state = stateLabel(p);
            const icon = p.remoteMuted ? 'bi-mic-mute-fill' : p.talking ? 'bi-megaphone-fill' : V.role === 'baby' ? 'bi-ear-fill' : 'bi-person-fill';
            const title = [state, p.path, !FR.keys && p.sas ? `security code ${p.sas}` : ''].filter(Boolean).join(' · ');
            return `<span class="vb-chip ${state}" title="${esc(title)}"><i class="bi ${icon}"></i>${esc(nameOf(p.id))}${p.talking ? ' is talking' : ''}</span>`;
        });
        if (V.role === 'baby' && !chips.length) return '<div class="vb-empty">Waiting for a parent unit… Open this room on the other phone and choose “Parent unit”.</div>';
        return chips.join('');
    }

    function updateStatus() {
        const status = $('vbStatus');
        if (!status || !V.role) return;
        const connected = [...V.peers.values()].filter((p) => p.pc?.connectionState === 'connected').length;
        const elapsed = Math.floor((Date.now() - V.since) / 1000);
        const time = `${Math.floor(elapsed / 3600) ? `${Math.floor(elapsed / 3600)}:` : ''}${String(Math.floor((elapsed % 3600) / 60)).padStart(elapsed >= 3600 ? 2 : 1, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
        let text;
        if (V.role === 'talk') {
            text = connected ? `${connected + 1} in call · ${time}` : Date.now() < V.ringUntil ? 'Ringing…' : V.peers.size ? 'Connecting…' : 'Waiting for others to join';
        } else if (V.role === 'baby') {
            const B = V.baby;
            text = !B.micOk ? 'Microphone problem – check this phone' : `${connected ? `${connected} parent unit${connected > 1 ? 's' : ''} listening` : 'No parent unit connected'}${B.targets.size ? ' · push alerts on' : ''}`;
        } else {
            text = connected ? `${V.parent.mode === 'live' ? 'Live' : 'Alerts only'} · ${time}` : 'Not connected';
        }
        if (V.role === 'parent' && V.keep?.paused && !V.blocked) text += ' · tap to keep running in the background';
        if (V.blocked) text = 'Tap anywhere to enable sound';
        if (!FR.online) text += ' · signaling offline';
        if (status.textContent !== text) status.textContent = text;
    }

    function securityHtml() {
        const push = V.role === 'parent' && !V.parent.push
            ? '<br><i class="bi bi-bell-slash"></i> Alerts only arrive while FileRoom stays open on this phone (install the app and allow notifications for background alerts).' : '';
        if (FR.keys) return `<i class="bi bi-shield-lock-fill"></i> End-to-end encrypted · verified by the room key · audio goes directly from phone to phone${push}`;
        const codes = [...V.peers.values()].filter((p) => p.sas).map((p) => `${esc(nameOf(p.id))}: <b>${p.sas}</b>`);
        return `<i class="bi bi-unlock"></i> Encrypted between the phones, but not verified (no room key).${codes.length ? ` Compare the code by voice – ${codes.join(', ')}` : ''}${push}`;
    }

    let dirty = false;
    function update() {
        if (dirty) return;
        dirty = true;
        Promise.resolve().then(() => { dirty = false; draw(); });
    }

    function draw() {
        // Header button and badge
        const talkers = others('talk').length, babies = others('baby').length;
        const button = $('voiceHeaderBtn');
        if (button) {
            button.classList.toggle('live', Boolean(V.role));
            button.classList.toggle('pulse', !V.role && talkers > 0);
            const badge = $('voiceBadge');
            const count = V.role ? 0 : talkers + babies;
            badge.textContent = count || '';
            badge.classList.toggle('d-none', !count);
        }
        // Incoming call
        const ring = $('ringBanner');
        if (ring) {
            ring.classList.toggle('d-none', !V.ring);
            if (V.ring) $('ringText').textContent = `${nameOf(V.ring.id)} is calling…`;
        }
        // Sheet
        if ($('voiceModal')) {
            $('voiceCallTitle').textContent = V.role === 'talk' ? 'Hang up' : talkers ? `Join voice call (${talkers} in call)` : 'Start voice call';
            $('voiceCallHint').textContent = V.role === 'talk' ? 'Leave the call' : talkers ? 'Talk with everyone who joined' : 'Rings everyone who has this room open';
            $('voiceBabyTitle').textContent = V.role === 'baby' ? 'Stop baby station' : 'Baby station';
            $('voiceParentTitle').textContent = V.role === 'parent' ? 'Stop parent unit' : 'Parent unit';
            $('voiceParentHint').textContent = babies
                ? `Online: ${others('baby').map((b) => nameOf(b.id)).join(', ')} – listen, get alerts, talk back`
                : 'Hear the baby, get alerts, talk back. No baby station in this room yet.';
            $('voiceSecurity').className = `voice-security ${FR.keys ? 'secure' : 'open'}`;
            $('voiceSecurity').innerHTML = !SUPPORTED
                ? '<i class="bi bi-exclamation-triangle-fill"></i><span>Calls need HTTPS (or localhost) and microphone access.</span>'
                : FR.keys
                    ? '<i class="bi bi-shield-lock-fill"></i><span>End-to-end encrypted with this room\'s key. Audio goes directly from phone to phone, never through the server.</span>'
                    : '<i class="bi bi-unlock"></i><span>Audio is encrypted between the phones, but without a room key nobody can verify who is on the other end. <button type="button" class="btn-link-inline" data-action="open-key">Set a room key</button></span>';
            const hint = {
                needKey: 'Other devices in this room use a room key. Open their invite link or scan their QR code to call them.',
                otherKey: 'A device in this room uses a different room key and cannot be reached.',
                noKey: 'A device in this room does not have the room key yet and cannot join calls. Show it the QR code.',
            }[V.foreign];
            $('voiceForeign').textContent = hint || '';
            $('voiceForeign').classList.toggle('d-none', !hint);
        }
        if (!V.role) return;
        const peers = $('vbPeers');
        if (peers) {
            const html = peersHtml();
            if (peers.dataset.html !== html) { peers.dataset.html = html; peers.innerHTML = html; }
            for (const p of V.peers.values()) if (p.role === 'baby') drawMeter(p.id, p.level, p.threshold, p.active);
        }
        $('vbSecure').innerHTML = securityHtml();
        // Where the delay comes from: network round trip and playout buffer per connection.
        const stats = [...V.peers.values()].filter((p) => p.pc?.connectionState === 'connected' && p.path).map((p) => {
            const parts = [p.path === 'relayed' ? 'relayed through the server' : 'direct'];
            if (Number.isFinite(p.rtt)) parts.push(`network ${p.rtt} ms`);
            if (Number.isFinite(p.buffer) && V.role !== 'baby') parts.push(`buffer ${p.buffer} ms`);
            return `${V.peers.size > 1 ? `${esc(nameOf(p.id))}: ` : ''}${parts.join(' · ')}`;
        });
        const statsEl = $('vbStats');
        if (statsEl) {
            const html = stats.length ? `<i class="bi bi-speedometer2"></i> ${stats.join(' — ')}` : '';
            if (statsEl.dataset.html !== html) { statsEl.dataset.html = html; statsEl.innerHTML = html; }
        }
        const routeButton = $('vbRoute');
        if (routeButton) {
            const available = ROUTES.filter((r) => V.routes[r.kind]);
            const current = ROUTES.find((r) => r.kind === V.route);
            routeButton.classList.toggle('d-none', available.length < 2);
            routeButton.classList.toggle('active', V.route === 'speaker');
            routeButton.disabled = Boolean(V.routeBusy);
            routeButton.title = current ? `Sound: ${current.label} – tap to switch` : 'Earpiece / speaker';
            routeButton.querySelector('i').className = `bi ${(current || ROUTES[1]).icon}`;
        }
        const mute = $('vbMute');
        if (mute) {
            mute.classList.toggle('active', V.muted);
            mute.querySelector('i').className = `bi ${V.muted ? 'bi-mic-mute-fill' : 'bi-mic-fill'}`;
        }
        for (const el of document.querySelectorAll('[data-action="voice-mode"]')) el.classList.toggle('active', el.dataset.mode === V.parent.mode);
        const sens = $('vbSens');
        if (sens && document.activeElement !== sens) {
            const cfg = V.role === 'baby' ? V.baby.cfg : [...V.peers.values()].find((p) => p.cfg)?.cfg;
            if (cfg) sens.value = String(cfg.sens);
            sens.disabled = V.role === 'parent' && !cfg;
        }
        const alert = $('vbAlert');
        if (alert) {
            alert.classList.toggle('d-none', !V.alert);
            if (V.alert) alert.querySelector('span').textContent = V.alert.text;
        }
        $('voiceBar').classList.toggle('alarm', Boolean(V.alert));
        $('voiceBar').classList.toggle('sound', V.role === 'baby' ? Boolean(V.baby?.det.active) : [...V.peers.values()].some((p) => p.active));
        updateStatus();
    }

    Object.assign(FR.actions, {
        'open-voice': () => { update(); $('voiceModal').classList.add('show'); },
        'close-voice': () => $('voiceModal').classList.remove('show'),
        'voice-call': () => (V.role === 'talk' ? stop() : start('talk')),
        'voice-baby': () => (V.role === 'baby' ? stop() : start('baby')),
        'voice-parent': () => (V.role === 'parent' ? stop() : start('parent')),
        'voice-stop': () => {
            if (V.role === 'baby' && !confirm('Stop the baby station? Parent units will no longer hear this room.')) return;
            stop();
        },
        'voice-mute': () => {
            V.muted = !V.muted;
            if (V.mic) V.mic.track.enabled = !V.muted;
            sendAll({ t: 'mute', on: V.muted });
            update();
        },
        'voice-route': () => {
            // Earpiece <-> speaker; a connected headset is part of the round.
            const available = ROUTES.filter((r) => V.routes[r.kind]).map((r) => r.kind);
            if (available.length < 2) return;
            const next = available[(available.indexOf(V.route) + 1) % available.length];
            setRoute(next, true).then(() => {
                const route = ROUTES.find((r) => r.kind === V.route);
                if (route) FR.showToast(route.label, 'info', 1500);
            });
        },
        'voice-test': () => {
            alertContext();
            beep('alarm');
            navigator.vibrate?.([400, 150, 400]);
            FR.showToast('This is the alarm for a lost connection. Too quiet? Turn up the media volume of this phone.', 'info', 6000);
        },
        'voice-mode': (el) => {
            V.parent.mode = el.dataset.mode === 'live' ? 'live' : 'alerts';
            FR.storage.set('fileroom_parent_mode', V.parent.mode);
            for (const peer of V.peers.values()) applyGate(peer);
            update();
        },
        'voice-night': () => { V.night.auto = V.role === 'baby'; setNight(true); },
        'voice-night-off': () => setNight(false),
        'voice-ack': () => { clearAlert(); clearNotifications(); },
        'ring-join': () => start('talk'),
        'ring-dismiss': () => { const ring = V.ring; stopRing(); if (ring) signal(ring.id, 'decline'); },
    });

    // ======================================================================
    // Wiring
    // ======================================================================
    FR.on('signal', (from, data, to) => {
        recvChain = recvChain.then(() => receive(from, data, to)).catch((err) => log('signal failed', err));
    });
    FR.on('ws-open', () => {
        signal(null, 'hello'); // learn about running calls / baby stations
        if (!V.role) return;
        announce();
        for (const peer of V.peers.values()) if (peer.pc?.connectionState !== 'connected') recover(peer);
        update();
    });
    FR.on('ws-close', () => updateStatus());
    FR.on('users', () => update());
    FR.on('user-left', (id) => {
        if (V.peers.get(id)?.pc?.connectionState !== 'connected') dropDevice(id, false);
    });
    FR.on('signal-error', (info) => { if (info.reason !== 'offline') log('signaling refused:', info.reason); });
    FR.on('rejoin', () => {
        // The server restarted and will hand out new user ids: start over with clean connections.
        for (const peer of [...V.peers.values()]) closePeer(peer);
        V.roster.clear();
        update();
    });
    FR.on('key', () => {
        // The signaling of the old key is worthless: leave the session instead of half-working.
        if (V.role) { FR.showToast(`${ROLE_LABEL[V.role]} stopped because the room key changed.`, 'warning', 6000); stop(); }
        V.roster.clear();
        V.foreign = null;
        signal(null, 'hello');
        update();
    });

    document.addEventListener('pointerdown', () => {
        V.night.last = Date.now();
        resumeAudio();
    }, true);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        resumeAudio();
        if (V.wantWake) setWakeLock(true); // wake locks are released when the page is hidden
        if (!V.alert && !V.ring) clearNotifications();
        if (V.role) tick(); // notice a suspension right now, not at the next heartbeat
        update();
    });
    // Wi-Fi <-> mobile data, Wi-Fi back in range: do not wait for the connection to time out.
    const networkChanged = () => {
        if (!V.role) return;
        setTimeout(() => { for (const peer of V.peers.values()) if (peer.pc?.connectionState !== 'connected') recover(peer, true); }, 1500);
    };
    window.addEventListener('online', networkChanged);
    navigator.connection?.addEventListener?.('change', networkChanged);
    navigator.mediaDevices?.addEventListener?.('devicechange', () => { onDeviceChange().catch((err) => log('device change', err)); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('voiceModal')?.classList.remove('show'); });
    $('voiceModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
    window.addEventListener('beforeunload', (e) => { if (V.role) { e.preventDefault(); e.returnValue = ''; } });
    navigator.serviceWorker?.addEventListener('message', (e) => {
        // A push arrived while this page is alive: the service worker asks us to check the connection.
        if (e.data?.type === 'VOICE_PUSH' && V.role === 'parent') for (const peer of V.peers.values()) recover(peer);
    });

    function init() {
        update();
        // After a reload (update, crash, accidental swipe) a babyphone session continues by itself.
        const session = FR.storage.get(SESSION_KEY());
        if (session && ['baby', 'parent'].includes(session.role) && Date.now() - session.at < RESUME_WINDOW) {
            start(session.role, { resume: true });
        } else if (session) {
            try { localStorage.removeItem(SESSION_KEY()); } catch { /* ignore */ }
        }
    }
    if (FR.ready) init(); else FR.on('ready', init);

    window.fileroomVoice = { active: () => Boolean(V.role), role: () => V.role, start, stop, _state: V, _tick: tick };
})();
