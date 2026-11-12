/**
 * FileRoom chat client.
 * The room page is a static app shell (cached by the service worker); the room code comes from the URL
 * and all content is loaded from the API / WebSocket.
 *
 * End-to-end encryption: a room can have a key (random, carried in the URL fragment "#k=…" of the
 * invite link / QR code, or a password everybody types). With a key, texts, locations, files and
 * call signaling are encrypted on the device (see e2ee.js); the server stores and relays ciphertext.
 *
 * window.fileroom is the small interface used by voice.js (calls and babyphone).
 */
(() => {
    'use strict';

    // ======================================================================
    // Configuration & state
    // ======================================================================
    const meta = (name, fallback) => document.querySelector(`meta[name="${name}"]`)?.content || fallback;
    const MAX_FILE_SIZE = parseInt(meta('max-file-size', String(100 * 1024 * 1024)), 10);
    const MAX_CODE_LENGTH = parseInt(meta('max-room-code-length', '64'), 10);
    const PREFETCH_LIMIT = 300 * 1024 * 1024; // keep at most this much in memory for sharing
    const RECENT_KEY = 'fileroom_recent_rooms';
    const FILE_TYPES = new Set(['file', 'image', 'video', 'voice']);
    const CAN_SHARE = typeof navigator.share === 'function';
    const C = window.FileRoomCrypto;
    const CAN_ENCRYPT = Boolean(C && window.crypto?.subtle); // WebCrypto needs HTTPS (or localhost)
    const AUTO_DECRYPT_LIMIT = 30 * 1024 * 1024;             // larger encrypted media is loaded on tap

    const $ = (id) => document.getElementById(id);
    const state = {
        roomCode: null,
        user: null,
        users: [],
        ready: false,
        secret: null,              // room secret (random key or password); never sent to the server
        keys: null,                // keys derived from it (FileRoomCrypto.deriveRoomKeys)
        objectUrls: new Map(),     // id -> blob: URL of a decrypted file
        ws: null,
        wsPing: null,
        reconnectTimer: null,
        reconnectDelay: 1000,
        joining: null,
        messages: new Map(),       // id -> message data (in display order)
        clockOffset: 0,            // server time - client time (seconds)
        selectMode: false,
        selected: new Set(),
        fileCache: new Map(),      // id -> Promise<File>
        fileReady: new Map(),      // id -> File
        audio: new Map(),          // id -> HTMLAudioElement
        maps: new Map(),           // id -> Leaflet map
        upload: { active: false, xhr: null, cancelled: false },
        recording: { pressed: false, recorder: null, stream: null, started: 0, timer: null },
        currentImageId: null,
    };

    // ======================================================================
    // Small utilities
    // ======================================================================
    const storage = {
        get(key, fallback = null) {
            try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
        },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
    };

    // Tiny event hub for voice.js: signal, signal-error, ws-open, ws-close, users, user-left, rejoin, key, ready
    const listeners = new Map();
    function on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
    }
    function emit(event, ...args) {
        for (const fn of listeners.get(event) || []) {
            try { fn(...args); } catch (err) { console.error(`${event} handler failed`, err); }
        }
    }

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function normalizeRoomCode(raw) {
        if (raw == null) return null;
        const code = String(raw).normalize('NFC').trim().replace(/\s+/g, '-').toUpperCase();
        if (!code || [...code].length > MAX_CODE_LENGTH || !/^[\p{L}\p{N}_-]+$/u.test(code)) return null;
        return code;
    }

    function randomRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        return Array.from(bytes, (b) => chars[b % chars.length]).join('');
    }

    const roomUrl = (code) => `/room/${encodeURIComponent(code)}`;
    const serverNow = () => Date.now() / 1000 + state.clockOffset;
    const isFileMsg = (msg) => msg && FILE_TYPES.has(msg.type);
    const isPrivate = (msg) => Boolean(msg && (msg.sealed || msg.enc)); // the server only has ciphertext
    const downloadUrl = (id) => `/api/download/${encodeURIComponent(id)}`;

    function formatTime(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        if (seconds <= 0) return 'Expired';
        const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function formatAudioTime(seconds) {
        if (!isFinite(seconds)) return '0:00';
        return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function clockTime(ts) {
        return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function fileIcon(mime = '', name = '') {
        const ext = name.split('.').pop().toLowerCase();
        if (mime.startsWith('image/')) return 'bi-file-earmark-image';
        if (mime.startsWith('video/')) return 'bi-file-earmark-play';
        if (mime.startsWith('audio/')) return 'bi-file-earmark-music';
        if (mime === 'application/pdf') return 'bi-file-earmark-pdf';
        if (/zip|compressed|tar|rar|7z/.test(mime) || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'bi-file-earmark-zip';
        if (mime.startsWith('text/')) return 'bi-file-earmark-text';
        if (/word|document/.test(mime)) return 'bi-file-earmark-word';
        if (/sheet|excel|csv/.test(mime)) return 'bi-file-earmark-spreadsheet';
        if (/presentation|powerpoint/.test(mime)) return 'bi-file-earmark-slides';
        return 'bi-file-earmark';
    }

    function linkify(text) {
        const re = /https?:\/\/[^\s<>"']+/g;
        let out = '', last = 0, m;
        while ((m = re.exec(text))) {
            let url = m[0];
            const trail = url.match(/[),.;:!?]+$/); // keep trailing punctuation outside the link
            if (trail && !(trail[0].startsWith(')') && url.includes('('))) url = url.slice(0, -trail[0].length);
            out += esc(text.slice(last, m.index));
            out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="inline-link">${esc(url)}</a>`;
            last = m.index + url.length;
            re.lastIndex = last;
        }
        return out + esc(text.slice(last));
    }

    function showToast(message, type = 'info', delay = 4000) {
        const container = document.querySelector('.toast-container');
        if (!container) return;
        const colors = { success: 'text-bg-success', danger: 'text-bg-danger', warning: 'text-bg-warning', info: 'text-bg-primary' };
        const toast = document.createElement('div');
        toast.className = `toast align-items-center border-0 ${colors[type] || colors.info}`;
        toast.setAttribute('role', type === 'danger' ? 'alert' : 'status');
        const wrap = document.createElement('div');
        wrap.className = 'd-flex';
        const body = document.createElement('div');
        body.className = 'toast-body';
        body.textContent = message;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = `btn-close ${type === 'warning' ? '' : 'btn-close-white'} me-2 m-auto`;
        close.setAttribute('data-bs-dismiss', 'toast');
        close.setAttribute('aria-label', 'Close');
        wrap.append(body, close);
        toast.append(wrap);
        container.append(toast);
        if (window.bootstrap?.Toast) {
            const t = new bootstrap.Toast(toast, { delay });
            toast.addEventListener('hidden.bs.toast', () => toast.remove());
            t.show();
        } else {
            setTimeout(() => toast.remove(), delay);
        }
    }

    async function api(url, options = {}) {
        const response = await fetch(url, options);
        let data = null;
        try { data = await response.json(); } catch { /* not JSON */ }
        if (!response.ok) {
            const detail = data?.detail || data?.error || `HTTP ${response.status}`;
            const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
            err.status = response.status;
            throw err;
        }
        return data;
    }

    function triggerDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        if (filename) a.download = filename;
        a.rel = 'noopener';
        document.body.append(a);
        a.click();
        a.remove();
    }

    // ======================================================================
    // Room code, recent rooms
    // ======================================================================
    function resolveRoomCode() {
        const match = location.pathname.match(/^\/room\/([^/]+)\/?$/);
        let raw = null;
        if (match) {
            try { raw = decodeURIComponent(match[1]); } catch { raw = match[1]; }
        }
        let code = normalizeRoomCode(raw);
        if (!code) {
            if (raw) showToast('Invalid room name – opened a new room instead.', 'warning');
            const params = new URLSearchParams(location.search);
            const recent = storage.get(RECENT_KEY, []);
            code = (!raw && params.get('source') === 'pwa' && recent[0]) || randomRoomCode();
        }
        setRoomCode(code);
    }

    function setRoomCode(code) {
        state.roomCode = code;
        const url = roomUrl(code) + location.search + location.hash;
        if (location.pathname + location.search + location.hash !== url) history.replaceState(null, '', url);
        document.title = `FileRoom – ${code}`;
        $('roomTitle').textContent = code;
        $('roomTitle').title = code;
        $('sidebarRoomCode').textContent = code;
        rememberRoom(code);
    }

    function rememberRoom(code) {
        const recent = storage.get(RECENT_KEY, []).filter((r) => r !== code);
        recent.unshift(code);
        storage.set(RECENT_KEY, recent.slice(0, 8));
        document.cookie = `fileroom_last_room=${encodeURIComponent(code)}; Path=/; Max-Age=${60 * 60 * 24 * 7}; SameSite=Lax`;
    }

    function handleUrlNotices() {
        const params = new URLSearchParams(location.search);
        const error = params.get('shareError');
        if (error) {
            const messages = {
                expired: 'The shared content expired. Please share again.',
                empty: 'Nothing was received from the sharing app.',
                'too-large': 'The shared files are too large.',
                invalid: 'The shared content could not be read.',
                'invalid-room': 'Invalid room name – opened a new room instead.',
            };
            showToast(messages[error] || 'Sharing failed. Please try again.', 'warning', 7000);
        }
        if (params.has('shareError') || params.has('source') || params.has('new') || params.has('share') || params.has('invite')) {
            history.replaceState(null, '', roomUrl(state.roomCode) + location.hash);
        }
    }

    // ======================================================================
    // Room key (end-to-end encryption)
    // ======================================================================
    const keyStore = () => `fileroom_key_${state.roomCode}`;

    function secretFromHash() {
        const match = location.hash.match(/^#k=(.+)$/);
        if (!match) return null;
        try { return decodeURIComponent(match[1]) || null; } catch { return null; }
    }

    /** Link to this room; with a key it carries the key in the fragment, which browsers never send to a server. */
    function inviteUrl() {
        return location.origin + roomUrl(state.roomCode) + (state.secret ? `#k=${encodeURIComponent(state.secret)}` : '');
    }

    async function setSecret(secret, { initial = false } = {}) {
        secret = secret || null;
        if (secret && !CAN_ENCRYPT) {
            showToast('Encryption needs HTTPS (or localhost). This room is used without a key.', 'warning', 7000);
            secret = null;
        }
        const changed = secret !== state.secret;
        state.secret = secret;
        state.keys = secret ? await C.deriveRoomKeys(secret, state.roomCode) : null;
        if (secret) storage.set(keyStore(), secret);
        else { try { localStorage.removeItem(keyStore()); } catch { /* ignore */ } }
        const url = roomUrl(state.roomCode) + location.search + (secret ? `#k=${encodeURIComponent(secret)}` : '');
        if (location.pathname + location.search + location.hash !== url) history.replaceState(null, '', url);
        updateKeyUi();
        if (initial || !changed) return;
        // Everything on screen was decoded with the old key: load and decode it again.
        clearMessages();
        for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
        state.objectUrls.clear();
        refreshData();
        emit('key');
    }

    async function initKey() {
        const isNew = new URLSearchParams(location.search).has('new');
        let secret = secretFromHash() || storage.get(keyStore());
        // A room that was just created gets a random key: encrypted by default, nothing to remember.
        if (!secret && isNew && CAN_ENCRYPT) secret = C.randomSecret();
        try {
            await setSecret(secret, { initial: true });
        } catch (err) {
            console.error('Room key could not be set up', err);
            updateKeyUi();
        }
    }

    function updateKeyUi() {
        const secure = Boolean(state.keys);
        const button = $('keyBtn');
        if (button) {
            button.classList.toggle('secure', secure);
            button.title = secure ? 'End-to-end encrypted – room key' : 'Not encrypted – set a room key';
            button.querySelector('i').className = `bi ${secure ? 'bi-lock-fill' : 'bi-unlock'}`;
        }
        $('messageInput').placeholder = secure ? 'Type an encrypted message' : 'Type a message...';
        const status = $('keyStatus');
        if (!status) return;
        status.className = `voice-security ${secure ? 'secure' : 'open'}`;
        status.innerHTML = secure
            ? '<i class="bi bi-shield-lock-fill"></i><span><strong>End-to-end encrypted.</strong> Messages, files, calls and the babyphone can only be read by devices that have this room\'s key. The server never sees it.</span>'
            : CAN_ENCRYPT
                ? '<i class="bi bi-unlock"></i><span><strong>No room key.</strong> Anyone who knows the room name can read along, and the server could too. Set a password or create a key to encrypt this room.</span>'
                : '<i class="bi bi-exclamation-triangle-fill"></i><span>Encryption needs HTTPS (or localhost).</span>';
        for (const el of document.querySelectorAll('[data-needs-key]')) el.classList.toggle('d-none', !secure);
        $('keyForm').classList.toggle('d-none', !CAN_ENCRYPT);
    }

    /** Server message -> message as displayed. Encrypted ones are opened with the room key or shown as locked. */
    async function decodeMessage(msg) {
        if (!msg || (msg.type !== 'sealed' && !msg.enc)) return msg;
        const locked = (reason) => ({ ...msg, type: 'locked', reason, enc: false });
        if (!state.keys) return locked('nokey');
        try {
            if (msg.type === 'sealed') {
                const value = await C.open(state.keys, 'msg', msg.data);
                if (value?.t === 'text' && typeof value.text === 'string') return { ...msg, type: 'text', text: value.text, sealed: true };
                if (value?.t === 'location' && Number.isFinite(Number(value.latitude)) && Number.isFinite(Number(value.longitude))) {
                    return { ...msg, type: 'location', latitude: Number(value.latitude), longitude: Number(value.longitude), sealed: true };
                }
                return locked('damaged');
            }
            const meta = await C.open(state.keys, 'meta', msg.meta);
            return {
                ...msg, type: FILE_TYPES.has(meta.kind) ? meta.kind : 'file',
                filename: String(meta.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200), mime: String(meta.type || 'application/octet-stream').slice(0, 100),
                size: Number(meta.size) || 0, sealed: true,
            };
        } catch (err) {
            return locked(err?.wrongKey ? 'otherkey' : 'damaged');
        }
    }

    // Decoding is asynchronous; a queue keeps messages in the order they arrived.
    let intake = Promise.resolve();
    function enqueue(job) {
        intake = intake.then(job).catch((err) => console.error('Message handling failed', err));
        return intake;
    }
    const receiveMessage = (raw, animate) => enqueue(async () => addMessage(await decodeMessage(raw), animate));
    const receiveList = (list) => enqueue(async () => syncMessages(await Promise.all(list.map(decodeMessage))));

    function classify(mime, requested) {
        if (requested === 'voice' && (mime.startsWith('audio/') || mime.startsWith('video/webm'))) return 'voice';
        if (mime.startsWith('image/')) return 'image';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('audio/')) return 'voice';
        return 'file';
    }

    /** blob: URL of a file; encrypted files are downloaded and decrypted first. */
    async function objectUrl(id) {
        if (state.objectUrls.has(id)) return state.objectUrls.get(id);
        const file = await fetchFile(id);
        if (!state.messages.has(id)) throw new Error('Message was deleted');
        if (!state.objectUrls.has(id)) state.objectUrls.set(id, URL.createObjectURL(file));
        return state.objectUrls.get(id);
    }
    const mediaUrl = async (id) => (state.messages.get(id)?.enc ? objectUrl(id) : downloadUrl(id));

    // ======================================================================
    // User & connection
    // ======================================================================
    function userKey() { return `fileroom_user_${state.roomCode}`; }

    /**
     * The name of this device, kept for all rooms: { name, public }.
     * public = false: only known devices learn it (encrypted, see contacts.js); the server and everyone
     * else see a random name per room. No name at all: anonymous everywhere.
     */
    function getProfile() {
        const profile = storage.get('fileroom_profile') || {};
        const name = typeof profile.name === 'string' ? profile.name.trim().slice(0, 20) : '';
        return { name: name || null, public: Boolean(name) && profile.public !== false };
    }

    async function joinRoom(newName, { anonymous = false } = {}) {
        const stored = storage.get(userKey());
        const params = new URLSearchParams();
        if (stored?.id) params.set('user_id', stored.id);
        const profile = getProfile();
        const name = newName || (profile.public ? profile.name : stored?.name);
        if (anonymous) params.set('anon', '1'); // a fresh random name from the server
        else if (name) params.set('user_name', name);
        const data = await api(`/api/join/${encodeURIComponent(state.roomCode)}?${params}`);
        if (data.room_code && data.room_code !== state.roomCode) setRoomCode(data.room_code);
        state.user = { id: data.user_id, name: data.user_name };
        storage.set(userKey(), state.user);
        for (const [id, msg] of state.messages) $(`msg-${id}`)?.classList.toggle('own', msg.user_id === state.user.id);
        return state.user;
    }

    async function ensureJoined() {
        if (state.user) return state.user;
        if (!state.joining) {
            state.joining = (async () => {
                for (let attempt = 0; ; attempt++) {
                    try {
                        return await joinRoom();
                    } catch (err) {
                        if (err.status === 400) { showToast(err.message, 'danger'); throw err; }
                        setConnection('offline');
                        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
                    }
                }
            })().finally(() => { state.joining = null; });
        }
        return state.joining;
    }

    function setConnection(kind) {
        const el = $('connectionState');
        const text = { connecting: 'Connecting…', offline: navigator.onLine ? 'Reconnecting…' : 'Offline', online: '' }[kind];
        el.textContent = text;
        el.className = `connection-state ${kind}`;
    }

    async function connect() {
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
        clearTimeout(state.reconnectTimer);
        setConnection('connecting');
        try { await ensureJoined(); } catch { return; }
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(state.roomCode)}/${encodeURIComponent(state.user.id)}`);
        state.ws = ws;
        ws.onopen = () => {
            state.reconnectDelay = 1000;
            setConnection('online');
            clearInterval(state.wsPing);
            state.wsPing = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);
            refreshData(); // catch up on anything missed while disconnected
            emit('ws-open');
        };
        ws.onmessage = (event) => {
            let data;
            try { data = JSON.parse(event.data); } catch { return; }
            handleSocketMessage(data);
        };
        ws.onclose = () => {
            clearInterval(state.wsPing);
            if (state.ws === ws) state.ws = null;
            setConnection('offline');
            scheduleReconnect();
            emit('ws-close');
        };
        ws.onerror = () => { /* onclose follows */ };
    }

    function scheduleReconnect(immediate = false) {
        clearTimeout(state.reconnectTimer);
        const delay = immediate ? 0 : state.reconnectDelay;
        state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
        state.reconnectTimer = setTimeout(connect, delay);
    }

    function handleSocketMessage(data) {
        switch (data.type) {
            case 'users_list':
                updateUsersList(data.users);
                break;
            case 'new_message':
                receiveMessage(data.message, true);
                break;
            case 'signal': // call / babyphone signaling from another device in this room (opaque to the server)
                if (typeof data.from === 'string' && typeof data.data === 'string') emit('signal', data.from, data.data, data.to || null);
                break;
            case 'signal_error':
                emit('signal-error', data);
                break;
            case 'message_deleted':
                removeMessage(data.message_id);
                break;
            case 'user_joined':
                if (data.user_id !== state.user?.id) showToast(`${data.user_name} joined`, 'info', 2500);
                refreshUsers();
                break;
            case 'user_left':
                if (data.user_id !== state.user?.id) showToast(`${data.user_name} left`, 'info', 2500);
                refreshUsers();
                emit('user-left', data.user_id);
                break;
            case 'user_renamed':
                if (data.user_id !== state.user?.id) showToast(`${data.old_name} is now ${data.new_name}`, 'info', 2500);
                refreshData();
                break;
            case 'room_cleared':
                clearMessages();
                showToast('All messages in this room were deleted', 'info');
                break;
            case 'rejoin':
                // Server no longer knows us (e.g. restarted): register again.
                state.user = null;
                try { localStorage.removeItem(userKey()); } catch { /* ignore */ }
                emit('rejoin');
                break;
        }
    }

    async function refreshData() {
        try {
            const data = await api(`/api/room/${encodeURIComponent(state.roomCode)}/data`);
            state.clockOffset = data.server_time - Date.now() / 1000;
            updateUsersList(data.users);
            await receiveList(data.messages);
        } catch (err) {
            console.warn('Refresh failed:', err);
        }
    }

    async function refreshUsers() {
        try {
            const data = await api(`/api/room/${encodeURIComponent(state.roomCode)}/data`);
            updateUsersList(data.users);
        } catch { /* ignore */ }
    }

    function updateUsersList(users) {
        const container = $('usersList');
        if (!container || !Array.isArray(users)) return;
        const changed = users !== state.users;
        state.users = users;
        if (changed) emit('users');
        if (!users.length) {
            container.innerHTML = '<div class="text-muted small">No users</div>';
            return;
        }
        container.innerHTML = users.map((u) => {
            const me = state.user && u.id === state.user.id;
            // Recognised from an earlier encrypted room (contacts.js) - whatever name it uses here.
            const known = me ? null : window.fileroomContacts?.known(u.id);
            const alias = known?.name && known.name !== u.name ? ` <small class="user-alias">${esc(known.name)}</small>` : '';
            const badge = known?.old ? ` <i class="bi ${known.own ? 'bi-phone-fill' : known.fav ? 'bi-star-fill' : 'bi-person-check-fill'} user-known" title="${known.own ? 'Another device of yours (linked)' : 'Known device – you shared an encrypted room before'}"></i>` : '';
            return `<div class="user-item ${me ? 'current' : ''}" data-user="${esc(u.id)}"><div class="user-status"></div>${esc(u.name)}${me ? ' (you)' : ''}${badge}${alias}</div>`;
        }).join('');
    }

    // ======================================================================
    // Message rendering
    // ======================================================================
    function timerHtml(msg) {
        return `<span class="circular-timer" title="Time until deletion">
            <svg class="timer-circle" viewBox="0 0 20 20" aria-hidden="true">
                <circle class="timer-track" cx="10" cy="10" r="8"></circle>
                <circle class="timer-progress" cx="10" cy="10" r="8"></circle>
            </svg>
            <span class="timer-text">${formatTime(msg.expires_at - serverNow())}</span>
        </span>`;
    }

    function actionButton(action, icon, title, id) {
        return `<button type="button" class="btn-msg-action" data-action="${action}" data-id="${esc(id)}" title="${title}" aria-label="${title}"><i class="bi ${icon}"></i></button>`;
    }

    const LOCKED_TEXT = {
        nokey: 'Encrypted message. Open the invite link or scan the QR code of a device that has the room key.',
        otherkey: 'Encrypted with a different room key.',
        damaged: 'This encrypted message is damaged and cannot be read.',
    };

    function messageBody(msg) {
        const id = esc(msg.id);
        // Encrypted files have no usable URL: they are fetched, decrypted and shown from memory (afterInsert).
        const src = msg.enc ? '' : ` src="${esc(downloadUrl(msg.id))}"`;
        const name = esc(msg.filename);
        switch (msg.type) {
            case 'locked':
                return `<div class="locked-body"><i class="bi bi-lock-fill"></i><span>${LOCKED_TEXT[msg.reason] || LOCKED_TEXT.damaged}
                    ${msg.reason === 'damaged' ? '' : '<button type="button" class="btn-link-inline" data-action="open-key">Room key…</button>'}</span></div>`;
            case 'text':
                return `<div class="message-content">${linkify(msg.text)}</div>`;
            case 'location': {
                const lat = Number(msg.latitude), lng = Number(msg.longitude);
                const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
                return `<div class="location-preview" id="map-${id}"></div>
                    <div class="location-link"><a href="${esc(osm)}" target="_blank" rel="noopener noreferrer">
                    <i class="bi bi-geo-alt-fill me-1"></i>Open in Map</a> <small>${lat.toFixed(5)}, ${lng.toFixed(5)}</small></div>`;
            }
            case 'image':
                return `${msg.enc && msg.size > AUTO_DECRYPT_LIMIT
                    ? `<button type="button" class="media-load" data-action="load-media" data-id="${id}"><i class="bi bi-image"></i> Load image</button>`
                    : `<button type="button" class="image-preview" data-action="open-image" data-id="${id}" title="${name}">
                        <img${src} alt="${name}"${msg.enc ? '' : ' loading="lazy"'}>
                        <span class="image-overlay"><i class="bi bi-arrows-fullscreen"></i><span>View</span></span>
                    </button>`}
                    <div class="file-caption">${name} · ${formatSize(msg.size)}</div>`;
            case 'video':
                return `${msg.enc && msg.size > AUTO_DECRYPT_LIMIT
                    ? `<button type="button" class="media-load" data-action="load-media" data-id="${id}"><i class="bi bi-play-circle"></i> Load video</button>`
                    : `<video class="video-preview" controls preload="metadata" playsinline${src}></video>`}
                    <div class="file-caption">${name} · ${formatSize(msg.size)}</div>`;
            case 'voice':
                return `<div class="voice-player" id="voice-${id}">
                        <button type="button" class="voice-play-btn" data-action="toggle-voice" data-id="${id}" title="Play">
                            <i class="bi bi-play-fill"></i>
                        </button>
                        <div class="voice-progress">
                            <div class="voice-waveform">${'<div class="wave-bar"></div>'.repeat(5)}</div>
                            <div class="voice-time">0:00</div>
                        </div>
                    </div>
                    ${msg.filename && !/^voice_message/.test(msg.filename) ? `<div class="file-caption">${name} · ${formatSize(msg.size)}</div>` : ''}`;
            default:
                return `<div class="file-info">
                        <i class="bi ${fileIcon(msg.mime, msg.filename)} file-icon"></i>
                        <div class="file-meta">
                            <a class="file-name" href="${msg.enc ? '#' : esc(downloadUrl(msg.id))}" ${msg.enc ? `data-action="download-msg" data-id="${id}"` : `download="${name}"`}>${name}</a>
                            <small>${formatSize(msg.size)}</small>
                        </div>
                    </div>`;
        }
    }

    function renderMessage(msg) {
        const el = document.createElement('div');
        const own = state.user && msg.user_id === state.user.id;
        el.className = `message ${msg.type}${own ? ' own' : ''}`;
        el.id = `msg-${msg.id}`;
        el.dataset.id = msg.id;
        const actions = [];
        if (CAN_SHARE && msg.type !== 'locked') actions.push(actionButton('share-msg', 'bi-share', 'Share', msg.id));
        if (isFileMsg(msg)) actions.push(actionButton('download-msg', 'bi-download', 'Download', msg.id));
        if (msg.type === 'text' || msg.type === 'location') {
            actions.push(actionButton('copy-msg', 'bi-clipboard', 'Copy to clipboard', msg.id));
            actions.push(actionButton('download-msg', 'bi-download', 'Download as .txt', msg.id));
        }
        actions.push(actionButton('delete-msg', 'bi-trash', 'Delete', msg.id));
        el.innerHTML = `
            <span class="select-check" aria-hidden="true"><i class="bi bi-check-lg"></i></span>
            <div class="message-header">
                <span class="message-user">${esc(msg.username)}${isPrivate(msg) ? ' <i class="bi bi-lock-fill msg-lock" title="End-to-end encrypted"></i>' : ''}</span>
                <span class="message-time">${clockTime(msg.timestamp)} ${timerHtml(msg)}</span>
            </div>
            ${messageBody(msg)}
            <div class="message-footer">${actions.join('')}</div>`;
        return el;
    }

    function afterInsert(msg, el) {
        updateTimer(el, msg);
        if (msg.type === 'location') setTimeout(() => initMap(msg), 50);
        if (msg.type === 'image') {
            el.querySelector('img')?.addEventListener('load', () => maybeStickToBottom(), { once: true });
        }
        if (msg.enc && (msg.type === 'image' || msg.type === 'video') && msg.size <= AUTO_DECRYPT_LIMIT) loadMedia(msg.id);
    }

    /** Fetch and decrypt an encrypted image/video and show it. */
    async function loadMedia(id) {
        const el = $(`msg-${id}`);
        const msg = state.messages.get(id);
        if (!el || !msg) return;
        const button = el.querySelector('.media-load');
        if (button) { button.disabled = true; button.innerHTML = '<i class="bi bi-hourglass-split"></i> Decrypting…'; }
        el.classList.add('decrypting');
        try {
            const url = await objectUrl(id);
            if (button && msg.type === 'video') {
                const video = document.createElement('video');
                video.className = 'video-preview';
                video.controls = true;
                video.playsInline = true;
                button.replaceWith(video);
            } else if (button) {
                const preview = document.createElement('button');
                preview.type = 'button';
                preview.className = 'image-preview';
                preview.dataset.action = 'open-image';
                preview.dataset.id = id;
                preview.innerHTML = '<img alt=""><span class="image-overlay"><i class="bi bi-arrows-fullscreen"></i><span>View</span></span>';
                button.replaceWith(preview);
            }
            const media = el.querySelector('img, video');
            if (media) media.src = url;
        } catch (err) {
            if (!state.messages.has(id)) return;
            if (button) { button.disabled = false; button.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry'; }
            showToast(`${msg.filename} could not be decrypted: ${err.message}`, 'danger', 6000);
        } finally {
            el.classList.remove('decrypting');
        }
    }

    let stickToBottom = true;
    function maybeStickToBottom() { if (stickToBottom) scrollToBottom(); }

    function addMessage(msg, animate = false, beforeEl = null) {
        if (!msg || state.messages.has(msg.id)) return;
        if (msg.expires_at && msg.expires_at <= serverNow()) return;
        state.messages.set(msg.id, msg);
        const container = $('messagesContainer');
        const el = renderMessage(msg);
        if (!animate) el.style.animation = 'none';
        if (beforeEl) container.insertBefore(el, beforeEl); else container.append(el);
        afterInsert(msg, el);
        updateEmptyState();
        if (!beforeEl) {
            if (stickToBottom || (state.user && msg.user_id === state.user.id)) scrollToBottom();
        }
    }

    function syncMessages(list) {
        const serverIds = new Set(list.map((m) => m.id));
        for (const id of [...state.messages.keys()]) {
            if (!serverIds.has(id)) removeMessage(id, false);
        }
        // Insert missing messages in server order.
        let nextKnown = null;
        for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i];
            const existing = $(`msg-${msg.id}`);
            if (existing) { nextKnown = existing; continue; }
            addMessage(msg, false, nextKnown);
            nextKnown = $(`msg-${msg.id}`) || nextKnown;
        }
        updateEmptyState();
        maybeStickToBottom();
    }

    function forgetMessage(id) {
        state.messages.delete(id);
        state.selected.delete(id);
        state.fileCache.delete(id);
        state.fileReady.delete(id);
        if (state.objectUrls.has(id)) { URL.revokeObjectURL(state.objectUrls.get(id)); state.objectUrls.delete(id); }
        const audio = state.audio.get(id);
        if (audio) { audio.pause(); audio.removeAttribute('src'); state.audio.delete(id); }
        const map = state.maps.get(id);
        if (map) { map.remove(); state.maps.delete(id); }
        if (state.currentImageId === id) closeImageModal();
    }

    function removeMessage(id, animate = true) {
        forgetMessage(id);
        const el = $(`msg-${id}`);
        if (el) {
            if (animate) {
                el.classList.add('removing');
                setTimeout(() => el.remove(), 250);
            } else {
                el.remove();
            }
        }
        updateSelectionBar();
        setTimeout(updateEmptyState, animate ? 260 : 0);
    }

    function clearMessages() {
        for (const id of [...state.messages.keys()]) removeMessage(id, false);
    }

    function updateEmptyState() {
        $('emptyState').classList.toggle('d-none', state.messages.size > 0);
    }

    function scrollToBottom() {
        const c = $('messagesContainer');
        requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
    }

    // ----- Timers -----------------------------------------------------------
    const CIRCUMFERENCE = 2 * Math.PI * 8;
    function updateTimer(el, msg) {
        const remaining = msg.expires_at - serverNow();
        const total = Math.max(1, msg.expires_at - msg.timestamp);
        const circle = el.querySelector('.timer-progress');
        const text = el.querySelector('.timer-text');
        if (!circle || !text) return remaining;
        circle.style.strokeDasharray = CIRCUMFERENCE;
        circle.style.strokeDashoffset = CIRCUMFERENCE * (1 - Math.max(0, remaining) / total);
        circle.classList.toggle('danger', remaining < 300);
        circle.classList.toggle('warning', remaining >= 300 && remaining < 900);
        text.textContent = formatTime(remaining);
        return remaining;
    }

    function tickTimers() {
        for (const [id, msg] of [...state.messages]) {
            const el = $(`msg-${id}`);
            if (!el) continue;
            if (updateTimer(el, msg) <= 0) removeMessage(id);
        }
    }

    // ----- Maps -------------------------------------------------------------
    function initMap(msg) {
        if (typeof L === 'undefined' || state.maps.has(msg.id)) return;
        const el = $(`map-${msg.id}`);
        if (!el) return;
        try {
            const lat = Number(msg.latitude), lng = Number(msg.longitude);
            const map = L.map(el, { scrollWheelZoom: false, attributionControl: true }).setView([lat, lng], 15);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors', maxZoom: 19,
            }).addTo(map);
            L.marker([lat, lng]).addTo(map);
            state.maps.set(msg.id, map);
            setTimeout(() => map.invalidateSize(), 200);
        } catch (err) {
            console.error('Map initialization error:', err);
        }
    }

    // ----- Voice playback ---------------------------------------------------
    function toggleVoice(id) {
        const player = $(`voice-${id}`);
        if (!player) return;
        const icon = player.querySelector('.voice-play-btn i');
        const timeEl = player.querySelector('.voice-time');
        let audio = state.audio.get(id);
        if (!audio) {
            audio = new Audio();
            audio.preload = 'metadata';
            mediaUrl(id).then((url) => { audio.src = url; if (audio.dataset.autoplay) audio.play().catch(() => {}); })
                .catch((err) => { state.audio.delete(id); showToast(`Could not load the voice message: ${err.message}`, 'danger'); });
            audio.addEventListener('loadedmetadata', () => { timeEl.textContent = formatAudioTime(audio.duration); });
            audio.addEventListener('timeupdate', () => { timeEl.textContent = formatAudioTime(audio.currentTime); });
            audio.addEventListener('ended', () => {
                icon.className = 'bi bi-play-fill';
                player.classList.remove('playing');
                timeEl.textContent = formatAudioTime(audio.duration);
            });
            audio.addEventListener('pause', () => { icon.className = 'bi bi-play-fill'; player.classList.remove('playing'); });
            audio.addEventListener('play', () => { icon.className = 'bi bi-pause-fill'; player.classList.add('playing'); });
            audio.addEventListener('error', () => { if (audio.src) showToast('This audio cannot be played here – download it instead.', 'warning'); });
            state.audio.set(id, audio);
        }
        if (audio.paused) {
            for (const [otherId, other] of state.audio) if (otherId !== id) other.pause();
            if (audio.src) audio.play().catch((err) => console.warn('Playback failed', err));
            else audio.dataset.autoplay = '1'; // still being fetched/decrypted: starts when ready
        } else {
            audio.pause();
        }
    }

    // ----- Image modal ------------------------------------------------------
    function openImageModal(id) {
        const msg = state.messages.get(id);
        if (!msg) return;
        state.currentImageId = id;
        mediaUrl(id).then((url) => { if (state.currentImageId === id) $('imageModalImg').src = url; }).catch(() => {});
        $('imageModalImg').alt = msg.filename;
        $('imageModalTitle').textContent = msg.filename;
        $('imageModalShare').classList.toggle('d-none', !CAN_SHARE);
        $('imageModal').classList.add('show');
    }

    function closeImageModal() {
        $('imageModal').classList.remove('show');
        $('imageModalImg').removeAttribute('src');
        state.currentImageId = null;
    }

    // ======================================================================
    // Sending: text, location, files, voice
    // ======================================================================
    async function sendMessage() {
        const input = $('messageInput');
        const text = input.value.trim();
        if (!text) return;
        try {
            await ensureJoined();
            const data = await postMessage({ t: 'text', text });
            input.value = '';
            autoResize();
            receiveMessage(data.message, true);
        } catch (err) {
            showToast(`Failed to send message: ${err.message}`, 'danger');
        }
    }

    /** Text or location. With a room key the server only gets "<key id>.<iv>.<ciphertext>". */
    async function postMessage(content) {
        const body = { user_id: state.user.id };
        if (state.keys) {
            body.message_type = 'sealed';
            body.data = await C.seal(state.keys, 'msg', content);
        } else if (content.t === 'location') {
            Object.assign(body, { message_type: 'location', latitude: content.latitude, longitude: content.longitude });
        } else {
            Object.assign(body, { message_type: 'text', text: content.text });
        }
        return api(`/api/message/${encodeURIComponent(state.roomCode)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    }

    function sendLocation() {
        hideAttachMenu();
        if (!navigator.geolocation) {
            showToast('Location is not supported by this browser', 'danger');
            return;
        }
        showToast('Getting location…', 'info', 2500);
        navigator.geolocation.getCurrentPosition(async (pos) => {
            try {
                await ensureJoined();
                const data = await postMessage({ t: 'location', latitude: pos.coords.latitude, longitude: pos.coords.longitude });
                receiveMessage(data.message, true);
                showToast('Location shared!', 'success', 2500);
            } catch (err) {
                showToast(`Failed to share location: ${err.message}`, 'danger');
            }
        }, (err) => {
            showToast(err.code === 1 ? 'Location permission denied' : 'Could not get location', 'danger');
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }

    async function uploadOne(file, type, onProgress) {
        let body = file, name = file.name, query = `&message_type=${encodeURIComponent(type)}`;
        if (state.keys) {
            // Encrypt on the device. Name, type and size go along sealed; the server sees "encrypted" bytes.
            const mime = file.type || 'application/octet-stream';
            const meta = await C.seal(state.keys, 'meta', { name: file.name.slice(0, 150), type: mime, size: file.size, kind: classify(mime, type) });
            body = await C.encryptFile(state.keys, file, (fraction) => onProgress(fraction * 0.3, 'Encrypting'));
            name = 'encrypted';
            query = `&enc=1&meta=${encodeURIComponent(meta)}`;
            if (state.upload.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
        }
        const base = state.keys ? 0.3 : 0;
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            state.upload.xhr = xhr;
            const form = new FormData();
            form.append('files', body, name);
            const url = `/api/upload/${encodeURIComponent(state.roomCode)}?user_id=${encodeURIComponent(state.user.id)}${query}`;
            xhr.open('POST', url);
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(base + (1 - base) * (e.loaded / e.total)); };
            xhr.onload = () => {
                let data = null;
                try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
                if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
                const detail = data?.detail || (xhr.status === 413 ? 'file too large for the server' : `HTTP ${xhr.status}`);
                reject(new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)));
            };
            xhr.onerror = () => reject(new Error('network error'));
            xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
            xhr.send(form);
        });
    }

    async function uploadFiles(fileList, type = 'file') {
        const files = Array.from(fileList || []).filter(Boolean);
        if (!files.length) return;
        if (state.upload.active) {
            showToast('Please wait until the current upload has finished', 'warning');
            return;
        }
        const wireSize = (f) => (state.keys ? C.encryptedSize(f.size) : f.size);
        const tooLarge = files.filter((f) => wireSize(f) > MAX_FILE_SIZE);
        const empty = files.filter((f) => f.size === 0);
        const valid = files.filter((f) => f.size > 0 && wireSize(f) <= MAX_FILE_SIZE);
        tooLarge.forEach((f) => showToast(`${f.name} is too large (max ${formatSize(MAX_FILE_SIZE)})`, 'danger', 6000));
        empty.forEach((f) => showToast(`${f.name} is empty`, 'warning'));
        if (!valid.length) return;

        try { await ensureJoined(); } catch { return; }
        const total = valid.reduce((s, f) => s + f.size, 0);
        let sent = 0, ok = 0;
        const failed = [];
        state.upload = { active: true, xhr: null, cancelled: false };
        const status = $('uploadStatus');
        status.classList.remove('d-none');
        try {
            for (let i = 0; i < valid.length && !state.upload.cancelled; i++) {
                const file = valid[i];
                const label = valid.length > 1 ? `${i + 1}/${valid.length}: ${file.name}` : file.name;
                const progress = (fraction, verb = 'Uploading') => {
                    const pct = total ? Math.round(((sent + file.size * fraction) / total) * 100) : 100;
                    $('uploadStatusText').textContent = `${verb} ${label} – ${pct}%`;
                    $('uploadBarFill').style.width = `${pct}%`;
                };
                progress(0);
                try {
                    const data = await uploadOne(file, type, progress);
                    (data?.files || []).forEach((f) => receiveMessage(f.message, true));
                    ok++;
                } catch (err) {
                    if (err.cancelled) break;
                    failed.push(`${file.name}: ${err.message}`);
                }
                sent += file.size;
            }
        } finally {
            state.upload = { active: false, xhr: null, cancelled: false };
            status.classList.add('d-none');
            $('uploadBarFill').style.width = '0%';
            ['fileInput', 'photoInput', 'cameraInput'].forEach((id) => { $(id).value = ''; });
        }
        if (ok) showToast(ok === 1 ? 'Upload complete' : `${ok} files uploaded`, 'success', 2500);
        failed.forEach((f) => showToast(`Upload failed – ${f}`, 'danger', 7000));
    }

    function cancelUpload() {
        state.upload.cancelled = true;
        state.upload.xhr?.abort();
        showToast('Upload cancelled', 'warning', 2500);
    }

    // ----- Voice recording (hold to record) ---------------------------------
    function pickRecorderMime() {
        if (typeof MediaRecorder === 'undefined') return null;
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];
        return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    }

    async function startRecording(event) {
        event.preventDefault();
        const rec = state.recording;
        if (rec.recorder) return;
        rec.pressed = true;
        try { $('voiceBtn').setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
            showToast('Voice recording is not supported by this browser', 'danger');
            return;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            showToast('Microphone access denied', 'danger');
            return;
        }
        if (!rec.pressed) {
            // Released before the microphone was ready (or permission prompt): don't record.
            stream.getTracks().forEach((t) => t.stop());
            showToast('Hold the microphone button while speaking', 'info', 2500);
            return;
        }
        const mimeType = pickRecorderMime();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        recorder.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const duration = Date.now() - rec.started;
            rec.recorder = null;
            hideRecording();
            if (rec.discard || duration < 600 || !chunks.length) {
                if (!rec.discard) showToast('Recording too short', 'info', 2000);
                return;
            }
            const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
            const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const file = new File([new Blob(chunks, { type })], `voice_message_${stamp}.${ext}`, { type });
            await uploadFiles([file], 'voice');
        };
        rec.recorder = recorder;
        rec.stream = stream;
        rec.discard = false;
        rec.started = Date.now();
        recorder.start();
        showRecording();
    }

    function stopRecording(event) {
        event?.preventDefault();
        const rec = state.recording;
        rec.pressed = false;
        if (rec.recorder && rec.recorder.state === 'recording') rec.recorder.stop();
    }

    function showRecording() {
        $('recordingIndicator').classList.add('show');
        $('voiceBtn').classList.add('recording');
        const update = () => {
            const s = Math.floor((Date.now() - state.recording.started) / 1000);
            $('recordingTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        };
        update();
        state.recording.timer = setInterval(update, 500);
    }

    function hideRecording() {
        clearInterval(state.recording.timer);
        $('recordingIndicator').classList.remove('show');
        $('voiceBtn').classList.remove('recording');
    }

    // ======================================================================
    // Sharing & downloading files out of the app (single and multiple)
    // ======================================================================
    function fetchFile(id) {
        if (state.fileCache.has(id)) return state.fileCache.get(id);
        const msg = state.messages.get(id);
        const promise = fetch(downloadUrl(id)).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
        }).then(async (blob) => {
            if (msg.enc) {
                if (!state.keys) throw new Error('room key missing');
                blob = await C.decryptFile(state.keys, blob, msg.mime);
            }
            const file = new File([blob], msg.filename, { type: msg.mime || blob.type || 'application/octet-stream' });
            state.fileReady.set(id, file);
            return file;
        }).catch((err) => {
            state.fileCache.delete(id);
            throw err;
        });
        state.fileCache.set(id, promise);
        return promise;
    }

    function prefetchFiles(ids) {
        let budget = PREFETCH_LIMIT;
        for (const id of ids) {
            const msg = state.messages.get(id);
            if (!isFileMsg(msg)) continue;
            budget -= msg.size;
            if (budget < 0) break;
            fetchFile(id).catch(() => {});
        }
    }

    function textForShare(msg) {
        if (msg.type === 'text') return msg.text;
        if (msg.type === 'location') return `https://www.openstreetmap.org/?mlat=${msg.latitude}&mlon=${msg.longitude}#map=16/${msg.latitude}/${msg.longitude}`;
        return null;
    }

    // <timestamp>.txt in local time, e.g. 2026-11-09_14-03-27.txt
    function textFilename(msg) {
        const d = new Date(msg.timestamp * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.txt`;
    }

    function downloadText(msg) {
        const url = URL.createObjectURL(new Blob([textForShare(msg) + '\n'], { type: 'text/plain;charset=utf-8' }));
        triggerDownload(url, textFilename(msg));
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function downloadMessages(ids) {
        const items = domOrder(ids).map((id) => state.messages.get(id)).filter((m) => isFileMsg(m) || textForShare(m));
        if (!items.length) {
            showToast('Nothing selected to download', 'info');
            return;
        }
        if (items.length === 1) {
            const [msg] = items;
            if (!isFileMsg(msg)) downloadText(msg);
            else if (msg.enc) {
                showToast(`Decrypting ${msg.filename}…`, 'info', 2000);
                objectUrl(msg.id).then((url) => triggerDownload(url, msg.filename))
                    .catch((err) => showToast(`Download failed: ${err.message}`, 'danger'));
            } else triggerDownload(downloadUrl(msg.id), msg.filename);
            return;
        }
        if (items.some(isPrivate)) {
            // The server cannot read encrypted items, so the archive is built on this device.
            downloadLocalZip(items);
            return;
        }
        triggerDownload(zipUrl(items.map((m) => m.id)));
        showToast(`Downloading ${items.length} items as ZIP…`, 'info', 3000);
    }

    async function downloadLocalZip(items) {
        const size = items.reduce((n, m) => n + (isFileMsg(m) ? m.size : 0), 0);
        if (size > PREFETCH_LIMIT) {
            showToast(`Too large for one archive (${formatSize(size)}). Download the files one by one.`, 'warning', 6000);
            return;
        }
        showToast(`Preparing ${items.length} items…`, 'info', 3000);
        try {
            const entries = await Promise.all(items.map(async (m) => (isFileMsg(m)
                ? { name: m.filename, blob: await fetchFile(m.id) }
                : { name: textFilename(m), blob: new Blob([textForShare(m) + '\n'], { type: 'text/plain;charset=utf-8' }) })));
            const url = URL.createObjectURL(await buildZip(entries));
            const d = new Date(), p = (n) => String(n).padStart(2, '0');
            triggerDownload(url, `FileRoom-${state.roomCode}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`);
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (err) {
            showToast(`Download failed: ${err.message}`, 'danger');
        }
    }

    // ----- ZIP archive built in the browser (stored, no compression) ---------
    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return table;
    })();
    async function crc32(blob) {
        let crc = 0xFFFFFFFF;
        for (let pos = 0; pos < blob.size; pos += 4 * 1024 * 1024) {
            const bytes = new Uint8Array(await blob.slice(pos, pos + 4 * 1024 * 1024).arrayBuffer());
            for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function uniqueName(name, used) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
        let candidate = name;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
        used.add(candidate.toLowerCase());
        return candidate;
    }
    async function buildZip(entries) {
        const encoder = new TextEncoder();
        const d = new Date();
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const used = new Set(), files = [], directory = [];
        let offset = 0;
        for (const { name, blob } of entries) {
            const nameBytes = encoder.encode(uniqueName(name.replace(/[\\/]/g, '_'), used));
            const crc = await crc32(blob);
            const common = (view, at) => {             // fields shared by the local and the central header
                view.setUint16(at, 0x0800, true);      // UTF-8 file names
                view.setUint16(at + 2, 0, true);       // stored
                view.setUint16(at + 4, time, true);
                view.setUint16(at + 6, date, true);
                view.setUint32(at + 8, crc, true);
                view.setUint32(at + 12, blob.size, true);
                view.setUint32(at + 16, blob.size, true);
                view.setUint16(at + 20, nameBytes.length, true);
            };
            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            common(local, 6);
            const central = new DataView(new ArrayBuffer(46));
            central.setUint32(0, 0x02014b50, true);
            central.setUint16(4, 20, true);
            central.setUint16(6, 20, true);
            common(central, 8);
            central.setUint32(42, offset, true);
            files.push(local, nameBytes, blob);
            directory.push(central, nameBytes);
            offset += 30 + nameBytes.length + blob.size;
        }
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, directory.reduce((n, part) => n + part.byteLength, 0), true);
        end.setUint32(16, offset, true);
        return new Blob([...files, ...directory, end], { type: 'application/zip' });
    }

    function zipUrl(ids) {
        const q = new URLSearchParams({ tz: String(new Date().getTimezoneOffset()) });
        if (ids) q.set('ids', ids.join(','));
        return `/api/room/${encodeURIComponent(state.roomCode)}/zip?${q}`;
    }

    function copyMessages(ids) {
        const texts = domOrder(ids).map((id) => textForShare(state.messages.get(id))).filter(Boolean);
        if (!texts.length) {
            showToast('No text selected', 'info');
            return;
        }
        copyText(texts.join('\n\n'));
    }

    async function shareMessages(ids) {
        const msgs = domOrder(ids).map((id) => state.messages.get(id)).filter(Boolean);
        if (!msgs.length) {
            showToast('Nothing selected to share', 'info');
            return;
        }
        const fileMsgs = msgs.filter(isFileMsg);
        const text = msgs.map(textForShare).filter(Boolean).join('\n\n');

        if (!CAN_SHARE) {
            if (fileMsgs.length) downloadMessages(fileMsgs.map((m) => m.id));
            if (text) await copyText(text);
            showToast('This browser cannot share to other apps – files were downloaded instead.', 'info', 5000);
            return;
        }

        // Files must be in memory before navigator.share() is called. If they were not ready,
        // the user gesture may have expired by the time they are.
        let wasReady = fileMsgs.every((m) => state.fileReady.has(m.id));
        let files = [];
        if (fileMsgs.length) {
            if (!wasReady) showToast(`Preparing ${fileMsgs.length} file(s)…`, 'info', 2500);
            try {
                files = await Promise.all(fileMsgs.map((m) => fetchFile(m.id)));
            } catch (err) {
                showToast(`Could not load files: ${err.message}`, 'danger');
                return;
            }
        }

        let unsupported = [];
        if (files.length && navigator.canShare) {
            if (!navigator.canShare({ files })) {
                const ok = files.filter((f) => { try { return navigator.canShare({ files: [f] }); } catch { return false; } });
                unsupported = fileMsgs.filter((m, i) => !ok.includes(files[i]));
                files = ok;
            }
        } else if (files.length && !navigator.canShare) {
            unsupported = fileMsgs; // share() without canShare() never supports files
            files = [];
        }

        const data = {};
        if (files.length) data.files = files;
        if (text) data.text = text;
        if (!data.files && !data.text) {
            if (unsupported.length) {
                showToast('This browser cannot share these file types – downloading instead.', 'info', 5000);
                downloadMessages(unsupported.map((m) => m.id));
            }
            return;
        }
        try {
            await navigator.share(data);
            if (unsupported.length) {
                showToast(`${unsupported.length} file(s) of unsupported type were downloaded instead.`, 'info', 5000);
                downloadMessages(unsupported.map((m) => m.id));
            }
        } catch (err) {
            if (err.name === 'AbortError') return;
            if (err.name === 'NotAllowedError' && !wasReady) {
                showToast('Files are ready – tap Share again.', 'info', 5000);
                return;
            }
            console.warn('Share failed', err);
            showToast('Sharing failed – downloading instead.', 'warning', 4000);
            if (fileMsgs.length) downloadMessages(fileMsgs.map((m) => m.id));
            else if (text) await copyText(text);
        }
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('Copied to clipboard', 'success', 2000);
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.append(ta);
            ta.select();
            try { document.execCommand('copy'); showToast('Copied to clipboard', 'success', 2000); }
            catch { showToast('Copy failed', 'danger'); }
            ta.remove();
        }
    }

    // ----- Selection mode ---------------------------------------------------
    function setSelectMode(on) {
        state.selectMode = on;
        if (!on) state.selected.clear();
        document.querySelectorAll('.message.selected').forEach((el) => el.classList.remove('selected'));
        $('messagesContainer').classList.toggle('select-mode', on);
        $('selectModeBtn').classList.toggle('active', on);
        $('selectionBar').classList.toggle('d-none', !on);
        $('inputArea').classList.toggle('d-none', on);
        hideAttachMenu();
        updateSelectionBar();
    }

    function toggleSelected(id) {
        if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
        $(`msg-${id}`)?.classList.toggle('selected', state.selected.has(id));
        updateSelectionBar();
        prefetchFiles([...state.selected]);
    }

    function selectAll() {
        const all = state.selected.size === state.messages.size;
        state.selected = all ? new Set() : new Set(state.messages.keys());
        for (const id of state.messages.keys()) $(`msg-${id}`)?.classList.toggle('selected', state.selected.has(id));
        updateSelectionBar();
        prefetchFiles([...state.selected]);
    }

    function updateSelectionBar() {
        const n = state.selected.size;
        const files = [...state.selected].filter((id) => isFileMsg(state.messages.get(id))).length;
        $('selectionCount').textContent = n ? `${n} selected${files ? ` (${files} file${files > 1 ? 's' : ''})` : ''}` : 'Tap messages to select';
    }

    async function deleteMessages(ids) {
        const results = await Promise.allSettled(ids.map((id) => api(`/api/message/${encodeURIComponent(id)}`, { method: 'DELETE' })));
        results.forEach((r, i) => { if (r.status === 'fulfilled' || r.reason?.status === 404) removeMessage(ids[i]); });
        const failed = results.filter((r) => r.status === 'rejected' && r.reason?.status !== 404).length;
        if (failed) showToast(`${failed} message(s) could not be deleted`, 'danger');
    }

    // ======================================================================
    // Sidebar, modals, room switching, misc actions
    // ======================================================================
    function hideAttachMenu() { $('attachMenu').classList.remove('show'); }

    function openQR() {
        const url = inviteUrl();
        $('shareUrl').value = url;
        $('qrRoomCode').textContent = state.roomCode;
        // Drawn on the device: the link may contain the room key, which must not be sent to the server.
        const svg = window.FileRoomQR?.svg(url);
        $('qrImage').classList.toggle('d-none', !svg && Boolean(state.secret));
        if (svg) $('qrImage').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        else if (!state.secret) $('qrImage').src = `/api/qr?data=${encodeURIComponent(url)}`;
        $('qrHint').textContent = state.secret
            ? (svg ? 'This code and link contain the room key. Show them only to people who should be able to read along.'
                : 'The link is too long for a QR code. Share the link instead – it contains the room key.')
            : 'This room has no key: anyone who knows its name can read along.';
        $('shareUrlBtn').classList.toggle('d-none', !CAN_SHARE);
        $('qrModal').classList.add('show');
    }

    function closeKeyModal() {
        $('keyModal').classList.remove('show');
        $('keyInput').value = '';
    }

    async function submitPassword() {
        const password = $('keyInput').value.trim();
        if ([...password].length < 6) {
            showToast('Use at least 6 characters – longer is better, the room name is not a secret.', 'warning', 5000);
            return;
        }
        await setSecret(password);
        closeKeyModal();
        if (state.keys) showToast('Room key set. Devices that enter the same password can read along.', 'success', 5000);
    }

    function renderRecentRooms() {
        const recent = storage.get(RECENT_KEY, []).filter((r) => r !== state.roomCode);
        $('recentRooms').innerHTML = recent.length
            ? `<small class="text-muted">Recent rooms</small>${recent.map((r) => `<button type="button" class="recent-room" data-action="go-room" data-room="${esc(r)}"><i class="bi bi-clock-history me-2"></i>${esc(r)}</button>`).join('')}`
            : '';
    }

    function openRoomChange() {
        renderRecentRooms();
        $('roomChangeModal').classList.add('show');
        setTimeout(() => $('newRoomInput').focus(), 50);
    }

    function closeRoomChange() {
        $('roomChangeModal').classList.remove('show');
        $('newRoomInput').value = '';
    }

    function goToRoom(raw) {
        const code = normalizeRoomCode(raw);
        if (!code) {
            showToast(`Invalid room name. Use 1–${MAX_CODE_LENGTH} letters, digits, “-” or “_”.`, 'warning', 5000);
            return;
        }
        if (code === state.roomCode) { closeRoomChange(); return; }
        location.href = roomUrl(code);
    }

    function openProfile() {
        const profile = getProfile();
        $('profileName').value = profile.name || '';
        $('profilePublic').checked = profile.name ? profile.public : true;
        window.fileroomContacts?.render();
        $('profileModal').classList.add('show');
    }

    async function saveProfile() {
        const before = getProfile();
        const name = $('profileName').value.trim().slice(0, 20);
        const isPublic = Boolean(name) && $('profilePublic').checked;
        storage.set('fileroom_profile', { name, public: isPublic, mod: Date.now() });
        $('profileModal').classList.remove('show');
        try {
            if (isPublic) {
                const user = await joinRoom(name);
                showToast(`You are now ${user.name} – in this and every other room`, 'success', 3500);
            } else {
                // Stop showing the old name here, too.
                if (before.public && state.user?.name === before.name) await joinRoom(null, { anonymous: true });
                showToast(name ? `Only known devices see "${name}". Everyone else sees ${state.user?.name || 'a random name'}.`
                    : 'Anonymous: a random name in every room', 'success', 4500);
            }
            refreshData();
        } catch (err) {
            showToast(`Could not change name: ${err.message}`, 'danger');
        }
        emit('profile');
    }

    async function deleteAll() {
        if (!state.messages.size) { showToast('Nothing to delete', 'info'); return; }
        if (!confirm('Delete ALL messages and files in this room for everyone? This cannot be undone!')) return;
        try {
            const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/all`, { method: 'DELETE' });
            clearMessages();
            showToast(`Deleted ${result.count} message(s)`, 'success', 2500);
        } catch (err) {
            showToast(`Failed to delete: ${err.message}`, 'danger');
        }
    }

    // Message ids in on-screen order (the Map's insertion order differs after a sync).
    function domOrder(ids) {
        const wanted = ids ? new Set(ids) : null;
        return Array.from($('messagesContainer').querySelectorAll('.message[data-id]'), (el) => el.dataset.id)
            .filter((id) => state.messages.has(id) && (!wanted || wanted.has(id)));
    }

    function allFileIds() {
        return domOrder().filter((id) => isFileMsg(state.messages.get(id)));
    }

    function toggleSidebar(force) {
        const show = force ?? !$('sidebar').classList.contains('show');
        $('sidebar').classList.toggle('show', show);
        document.body.classList.toggle('sidebar-open', show);
    }

    function autoResize() {
        const input = $('messageInput');
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }

    // ----- Event wiring -----------------------------------------------------
    const actions = {
        'toggle-sidebar': () => toggleSidebar(),
        'toggle-attach': () => $('attachMenu').classList.toggle('show'),
        'pick-files': () => { hideAttachMenu(); $('fileInput').click(); },
        'pick-photos': () => { hideAttachMenu(); $('photoInput').click(); },
        'pick-camera': () => { hideAttachMenu(); $('cameraInput').click(); },
        'send-location': sendLocation,
        send: sendMessage,
        'cancel-upload': cancelUpload,
        'open-qr': openQR,
        'close-qr': () => $('qrModal').classList.remove('show'),
        'copy-url': () => copyText($('shareUrl').value),
        'share-url': () => navigator.share?.({ title: `FileRoom ${state.roomCode}`, url: $('shareUrl').value }).catch(() => {}),
        'open-room-change': openRoomChange,
        'close-room-change': closeRoomChange,
        'new-room': () => { location.href = `${roomUrl(randomRoomCode())}?new=1`; },
        'go-room': (el) => goToRoom(el.dataset.room),
        'change-name': openProfile,
        'close-profile': () => $('profileModal').classList.remove('show'),
        'delete-all': deleteAll,
        'download-all': () => {
            if (!state.messages.size) return showToast('Nothing in this room', 'info');
            downloadMessages(domOrder());
        },
        'load-media': (el) => loadMedia(el.dataset.id),
        'open-key': () => { updateKeyUi(); $('voiceModal')?.classList.remove('show'); $('keyModal').classList.add('show'); },
        'close-key': closeKeyModal,
        'copy-invite': () => copyText(inviteUrl()),
        'key-random': async () => {
            if (state.keys && !confirm('Replace the room key? Devices that have the old key must open the new invite link, and older encrypted messages become unreadable.')) return;
            await setSecret(C.randomSecret());
            closeKeyModal();
            if (state.keys) openQR();
        },
        'key-remove': async () => {
            if (!confirm('Remove the room key from this device? Encrypted messages become unreadable here and new messages are sent unencrypted.')) return;
            await setSecret(null);
            closeKeyModal();
        },
        'share-all': () => {
            const ids = allFileIds();
            if (!ids.length) return showToast('No files in this room', 'info');
            shareMessages(ids);
        },
        'open-image': (el) => openImageModal(el.dataset.id),
        'close-image': closeImageModal,
        'toggle-voice': (el) => toggleVoice(el.dataset.id),
        'share-msg': (el) => shareMessages([el.dataset.id]),
        'download-msg': (el) => downloadMessages([el.dataset.id]),
        'copy-msg': (el) => copyMessages([el.dataset.id]),
        'copy-selected': () => copyMessages([...state.selected]),
        'delete-msg': (el) => deleteMessages([el.dataset.id]),
        'toggle-select': () => setSelectMode(!state.selectMode),
        'select-all': selectAll,
        'share-selected': () => shareMessages([...state.selected]),
        'download-selected': () => downloadMessages([...state.selected]),
        'delete-selected': async () => {
            const ids = [...state.selected];
            if (!ids.length) return showToast('Nothing selected', 'info');
            if (!confirm(`Delete ${ids.length} message(s) for everyone?`)) return;
            await deleteMessages(ids);
            updateSelectionBar();
        },
    };

    function wireEvents() {
        document.addEventListener('click', (e) => {
            // In selection mode a tap on a message toggles it instead of triggering its controls.
            if (state.selectMode) {
                const msgEl = e.target.closest('.message');
                if (msgEl && $('messagesContainer').contains(msgEl)) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelected(msgEl.dataset.id);
                    return;
                }
            }
            const el = e.target.closest('[data-action]');
            if (el && actions[el.dataset.action]) {
                e.preventDefault();
                actions[el.dataset.action](el, e);
            }
            const menu = $('attachMenu');
            if (menu.classList.contains('show') && !e.target.closest('#attachMenu') && !e.target.closest('[data-action="toggle-attach"]')) {
                hideAttachMenu();
            }
        }, true);

        $('imageModalDownload').addEventListener('click', () => state.currentImageId && downloadMessages([state.currentImageId]));
        $('imageModalShare').addEventListener('click', () => state.currentImageId && shareMessages([state.currentImageId]));
        $('imageModalShare').addEventListener('pointerdown', () => state.currentImageId && fetchFile(state.currentImageId).catch(() => {}));

        // Start loading a file as soon as the share button is touched so it is ready on release.
        document.addEventListener('pointerdown', (e) => {
            const btn = e.target.closest('[data-action="share-msg"]');
            if (btn && isFileMsg(state.messages.get(btn.dataset.id))) fetchFile(btn.dataset.id).catch(() => {});
        });

        $('fileInput').addEventListener('change', (e) => uploadFiles(e.target.files, 'file'));
        $('photoInput').addEventListener('change', (e) => uploadFiles(e.target.files, 'image'));
        $('cameraInput').addEventListener('change', (e) => uploadFiles(e.target.files, 'image'));

        const input = $('messageInput');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sendMessage();
            }
        });
        input.addEventListener('input', autoResize);

        const voice = $('voiceBtn');
        voice.addEventListener('pointerdown', startRecording);
        voice.addEventListener('pointerup', stopRecording);
        voice.addEventListener('pointercancel', (e) => { state.recording.discard = true; stopRecording(e); });
        voice.addEventListener('contextmenu', (e) => e.preventDefault());

        $('roomChangeForm').addEventListener('submit', (e) => { e.preventDefault(); goToRoom($('newRoomInput').value); });
        $('keyForm').addEventListener('submit', (e) => { e.preventDefault(); submitPassword(); });
        $('profileForm').addEventListener('submit', (e) => { e.preventDefault(); saveProfile(); });
        // Opening another invite link for this room in the same tab only changes the fragment.
        window.addEventListener('hashchange', () => {
            const secret = secretFromHash();
            if (secret && secret !== state.secret) setSecret(secret);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            closeImageModal();
            $('qrModal').classList.remove('show');
            closeRoomChange();
            closeKeyModal();
            $('profileModal').classList.remove('show');
            toggleSidebar(false);
            if (state.selectMode) setSelectMode(false);
        });
        for (const id of ['qrModal', 'roomChangeModal', 'keyModal', 'profileModal']) {
            $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
        }

        const container = $('messagesContainer');
        container.addEventListener('scroll', () => {
            stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        }, { passive: true });

        // Drag & drop of any number of files
        const main = $('mainChat');
        let dragDepth = 0;
        const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
        document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; main.classList.add('drag-over'); });
        document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) main.classList.remove('drag-over'); });
        document.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth = 0;
            main.classList.remove('drag-over');
            uploadFiles(e.dataTransfer.files, 'file');
        });

        // Paste files / screenshots
        document.addEventListener('paste', (e) => {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length) {
                e.preventDefault();
                uploadFiles(files, 'file');
            }
        });

        // Reconnect quickly when the app comes back to the foreground or the network returns.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (!state.ws || state.ws.readyState > WebSocket.OPEN) { state.reconnectDelay = 1000; scheduleReconnect(true); }
            else refreshData();
        });
        window.addEventListener('online', () => { state.reconnectDelay = 1000; scheduleReconnect(true); });
        window.addEventListener('pageshow', (e) => { if (e.persisted) scheduleReconnect(true); });

        // Fallback heartbeat (keeps presence while the socket is down/blocked)
        setInterval(() => {
            if (state.user && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
                fetch(`/api/heartbeat/${encodeURIComponent(state.user.id)}`, { method: 'POST' }).catch(() => {});
            }
        }, 30000);
        setInterval(tickTimers, 1000);
    }

    // Used by pwa.js before restarting for an update.
    window.fileroomBusy = () => state.upload.active || Boolean(state.recording.recorder) || Boolean(window.fileroomVoice?.active());

    // Interface for voice.js (calls and babyphone). Everything it sends through sendSignal() is an
    // opaque string for the server, which passes it to one device (`to`) or to all others in the room.
    window.fileroom = {
        get roomCode() { return state.roomCode; },
        get user() { return state.user; },
        get users() { return state.users; },
        get keys() { return state.keys; },
        get secret() { return state.secret; },                 // for handing the key to a known device (contacts.js)
        get profile() { return getProfile(); },
        setSecret: (secret) => setSecret(secret),
        renderUsers: () => updateUsersList(state.users),
        get ready() { return state.ready; },
        get online() { return state.ws?.readyState === WebSocket.OPEN; },
        esc, serverNow, api, showToast, storage, ensureJoined, on, actions, inviteUrl,
        sendSignal(to, data) {
            if (state.ws?.readyState !== WebSocket.OPEN) return false;
            state.ws.send(JSON.stringify({ type: 'signal', to: to || null, data }));
            return true;
        },
    };
    window.addEventListener('beforeunload', (e) => {
        if (state.upload.active) { e.preventDefault(); e.returnValue = ''; }
    });

    // ======================================================================
    // Start
    // ======================================================================
    /** Content shared into FileRoom from another app, kept on this device by the service worker. */
    async function sendPendingShare() {
        const share = await window.FileRoomShareStore?.get();
        if (!share) return;
        await window.FileRoomShareStore.clear(); // taken: a reload must not send it twice
        try {
            await ensureJoined();
            if (share.combinedText) {
                const data = await postMessage({ t: 'text', text: share.combinedText.slice(0, 20000) });
                receiveMessage(data.message, true);
            }
            if (share.files.length) await uploadFiles(share.files);
            else showToast('Shared', 'success', 2000);
        } catch (err) {
            showToast(`Sharing failed: ${err.message}`, 'danger', 6000);
        }
    }

    async function start() {
        resolveRoomCode();
        wireEvents();
        const pendingShare = new URLSearchParams(location.search).get('share') === 'local';
        await initKey(); // before the first message is decoded or sent
        if (pendingShare) sendPendingShare();
        handleUrlNotices();
        updateEmptyState();
        refreshData();
        connect();
        ensureJoined().then(() => { state.ready = true; emit('ready'); }).catch(() => {});
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
