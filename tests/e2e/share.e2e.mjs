// Share target without the server: the service worker parks the share, the room page sends it encrypted.
//   NODE_PATH=$(npm root -g) node tests/e2e/share.e2e.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
// --- service worker part: parse the shared form and park it
const sw = readFileSync(root + '/pwa/sw.template.js', 'utf8');
const src = sw.slice(sw.indexOf('async function keepShare'));
let stored = null;
const keepShare = new Function('storeShare', 'Response', src + '; return keepShare;')(async (s) => { stored = s; }, { redirect: (url, status) => ({ url, status }) });
const form = new FormData();
form.set('title', 'Holiday'); form.set('text', 'Look'); form.set('url', 'https://x.example/p');
form.append('files', new File(['JPEG'], 'pic.jpg', { type: 'image/jpeg' })); form.append('files', new File([], 'empty.bin'));
let r = await keepShare(new Request('https://f.example/share', { method: 'POST', body: form }));
if (r.url !== '/?share=local' || stored.files.length !== 1 || stored.title !== 'Holiday') throw new Error('keepShare ' + JSON.stringify(r));
r = await keepShare(new Request('https://f.example/share', { method: 'POST', body: new FormData() }));
if (r.url !== '/?shareError=empty') throw new Error('empty share');
console.log('service worker keeps shares on the device: ok');

// --- page part
const { chromium } = require('playwright');
const { startMockServer } = await import(root + '/tests/e2e/mock-server.mjs');
const mock = await startMockServer();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${mock.url}/?share=local`);
await page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('fileroom-share', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('pending');
  open.onsuccess = () => { const tx = open.result.transaction('pending', 'readwrite');
    tx.objectStore('pending').put({ created: Date.now(), title: 'Holiday', text: 'Look at these', url: 'https://x.example/p',
      files: [new File(['SECRET-PIXELS'], 'pic.txt', { type: 'text/plain' })] }, 'share');
    tx.oncomplete = resolve; tx.onerror = reject; };
}));
await page.reload();
await page.waitForFunction(() => document.querySelector('#shareInfo')?.textContent.includes('pic.txt'));
console.log('share page lists the local share:', (await page.textContent('#shareInfo')).replace(/\s+/g, ' ').trim().slice(0, 90));
await page.click('#newRoomBtn');
await page.waitForFunction(() => window.fileroom?.ready && document.querySelectorAll('.message').length === 2, null, { timeout: 15000 });
const state = await page.evaluate(async () => ({ keys: Boolean(window.fileroom.keys), search: location.search, hash: location.hash.slice(0, 3),
  text: document.querySelector('.message.text .message-text, .message.text')?.textContent.includes('Look at these'),
  locks: document.querySelectorAll('.msg-lock').length, pending: await window.FileRoomShareStore.get() }));
console.log(JSON.stringify(state), 'errors', errors);
const room = await page.evaluate(() => window.fileroom.roomCode);
const res = await (await fetch(`${mock.url}/api/room/${room}/data`)).json();
console.log('server sees:', res.messages.map((m) => `${m.type}${m.enc ? '(enc)' : ''}:${m.filename || ''}`).join(', '));
if (!state.keys || state.search || state.locks !== 2 || state.pending || res.messages.some((m) => m.type === 'text' || (m.type === 'file' && !m.enc))) throw new Error('share was not encrypted');
await page.reload();
await page.waitForFunction(() => window.fileroom?.ready);
await page.waitForTimeout(800);
if (await page.locator('.message').count() !== 2) throw new Error('share sent twice');
console.log('local share check passed');
await browser.close(); await mock.close();
