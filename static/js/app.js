/**
 * FileRoom chat client.
 * The room page is a static app shell (cached by the service worker); the room code comes from the URL
 * and all content is loaded from the API / WebSocket.
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

    const $ = (id) => document.getElementById(id);
    const state = {
        roomCode: null,
        user: null,
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
        if (params.has('shareError') || params.has('source')) {
            history.replaceState(null, '', roomUrl(state.roomCode) + location.hash);
        }
    }

    // ======================================================================
    // User & connection
    // ======================================================================
    function userKey() { return `fileroom_user_${state.roomCode}`; }

    async function joinRoom(newName) {
        const stored = storage.get(userKey());
        const params = new URLSearchParams();
        if (stored?.id) params.set('user_id', stored.id);
        const name = newName || stored?.name;
        if (name) params.set('user_name', name);
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
                addMessage(data.message, true);
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
                break;
        }
    }

    async function refreshData() {
        try {
            const data = await api(`/api/room/${encodeURIComponent(state.roomCode)}/data`);
            state.clockOffset = data.server_time - Date.now() / 1000;
            updateUsersList(data.users);
            syncMessages(data.messages);
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
        if (!users.length) {
            container.innerHTML = '<div class="text-muted small">No users</div>';
            return;
        }
        container.innerHTML = users.map((u) => {
            const me = state.user && u.id === state.user.id;
            return `<div class="user-item ${me ? 'current' : ''}"><div class="user-status"></div>${esc(u.name)}${me ? ' (you)' : ''}</div>`;
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

    function messageBody(msg) {
        const id = esc(msg.id);
        const src = esc(downloadUrl(msg.id));
        const name = esc(msg.filename);
        switch (msg.type) {
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
                return `<button type="button" class="image-preview" data-action="open-image" data-id="${id}" title="${name}">
                        <img src="${src}" alt="${name}" loading="lazy">
                        <span class="image-overlay"><i class="bi bi-arrows-fullscreen"></i><span>View</span></span>
                    </button>
                    <div class="file-caption">${name} · ${formatSize(msg.size)}</div>`;
            case 'video':
                return `<video class="video-preview" controls preload="metadata" playsinline src="${src}"></video>
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
                            <a class="file-name" href="${src}" download="${name}">${name}</a>
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
        if (CAN_SHARE) actions.push(actionButton('share-msg', 'bi-share', 'Share', msg.id));
        if (isFileMsg(msg)) actions.push(actionButton('download-msg', 'bi-download', 'Download', msg.id));
        if (msg.type === 'text' || msg.type === 'location') {
            actions.push(actionButton('copy-msg', 'bi-clipboard', 'Copy to clipboard', msg.id));
            actions.push(actionButton('download-msg', 'bi-download', 'Download as .txt', msg.id));
        }
        actions.push(actionButton('delete-msg', 'bi-trash', 'Delete', msg.id));
        el.innerHTML = `
            <span class="select-check" aria-hidden="true"><i class="bi bi-check-lg"></i></span>
            <div class="message-header">
                <span class="message-user">${esc(msg.username)}</span>
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
            audio = new Audio(downloadUrl(id));
            audio.preload = 'metadata';
            audio.addEventListener('loadedmetadata', () => { timeEl.textContent = formatAudioTime(audio.duration); });
            audio.addEventListener('timeupdate', () => { timeEl.textContent = formatAudioTime(audio.currentTime); });
            audio.addEventListener('ended', () => {
                icon.className = 'bi bi-play-fill';
                player.classList.remove('playing');
                timeEl.textContent = formatAudioTime(audio.duration);
            });
            audio.addEventListener('pause', () => { icon.className = 'bi bi-play-fill'; player.classList.remove('playing'); });
            audio.addEventListener('play', () => { icon.className = 'bi bi-pause-fill'; player.classList.add('playing'); });
            audio.addEventListener('error', () => showToast('This audio cannot be played here – download it instead.', 'warning'));
            state.audio.set(id, audio);
        }
        if (audio.paused) {
            for (const [otherId, other] of state.audio) if (otherId !== id) other.pause();
            audio.play().catch((err) => console.warn('Playback failed', err));
        } else {
            audio.pause();
        }
    }

    // ----- Image modal ------------------------------------------------------
    function openImageModal(id) {
        const msg = state.messages.get(id);
        if (!msg) return;
        state.currentImageId = id;
        $('imageModalImg').src = downloadUrl(id);
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
            const data = await api(`/api/message/${encodeURIComponent(state.roomCode)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, user_id: state.user.id, message_type: 'text' }),
            });
            input.value = '';
            autoResize();
            addMessage(data.message, true);
        } catch (err) {
            showToast(`Failed to send message: ${err.message}`, 'danger');
        }
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
                const data = await api(`/api/message/${encodeURIComponent(state.roomCode)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: state.user.id, message_type: 'location',
                        latitude: pos.coords.latitude, longitude: pos.coords.longitude,
                    }),
                });
                addMessage(data.message, true);
                showToast('Location shared!', 'success', 2500);
            } catch (err) {
                showToast(`Failed to share location: ${err.message}`, 'danger');
            }
        }, (err) => {
            showToast(err.code === 1 ? 'Location permission denied' : 'Could not get location', 'danger');
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }

    function uploadOne(file, type, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            state.upload.xhr = xhr;
            const form = new FormData();
            form.append('files', file, file.name);
            const url = `/api/upload/${encodeURIComponent(state.roomCode)}?user_id=${encodeURIComponent(state.user.id)}&message_type=${encodeURIComponent(type)}`;
            xhr.open('POST', url);
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
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
        const tooLarge = files.filter((f) => f.size > MAX_FILE_SIZE);
        const empty = files.filter((f) => f.size === 0);
        const valid = files.filter((f) => f.size > 0 && f.size <= MAX_FILE_SIZE);
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
                const label = valid.length > 1 ? `Uploading ${i + 1}/${valid.length}: ${file.name}` : `Uploading ${file.name}`;
                const progress = (fraction) => {
                    const pct = total ? Math.round(((sent + file.size * fraction) / total) * 100) : 100;
                    $('uploadStatusText').textContent = `${label} – ${pct}%`;
                    $('uploadBarFill').style.width = `${pct}%`;
                };
                progress(0);
                try {
                    const data = await uploadOne(file, type, progress);
                    (data?.files || []).forEach((f) => addMessage(f.message, true));
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
        }).then((blob) => {
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
            if (isFileMsg(msg)) triggerDownload(downloadUrl(msg.id), msg.filename);
            else downloadText(msg);
            return;
        }
        triggerDownload(zipUrl(items.map((m) => m.id)));
        showToast(`Downloading ${items.length} items as ZIP…`, 'info', 3000);
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
        const url = location.origin + roomUrl(state.roomCode);
        $('shareUrl').value = url;
        $('qrRoomCode').textContent = state.roomCode;
        $('qrImage').src = `/api/qr?data=${encodeURIComponent(url)}`;
        $('shareUrlBtn').classList.toggle('d-none', !CAN_SHARE);
        $('qrModal').classList.add('show');
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

    async function changeName() {
        const name = prompt('Enter your name:', state.user?.name || '');
        if (!name || !name.trim()) return;
        try {
            const user = await joinRoom(name.trim());
            showToast(`You are now ${user.name}`, 'success', 2500);
            refreshData();
        } catch (err) {
            showToast(`Could not change name: ${err.message}`, 'danger');
        }
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
        'new-room': () => { location.href = roomUrl(randomRoomCode()); },
        'go-room': (el) => goToRoom(el.dataset.room),
        'change-name': changeName,
        'delete-all': deleteAll,
        'download-all': () => {
            if (!state.messages.size) return showToast('Nothing in this room', 'info');
            triggerDownload(zipUrl());
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

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            closeImageModal();
            $('qrModal').classList.remove('show');
            closeRoomChange();
            toggleSidebar(false);
            if (state.selectMode) setSelectMode(false);
        });
        for (const id of ['qrModal', 'roomChangeModal']) {
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
    window.fileroomBusy = () => state.upload.active || Boolean(state.recording.recorder);
    window.addEventListener('beforeunload', (e) => {
        if (state.upload.active) { e.preventDefault(); e.returnValue = ''; }
    });

    // ======================================================================
    // Start
    // ======================================================================
    function start() {
        resolveRoomCode();
        wireEvents();
        handleUrlNotices();
        updateEmptyState();
        refreshData();
        connect();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
