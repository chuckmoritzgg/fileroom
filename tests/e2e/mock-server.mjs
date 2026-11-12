/**
 * Stand-in for main.py, used by the browser tests when no real FileRoom server is given.
 * It implements the routes the room page needs with the same behaviour as the Python server
 * (in particular the WebSocket signaling relay) and records what the "server" gets to see,
 * so the tests can assert that it only ever sees ciphertext.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.html': 'text/html' };
const id = () => crypto.randomBytes(9).toString('base64url');

export async function startMockServer() {
  const users = new Map();       // id -> {id, name, room}
  const messages = new Map();    // id -> message (+ body for files)
  const sockets = new Map();     // room -> Map(userId -> Set(ws))
  const seen = { signals: [], pushes: [], bodies: [] };
  const shell = readFileSync(path.join(ROOT, 'templates/room.html'), 'utf8')
    .replaceAll('{{ build }}', 'testbuild0000000').replaceAll('{{ version }}', 'test')
    .replaceAll('{{ max_file_size }}', String(100 * 1024 * 1024)).replaceAll('{{ max_room_code_length }}', '64');

  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const publicMessage = (m) => { const { body, ...rest } = m; return { ...rest, time_remaining: 3600 }; };
  const broadcast = (room, payload) => {
    for (const set of sockets.get(room)?.values() || []) for (const ws of set) ws.send(JSON.stringify(payload));
  };
  const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
  const newMessage = (room, userId, type, fields) => {
    const now = Date.now() / 1000;
    const m = { id: id(), type, username: users.get(userId)?.name || 'Anonymous', user_id: userId, timestamp: now, expires_at: now + 3600, ...fields };
    messages.set(m.id, { ...m, room });
    broadcast(room, { type: 'new_message', message: publicMessage(m) });
    return m;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] === 'room' && parts[1]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(shell); }
      if (parts[0] === 'static') {
        const file = path.join(ROOT, 'static', ...parts.slice(1));
        if (!file.startsWith(path.join(ROOT, 'static')) || !existsSync(file)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        return res.end(readFileSync(file));
      }
      if (parts[0] === 'api' && parts[1] === 'join') {
        const room = parts[2].toUpperCase();
        let user = users.get(url.searchParams.get('user_id') || '');
        if (!user || user.room !== room) {
          user = { id: id(), name: url.searchParams.get('user_name') || `User${users.size + 1}`, room };
          users.set(user.id, user);
        } else if (url.searchParams.get('anon')) user.name = `Anon${Math.floor(Math.random() * 9000 + 1000)}`;
        else if (url.searchParams.get('user_name')) user.name = url.searchParams.get('user_name');
        return json(res, 200, { success: true, room_code: room, user_id: user.id, user_name: user.name });
      }
      if (parts[0] === 'api' && parts[1] === 'room' && parts[3] === 'data') {
        const room = parts[2].toUpperCase();
        return json(res, 200, {
          room_code: room, server_time: Date.now() / 1000, max_file_size: 100 * 1024 * 1024,
          messages: [...messages.values()].filter((m) => m.room === room).map(publicMessage),
          users: [...users.values()].filter((u) => u.room === room && sockets.get(room)?.get(u.id)?.size).map((u) => ({ id: u.id, name: u.name })),
        });
      }
      if (parts[0] === 'api' && parts[1] === 'message' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        seen.bodies.push(JSON.stringify(body));
        const room = parts[2].toUpperCase();
        let m;
        if (body.message_type === 'sealed') {
          if (typeof body.data !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(body.data)) return json(res, 400, { detail: 'Invalid encrypted message' });
          m = newMessage(room, body.user_id, 'sealed', { data: body.data });
        } else if (body.message_type === 'location') m = newMessage(room, body.user_id, 'location', { latitude: body.latitude, longitude: body.longitude });
        else m = newMessage(room, body.user_id, 'text', { text: body.text, links: [] });
        return json(res, 200, { success: true, message_id: m.id, message: publicMessage(m) });
      }
      if (parts[0] === 'api' && parts[1] === 'upload' && req.method === 'POST') {
        const raw = await readBody(req);
        const boundary = Buffer.from(`--${req.headers['content-type'].split('boundary=')[1]}`);
        const start = raw.indexOf('\r\n\r\n', raw.indexOf(boundary)) + 4;
        const end = raw.indexOf(boundary, start) - 2;
        const head = raw.subarray(0, start).toString();
        const content = raw.subarray(start, end);
        const room = parts[2].toUpperCase();
        const enc = url.searchParams.get('enc') === '1';
        const name = enc ? 'encrypted' : /filename="([^"]*)"/.exec(head)?.[1] || 'file';
        const mime = enc ? 'application/octet-stream' : /Content-Type: ([^\r\n]+)/i.exec(head)?.[1] || 'application/octet-stream';
        seen.bodies.push(`upload ${name} ${mime} ${content.toString('latin1')}`);
        const type = enc ? 'file' : mime.startsWith('image/') ? 'image' : 'file';
        const m = newMessage(room, url.searchParams.get('user_id'), type, {
          filename: name, size: content.length, mime, ...(enc ? { enc: true, meta: url.searchParams.get('meta') } : {}),
        });
        messages.get(m.id).body = content;
        return json(res, 200, { success: true, files: [{ id: m.id, name, type, message: publicMessage(m) }], rejected: [] });
      }
      if (parts[0] === 'api' && parts[1] === 'download') {
        const m = messages.get(parts[2]);
        if (!m?.body) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': m.mime, 'content-disposition': 'attachment' });
        return res.end(m.body);
      }
      if (parts[0] === 'api' && parts[1] === 'ice') {
        return users.has(url.searchParams.get('user_id')) ? json(res, 200, { iceServers: [], ttl: 3600, push_relay: true }) : json(res, 403, { detail: 'Join a room first' });
      }
      if (parts[0] === 'api' && parts[1] === 'push' && req.method === 'POST') {
        seen.pushes.push(JSON.parse((await readBody(req)).toString()));
        return json(res, 200, { success: true, status: 201 });
      }
      if (parts[0] === 'api' && parts[1] === 'heartbeat') return json(res, 200, { success: true });
      if (url.pathname === '/version.json') return json(res, 200, { version: 'test', build: 'testbuild0000000' });
      if (url.pathname === '/' && url.searchParams.has('share')) {   // share target landing page
        const page = readFileSync(path.join(ROOT, 'templates/share.html'), 'utf8')
          .replaceAll('{{ build }}', 'testbuild0000000').replaceAll('{{ version }}', 'test').replaceAll('{{ max_room_code_length }}', '64');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      res.writeHead(404); res.end();
    } catch (err) {
      console.error('mock server error', err);
      res.writeHead(500); res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const [, , room, userId] = new URL(req.url, 'http://x').pathname.split('/').map(decodeURIComponent);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const user = users.get(userId);
      if (!user || user.room !== room) { ws.send(JSON.stringify({ type: 'rejoin' })); return ws.close(4001); }
      if (!sockets.has(room)) sockets.set(room, new Map());
      const members = sockets.get(room);
      if (!members.has(userId)) members.set(userId, new Set());
      members.get(userId).add(ws);
      ws.send(JSON.stringify({ type: 'users_list', users: [...members.keys()].map((u) => ({ id: u, name: users.get(u).name })) }));
      broadcast(room, { type: 'user_joined', user_id: userId, user_name: user.name });
      ws.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
        if (!text.startsWith('{')) return;
        // Same rules as websocket_endpoint() in main.py
        let frame;
        try { frame = JSON.parse(text); } catch { return; }
        if (frame.type !== 'signal' || typeof frame.data !== 'string' || frame.data.length > 16384) return;
        seen.signals.push(frame.data);
        const payload = { type: 'signal', from: userId, data: frame.data };
        if (frame.to) {
          payload.to = frame.to;
          const targets = members.get(frame.to);
          if (!targets?.size) return ws.send(JSON.stringify({ type: 'signal_error', reason: 'offline', to: frame.to }));
          for (const t of targets) t.send(JSON.stringify(payload));
        } else {
          for (const [uid, set] of members) if (uid !== userId) for (const t of set) t.send(JSON.stringify(payload));
        }
      });
      ws.on('close', () => {
        members.get(userId)?.delete(ws);
        if (members.get(userId)?.size) return;
        members.delete(userId);
        broadcast(room, { type: 'user_left', user_id: userId, user_name: user?.name || '' }); // like the real server
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://localhost:${server.address().port}`, seen, messages,
    close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); server.close(resolve); }),
  };
}
