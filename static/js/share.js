/* Share target landing page: lets the user pick the room that receives the shared text/links/files. */
(() => {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('share') || '';
    // "local": the service worker kept the shared content on this device (IndexedDB). It is handed to
    // the room page, which encrypts it with the room key. Anything else is a server-side share session.
    const LOCAL = sessionId === 'local';
    const DEBUG = params.has('debug');
    const MAX_CODE_LENGTH = parseInt(document.querySelector('meta[name="max-room-code-length"]')?.content || '64', 10);
    const RECENT_KEY = 'fileroom_recent_rooms';
    let busy = false;
    let shareData = null;

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const storage = {
        get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
    };
    const roomUrl = (code) => `/room/${encodeURIComponent(code)}`;

    function log(...args) {
        console.log('[share]', ...args);
        if (!DEBUG) return;
        $('debugPanel').hidden = false;
        const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        $('debugConsole').textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
    }

    function normalizeRoomCode(raw) {
        if (raw == null) return null;
        const code = String(raw).normalize('NFC').trim().replace(/\s+/g, '-').toUpperCase();
        if (!code || [...code].length > MAX_CODE_LENGTH || !/^[\p{L}\p{N}_-]+$/u.test(code)) return null;
        return code;
    }

    function randomRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => chars[b % chars.length]).join('');
    }

    function formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function showStatus(message, type = 'info') {
        const el = $('status');
        el.textContent = message;
        el.className = type === 'error' ? 'status-error' : type === 'success' ? 'status-success' : 'status-info';
        log(type, message);
    }

    function addProgress(message, type = 'info') {
        const item = document.createElement('div');
        item.className = `progress-item ${type}`;
        const icon = document.createElement('i');
        icon.className = `bi bi-${type === 'success' ? 'check-circle' : type === 'error' ? 'x-circle' : 'arrow-right'}`;
        item.append(icon, document.createTextNode(message));
        $('progressList').append(item);
        $('uploadProgress').classList.add('show');
    }

    function setBusy(on) {
        busy = on;
        document.querySelectorAll('#shareChoices button, #shareChoices input').forEach((el) => { el.disabled = on; });
    }

    async function api(url, options) {
        const res = await fetch(url, options);
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res.ok) {
            const err = new Error(data?.detail || data?.warning || `HTTP ${res.status}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    async function loadShareData() {
        if (!sessionId) {
            showStatus('Invalid share session. Please share again.', 'error');
            $('shareInfo').textContent = 'Nothing to share.';
            setBusy(true);
            return;
        }
        try {
            if (LOCAL) {
                const share = await window.FileRoomShareStore.get();
                if (!share) throw Object.assign(new Error('nothing pending'), { status: 404 });
                const kind = (f) => (f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'voice' : 'file');
                shareData = { files: share.files.map((f) => ({ name: f.name, size: f.size, type: kind(f) })), combined_text: share.combinedText };
            } else {
                shareData = await api(`/api/share/${encodeURIComponent(sessionId)}`);
            }
            log('share data', shareData);
            const parts = [];
            const files = shareData.files || [];
            if (files.length) {
                const total = files.reduce((s, f) => s + f.size, 0);
                parts.push(`<div class="share-summary"><i class="bi bi-files"></i> <strong>${files.length} file${files.length > 1 ? 's' : ''}</strong> (${formatSize(total)})</div>`);
                parts.push(`<ul class="share-file-list">${files.map((f) => `<li><i class="bi ${f.type === 'image' ? 'bi-image' : f.type === 'video' ? 'bi-film' : f.type === 'voice' ? 'bi-music-note' : 'bi-file-earmark'}"></i><span class="name">${esc(f.name)}</span><span class="size">${formatSize(f.size)}</span></li>`).join('')}</ul>`);
            }
            if (shareData.combined_text) {
                const t = shareData.combined_text;
                parts.push(`<div class="share-text"><i class="bi bi-chat-text"></i> ${esc(t.length > 300 ? `${t.slice(0, 300)}…` : t)}</div>`);
            }
            if (shareData.skipped?.length) {
                parts.push(`<div class="share-warning"><i class="bi bi-exclamation-triangle"></i> Skipped (empty or too large): ${esc(shareData.skipped.join(', '))}</div>`);
            }
            $('shareInfo').innerHTML = parts.join('') || 'Nothing to share.';
            renderRecentRooms();
        } catch (err) {
            log('load failed', err.message);
            showStatus(err.status === 404 || err.status === 410 ? 'This share has expired or was already sent. Please share again.' : `Could not load the shared content: ${err.message}`, 'error');
            $('shareInfo').innerHTML = '<i class="bi bi-exclamation-triangle"></i> Share session not available';
            setBusy(true);
            $('cancelBtn').disabled = false;
            $('cancelBtn').textContent = 'Open FileRoom';
        }
    }

    function renderRecentRooms() {
        const recent = storage.get(RECENT_KEY, []).filter((r) => normalizeRoomCode(r));
        if (!recent.length) return;
        $('recentRoomsList').innerHTML = recent.map((code, i) => `
            <button type="button" class="recent-room-item${i === 0 ? ' primary' : ''}" data-room="${esc(code)}">
                <span><i class="bi ${i === 0 ? 'bi-send' : 'bi-clock-history'} me-2"></i>${esc(code)}</span>
                <i class="bi bi-arrow-right"></i>
            </button>`).join('');
        $('recentRoomsContainer').hidden = false;
    }

    async function sendToRoom(rawCode) {
        if (busy) return;
        const code = normalizeRoomCode(rawCode);
        if (!code) {
            showStatus(`Invalid room name. Use 1–${MAX_CODE_LENGTH} letters, digits, “-” or “_”.`, 'error');
            return;
        }
        setBusy(true);
        $('progressList').textContent = '';
        showStatus(`Sending to ${code}…`);
        if (LOCAL) {
            // The room page takes it from here: it knows the room key and encrypts before uploading.
            const isNew = !storage.get(RECENT_KEY, []).includes(code) && !storage.get(`fileroom_user_${code}`, null);
            location.replace(`${roomUrl(code)}?share=local${isNew ? '&new=1' : ''}`);
            return;
        }
        try {
            const key = `fileroom_user_${code}`;
            const stored = storage.get(key, null);
            const q = new URLSearchParams();
            if (stored?.id) q.set('user_id', stored.id);
            if (stored?.name) q.set('user_name', stored.name);
            addProgress(`Joining room ${code}…`);
            const join = await api(`/api/join/${encodeURIComponent(code)}?${q}`);
            const room = join.room_code || code;
            storage.set(`fileroom_user_${room}`, { id: join.user_id, name: join.user_name });
            addProgress(`Joined as ${join.user_name}`, 'success');

            const fileCount = shareData?.files?.length || 0;
            addProgress(fileCount ? `Moving ${fileCount} file(s) into the room…` : 'Posting shared content…');
            const result = await api(`/api/share/${encodeURIComponent(sessionId)}/upload/${encodeURIComponent(room)}?user_id=${encodeURIComponent(join.user_id)}`, { method: 'POST' });
            log('upload result', result);
            if (result.uploaded_files) addProgress(`Shared ${result.uploaded_files} file(s)`, 'success');
            if (result.warning) addProgress(result.warning, 'error');

            const recent = storage.get(RECENT_KEY, []).filter((r) => r !== room);
            recent.unshift(room);
            storage.set(RECENT_KEY, recent.slice(0, 8));
            showStatus(`✓ Shared ${result.uploaded.length} item(s) to ${room}`, 'success');
            setTimeout(() => location.replace(roomUrl(room)), result.warning ? 1800 : 600);
        } catch (err) {
            log('send failed', err.message);
            const expired = err.status === 404 || err.status === 410;
            showStatus(expired ? 'This share has expired or was already sent. Please share again.' : `Failed: ${err.message}`, 'error');
            addProgress(err.message, 'error');
            if (!expired) setBusy(false);
            else { $('cancelBtn').disabled = false; $('cancelBtn').textContent = 'Open FileRoom'; }
        }
    }

    // ----- Send to people: known devices (contacts.js) that can be invited by push -------------
    // The content goes into a new room; everybody ticked is invited to it once the room page is open.
    const ticked = new Set();
    let people = [];
    function loadPeople() {
        return new Promise((resolve) => {
            let request;
            try { request = indexedDB.open('fileroom-identity', 1); } catch { resolve([]); return; }
            request.onupgradeneeded = () => { // same layout as contacts.js creates
                request.result.createObjectStore('self');
                request.result.createObjectStore('contacts', { keyPath: 'id' });
            };
            request.onerror = () => resolve([]);
            request.onsuccess = () => {
                const db = request.result;
                try {
                    const all = db.transaction('contacts', 'readonly').objectStore('contacts').getAll();
                    all.onsuccess = () => { db.close(); resolve(all.result || []); };
                    all.onerror = () => { db.close(); resolve([]); };
                } catch { db.close(); resolve([]); }
            };
        });
    }
    function renderPeople() {
        const groups = (storage.get('fileroom_groups', []) || []).map((g) => ({ ...g, members: (g.members || []).filter((id) => people.some((p) => p.id === id)) })).filter((g) => g.members.length);
        $('sharePeopleGroups').innerHTML = groups.map((g) => `<span class="people-group${g.members.every((id) => ticked.has(id)) ? ' on' : ''}">
            <button type="button" data-group="${esc(g.id)}"><i class="bi bi-people-fill"></i> ${esc(g.name)} (${g.members.length})</button></span>`).join('');
        $('sharePeopleList').innerHTML = people.map((p) => `<li><label><input type="checkbox" data-contact="${esc(p.id)}"${ticked.has(p.id) ? ' checked' : ''}>
            <span>${p.fav ? '<i class="bi bi-star-fill"></i> ' : ''}${esc(p.alias || p.name || 'Unnamed device')}</span></label></li>`).join('');
        $('sharePeopleBtn').disabled = !ticked.size;
        $('sharePeople').hidden = !people.length;
    }
    loadPeople().then((list) => {
        people = list.filter((p) => p.push || Object.keys(p.pushes || {}).length).sort((a, b) => (Number(Boolean(b.fav)) - Number(Boolean(a.fav))) || ((b.last || 0) - (a.last || 0))).slice(0, 30);
        renderPeople();
    });
    $('sharePeopleList').addEventListener('change', (e) => {
        const id = e.target.dataset?.contact;
        if (!id) return;
        if (e.target.checked) ticked.add(id); else ticked.delete(id);
        renderPeople();
    });
    $('sharePeopleGroups').addEventListener('click', (e) => {
        const id = e.target.closest('[data-group]')?.dataset.group;
        const group = (storage.get('fileroom_groups', []) || []).find((g) => g.id === id);
        if (!group) return;
        const members = group.members.filter((m) => people.some((p) => p.id === m));
        const all = members.every((m) => ticked.has(m));
        for (const m of members) { if (all) ticked.delete(m); else ticked.add(m); }
        renderPeople();
    });
    $('sharePeopleBtn').addEventListener('click', () => {
        if (!ticked.size) return;
        storage.set('fileroom_invite_after', { ids: [...ticked], at: Date.now() });
        sendToRoom(randomRoomCode());
    });

    $('joinForm').addEventListener('submit', (e) => { e.preventDefault(); sendToRoom($('roomCodeInput').value); });
    $('newRoomBtn').addEventListener('click', () => sendToRoom(randomRoomCode()));
    $('recentRoomsList').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-room]');
        if (btn) sendToRoom(btn.dataset.room);
    });
    $('cancelBtn').addEventListener('click', async () => {
        if (LOCAL) await window.FileRoomShareStore.clear();
        else if (sessionId && shareData) {
            try { await fetch(`/api/share/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch { /* ignore */ }
        }
        const recent = storage.get(RECENT_KEY, []);
        location.replace(recent[0] ? roomUrl(recent[0]) : '/');
    });

    log('session', sessionId, navigator.userAgent);
    loadShareData();
})();
