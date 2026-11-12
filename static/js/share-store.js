/**
 * Content shared into FileRoom from another app ("Share" sheet).
 *
 * The service worker catches the share before it leaves the phone and parks it here (IndexedDB).
 * The share page shows it, the room page then sends it like anything else typed or attached there:
 * encrypted with the room key if the room has one. The server never sees a share in transit.
 * (The service worker has its own copy of put(); keep DB/STORE/KEY in sync with pwa/sw.template.js.)
 */
(() => {
    'use strict';
    const DB = 'fileroom-share', STORE = 'pending', KEY = 'share';
    const MAX_AGE = 15 * 60 * 1000;

    function open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function run(mode, action) {
        const db = await open();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const request = action(tx.objectStore(STORE));
                tx.oncomplete = () => resolve(request?.result);
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    }

    /** One message text from title, text and link, without repeating what is already contained. */
    function combinedText({ title, text, url }) {
        const parts = [];
        if (title && !(text || '').includes(title) && title !== url) parts.push(title);
        if (text) parts.push(text);
        if (url && !(text || '').includes(url)) parts.push(url);
        return parts.join('\n').trim() || null;
    }

    window.FileRoomShareStore = {
        /** -> { title, text, url, files: File[], created, combinedText } or null (nothing pending / expired) */
        async get() {
            const share = await run('readonly', (store) => store.get(KEY)).catch(() => null);
            if (!share || Date.now() - share.created > MAX_AGE) {
                if (share) await this.clear();
                return null;
            }
            return { ...share, files: (share.files || []).filter((f) => f instanceof Blob), combinedText: combinedText(share) };
        },
        clear() {
            return run('readwrite', (store) => store.delete(KEY)).catch(() => {});
        },
    };
})();
