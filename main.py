"""
FileRoom - ephemeral rooms for sharing files, messages, voice notes and locations,
with peer-to-peer voice calls and a babyphone (baby monitor).

Rooms, users and message metadata live in memory (a few hundred bytes each). File contents never
do: uploads are streamed to UPLOAD_DIR on disk, downloads and ZIP archives are streamed back.
Everything expires automatically and UPLOAD_DIR is emptied on every start.

What reaches the disk is never readable on its own:
  * rooms with a key: the browser encrypted the file (end-to-end), the server stores that ciphertext;
  * everything else: the server encrypts while writing, with a random key per file that exists only
    in memory. Deleting a message, expiry or a restart destroys the key - the bytes left on the disk
    are noise. (This protects the disk, not against the running server: only a room key does that.)

Calls and the babyphone cost the server next to nothing: audio goes directly from phone to phone
(WebRTC). The server only relays small, opaque signaling strings between the devices of a room,
hands out ICE servers and forwards already-encrypted Web Push requests. It keeps no call state.
With a room key (end-to-end encryption) messages, files and signaling are ciphertext to the server.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import string
import tempfile
import time
import unicodedata
import zipfile
from contextlib import asynccontextmanager, suppress
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote, urlsplit
import urllib.error
import urllib.request

import qrcode
from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile as StarletteUploadFile

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fileroom")

# ---------------------------------------------------------------------------
# Configuration (all overridable through environment variables)
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", BASE_DIR / "uploads"))
MAX_FILE_SIZE = int(os.environ.get("MAX_FILE_SIZE", 100 * 1024 * 1024))
MAX_SHARE_SIZE = int(os.environ.get("MAX_SHARE_SIZE", 500 * 1024 * 1024))
MAX_STORAGE_SIZE = int(os.environ.get("MAX_STORAGE_SIZE", 2 * 1024 ** 3))   # all rooms together, on disk
MESSAGE_EXPIRY_SECONDS = int(float(os.environ.get("MESSAGE_EXPIRY_HOURS", 1)) * 3600)
USER_TIMEOUT_SECONDS = int(os.environ.get("USER_TIMEOUT_SECONDS", 60))
SHARE_SESSION_SECONDS = int(float(os.environ.get("SHARE_SESSION_MINUTES", 15)) * 60)
MAX_ROOM_CODE_LENGTH = int(os.environ.get("MAX_ROOM_CODE_LENGTH", 64))
MAX_TEXT_LENGTH = 20_000
MAX_NAME_LENGTH = 20
CHUNK_SIZE = 1024 * 1024

APP_VERSION = (BASE_DIR / "VERSION").read_text().strip() if (BASE_DIR / "VERSION").exists() else "0.0.0"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

FILE_TYPES = {"file", "image", "video", "voice"}


def env_list(name: str) -> List[str]:
    return [item.strip() for item in os.environ.get(name, '').split(',') if item.strip()]


# ----- Calls & babyphone ----------------------------------------------------
# Phones in the same Wi-Fi find each other without any ICE server. STUN lets most home routers be
# traversed; TURN (see docker-compose.turn.yml) relays when nothing else works (mobile data, CGNAT).
STUN_URLS = env_list('STUN_URLS')
TURN_URLS = env_list('TURN_URLS')
TURN_SECRET = os.environ.get('TURN_SECRET', '')
TURN_TTL_SECONDS = int(os.environ.get('TURN_TTL_SECONDS', 24 * 3600))   # a babyphone runs all night
# Signaling: one opaque string per frame (an encrypted SDP is ~4-6 kB). Token bucket per socket.
MAX_SIGNAL_LENGTH = 16384
SIGNAL_BURST = 120
SIGNAL_RATE = 20.0          # frames per second
# End-to-end encrypted text/location messages ("<key id>.<iv>.<ciphertext>", base64url)
MAX_SEALED_LENGTH = MAX_TEXT_LENGTH * 6 + 512
SEALED_RE = re.compile(r'^[A-Za-z0-9_.-]+$')
# Web Push relay: the baby station encrypts and signs a notification for a parent phone, the server
# only forwards the bytes (browsers cannot call push services themselves: no CORS).
PUSH_RELAY = os.environ.get('PUSH_RELAY', '1').lower() not in ('0', 'false', 'no', 'off')
PUSH_HOSTS = env_list('PUSH_HOSTS') or [
    'fcm.googleapis.com',                 # Chrome, Edge, Samsung Internet, ... on Android and desktop
    '.push.services.mozilla.com',         # Firefox
    '.notify.windows.com',                # Edge (legacy)
    '.push.apple.com',                    # Safari
]
PUSH_MAX_BODY = 4096
PUSH_BURST = 40             # an invitation to a group is one push per member
PUSH_RATE = 0.2             # per second and user: one every 5 s after the burst
VAPID_RE = re.compile(r'^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{20,200}$')
TOPIC_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')
push_buckets: Dict[str, List[float]] = {}         # user id -> [tokens, last refill]

# ---------------------------------------------------------------------------
# In-memory storage
# ---------------------------------------------------------------------------
rooms_db: Dict[str, Dict[str, Any]] = {}          # code -> {code, created, last_activity, messages: [ids]}
messages_db: Dict[str, Dict[str, Any]] = {}       # id -> message
users_db: Dict[str, Dict[str, Any]] = {}          # id -> {id, name, room, last_seen}
room_users: Dict[str, Set[str]] = {}              # code -> user ids considered present
connections: Dict[str, Dict[str, Set[WebSocket]]] = {}  # code -> user id -> sockets
share_sessions: Dict[str, Dict[str, Any]] = {}    # id -> {created, title, text, url, files}

ADJECTIVES = ['Happy', 'Sunny', 'Bright', 'Swift', 'Cool', 'Smart', 'Lucky', 'Bold', 'Calm', 'Free']
NOUNS = ['Panda', 'Tiger', 'Eagle', 'Dolphin', 'Fox', 'Bear', 'Wolf', 'Cat', 'Dog', 'Lion']
ROOM_CODE_ALPHABET = ''.join(c for c in string.ascii_uppercase + string.digits if c not in '0O1I')
ROOM_CODE_RE = re.compile(r'^[\w-]+$')
URL_RE = re.compile(r'https?://[^\s<>"\']+')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def now() -> float:
    return time.time()


def generate_room_code() -> str:
    return ''.join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(6))


def generate_user_name() -> str:
    return f"{secrets.choice(ADJECTIVES)}{secrets.choice(NOUNS)}"


def generate_id() -> str:
    return secrets.token_urlsafe(9)


def normalize_room_code(raw: Optional[str]) -> Optional[str]:
    """Canonical form of a room code, or None if it is not a valid code.

    Any number of characters (1..MAX_ROOM_CODE_LENGTH) consisting of letters
    (any script), digits, '_' or '-' is a valid room. Whitespace becomes '-',
    and codes are case-insensitive (stored upper-case).
    """
    if raw is None:
        return None
    code = unicodedata.normalize('NFC', str(raw)).strip()
    code = re.sub(r'\s+', '-', code).upper()
    if not code or len(code) > MAX_ROOM_CODE_LENGTH or not ROOM_CODE_RE.match(code):
        return None
    return code


def require_room_code(raw: str) -> str:
    code = normalize_room_code(raw)
    if code is None:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid room code. Use 1-{MAX_ROOM_CODE_LENGTH} letters, digits, '-' or '_'.",
        )
    return code


def room_path(code: str) -> str:
    return f"/room/{quote(code, safe='')}"


def ensure_room(code: str) -> Dict[str, Any]:
    room = rooms_db.get(code)
    if room is None:
        room = rooms_db[code] = {'code': code, 'created': now(), 'last_activity': now(), 'messages': []}
        room_users.setdefault(code, set())
    return room


def touch_room(code: str) -> None:
    if code in rooms_db:
        rooms_db[code]['last_activity'] = now()


def clean_name(name: Optional[str]) -> str:
    name = ''.join(ch for ch in (name or '') if ch.isprintable()).strip()
    return name[:MAX_NAME_LENGTH]


def sanitize_filename(name: Optional[str], fallback: str = "file") -> str:
    """Make an uploaded filename safe for display and Content-Disposition (never used as a path)."""
    name = unicodedata.normalize('NFC', name or '')
    # Browsers escape these characters in multipart filenames (HTML spec): undo it.
    name = name.replace('%22', '"').replace('%0D', '').replace('%0A', '')
    name = name.replace('\\', '/').split('/')[-1]
    name = ''.join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*').strip(' .')
    if len(name) > 200:
        stem, dot, ext = name.rpartition('.')
        name = (stem[:190] + dot + ext[:9]) if dot and len(ext) <= 10 else name[:200]
    return name or fallback


def guess_mime(filename: str, declared: Optional[str]) -> str:
    declared = (declared or '').split(';')[0].strip().lower()
    if declared and declared not in ('application/octet-stream', 'binary/octet-stream'):
        return declared
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or 'application/octet-stream'


def classify(mime: str, requested: Optional[str] = None) -> str:
    if requested == 'voice' and (mime.startswith('audio/') or mime.startswith('video/webm')):
        return 'voice'
    if mime.startswith('image/'):
        return 'image'
    if mime.startswith('video/'):
        return 'video'
    if mime.startswith('audio/'):
        return 'voice'
    return 'file'


def file_path_for(msg: Dict[str, Any]) -> Path:
    return UPLOAD_DIR / msg['filename']


def remove_file(path: Path) -> None:
    with suppress(FileNotFoundError):
        path.unlink()


def public_message(msg: Dict[str, Any]) -> Dict[str, Any]:
    data = {
        'id': msg['id'],
        'type': msg['type'],
        'username': msg['username'],
        'user_id': msg.get('user_id'),
        'timestamp': msg['timestamp'],
        'expires_at': msg['expiry'],
        'time_remaining': max(0, int(msg['expiry'] - now())),
    }
    if msg['type'] == 'text':
        data['text'] = msg['text']
        data['links'] = URL_RE.findall(msg['text'])
    elif msg['type'] == 'location':
        data['latitude'] = msg['latitude']
        data['longitude'] = msg['longitude']
    elif msg['type'] == 'sealed':
        data['data'] = msg['data']  # ciphertext; only devices with the room key can read it
    else:
        data['filename'] = msg['original_name']
        data['size'] = msg['size']
        data['size_mb'] = round(msg['size'] / (1024 * 1024), 2)
        data['mime'] = msg['mime']
        if msg.get('enc'):
            # Encrypted on the sender's device: real name, type and size are inside 'meta'.
            data['enc'] = True
            data['meta'] = msg['meta']
    return data


def room_messages(code: str) -> List[Dict[str, Any]]:
    room = rooms_db.get(code)
    if not room:
        return []
    t = now()
    return [public_message(messages_db[mid]) for mid in room['messages']
            if mid in messages_db and messages_db[mid]['expiry'] > t]


def active_users(code: str) -> List[Dict[str, str]]:
    t = now()
    online = connections.get(code, {})
    users = []
    for uid in room_users.get(code, set()):
        user = users_db.get(uid)
        if not user:
            continue
        if online.get(uid) or t - user['last_seen'] < USER_TIMEOUT_SECONDS:
            users.append({'id': uid, 'name': user['name']})
    users.sort(key=lambda u: u['name'].lower())
    return users


def user_name_for(user_id: Optional[str], code: str) -> str:
    user = users_db.get(user_id or '')
    if user and user['room'] == code:
        user['last_seen'] = now()
        room_users.setdefault(code, set()).add(user['id'])
        return user['name']
    return "Anonymous"


async def broadcast_to_room(code: str, payload: Dict[str, Any]) -> None:
    sockets = [(uid, ws) for uid, conns in connections.get(code, {}).items() for ws in list(conns)]
    if not sockets:
        return
    text = json.dumps(payload)

    async def send(uid: str, ws: WebSocket) -> None:
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=10)
        except Exception as exc:  # broken connection - forget it
            logger.info("Dropping websocket of %s: %s", uid, exc)
            drop_connection(code, uid, ws)

    await asyncio.gather(*(send(uid, ws) for uid, ws in sockets))


def drop_connection(code: str, uid: str, ws: WebSocket) -> None:
    conns = connections.get(code, {}).get(uid)
    if conns is not None:
        conns.discard(ws)
        if not conns:
            connections[code].pop(uid, None)
    if code in connections and not connections[code]:
        connections.pop(code, None)


async def add_message(code: str, msg: Dict[str, Any]) -> Dict[str, Any]:
    room = ensure_room(code)
    messages_db[msg['id']] = msg
    room['messages'].append(msg['id'])
    touch_room(code)
    data = public_message(msg)
    await broadcast_to_room(code, {'type': 'new_message', 'message': data})
    return data


def new_message(code: str, user_id: Optional[str], username: str, msg_type: str, **fields: Any) -> Dict[str, Any]:
    t = now()
    return {
        'id': generate_id(), 'type': msg_type, 'username': username, 'user_id': user_id,
        'room': code, 'timestamp': t, 'expiry': t + MESSAGE_EXPIRY_SECONDS, **fields,
    }


async def delete_message_internal(message_id: str, broadcast: bool = True) -> bool:
    msg = messages_db.pop(message_id, None)
    if not msg:
        return False
    if msg['type'] in FILE_TYPES:
        remove_file(file_path_for(msg))
    room = rooms_db.get(msg['room'])
    if room and message_id in room['messages']:
        room['messages'].remove(message_id)
    if broadcast:
        await broadcast_to_room(msg['room'], {'type': 'message_deleted', 'message_id': message_id})
    return True


def new_file_key() -> bytes:
    """Key (32 bytes) + nonce (12 bytes) for one stored file. Lives only in the message, i.e. in memory."""
    return secrets.token_bytes(44)


def file_cipher(key: bytes, offset: int = 0):
    """ChaCha20 keystream positioned at byte `offset` of the file (so downloads can seek)."""
    block, skip = divmod(offset, 64)
    cipher = Cipher(algorithms.ChaCha20(key[:32], block.to_bytes(4, 'little') + key[32:]), mode=None).encryptor()
    if skip:
        cipher.update(bytes(skip))
    return cipher


def storage_used() -> int:
    return (sum(m.get('size', 0) for m in messages_db.values() if m['type'] in FILE_TYPES)
            + sum(f['size'] for s in share_sessions.values() for f in s['files']))


async def save_upload(upload: StarletteUploadFile, dest: Path, limit: int, key: Optional[bytes] = None) -> int:
    """Stream an uploaded file to disk, encrypting it on the way if `key` is given (uploads that the
    browser already encrypted are stored as they are). Returns size, raises ValueError if too large."""
    size = 0
    cipher = file_cipher(key) if key else None
    await upload.seek(0)
    with open(dest, 'wb') as out:
        while True:
            chunk = await upload.read(CHUNK_SIZE)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                out.close()
                remove_file(dest)
                raise ValueError("too large")
            out.write(cipher.update(chunk) if cipher else chunk)
    return size


def read_stored(msg: Dict[str, Any], start: int = 0, length: Optional[int] = None):
    """Yield the content of a stored file in chunks, decrypting files the server encrypted."""
    cipher = file_cipher(msg['key'], start) if msg.get('key') else None
    remaining = msg['size'] - start if length is None else length
    with open(file_path_for(msg), 'rb') as fh:
        fh.seek(start)
        while remaining > 0:
            chunk = fh.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield cipher.update(chunk) if cipher else chunk


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------
async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(15)
        try:
            t = now()
            # Expired messages
            for mid in [mid for mid, m in messages_db.items() if m['expiry'] <= t]:
                await delete_message_internal(mid)

            # Inactive users (no open socket and no heartbeat)
            for code, members in list(room_users.items()):
                online = connections.get(code, {})
                for uid in list(members):
                    user = users_db.get(uid)
                    if user is None:
                        members.discard(uid)
                        continue
                    if not online.get(uid) and t - user['last_seen'] > USER_TIMEOUT_SECONDS:
                        members.discard(uid)
                        await broadcast_to_room(code, {'type': 'user_left', 'user_id': uid, 'user_name': user['name']})

            # Forget users that have been gone for longer than messages live
            for uid in [uid for uid, u in users_db.items()
                        if t - u['last_seen'] > MESSAGE_EXPIRY_SECONDS and not connections.get(u['room'], {}).get(uid)]:
                users_db.pop(uid, None)
                push_buckets.pop(uid, None)

            # Forget empty, idle rooms
            for code in [c for c, r in rooms_db.items()
                         if not r['messages'] and not room_users.get(c) and not connections.get(c)
                         and t - r['last_activity'] > max(USER_TIMEOUT_SECONDS * 5, 600)]:
                rooms_db.pop(code, None)
                room_users.pop(code, None)

            # Expired share sessions
            for sid in [sid for sid, s in share_sessions.items() if t - s['created'] > SHARE_SESSION_SECONDS]:
                discard_share_session(sid)

            # Orphaned files (e.g. left over after a crash)
            known = {m['filename'] for m in messages_db.values() if m['type'] in FILE_TYPES}
            known |= {f['temp_name'] for s in share_sessions.values() for f in s['files']}
            for path in UPLOAD_DIR.iterdir():
                if path.is_file() and path.name not in known and t - path.stat().st_mtime > 300:
                    remove_file(path)
        except Exception:
            logger.exception("Cleanup error")


def discard_share_session(sid: str) -> None:
    session = share_sessions.pop(sid, None)
    if session:
        for f in session['files']:
            remove_file(UPLOAD_DIR / f['temp_name'])


# ---------------------------------------------------------------------------
# PWA build: app shells, verified offline assets, service worker
# ---------------------------------------------------------------------------
jinja = Environment(loader=FileSystemLoader(str(TEMPLATE_DIR)), autoescape=select_autoescape(['html']))

PRECACHE_STATIC = [
    'css/styles.css',
    'js/e2ee.js',
    'js/qr.js',
    'js/app.js',
    'js/contacts.js',
    'js/voice.js',
    'js/level-worklet.js',
    'js/pwa.js',
    'js/share-store.js',
    'js/share.js',
    'icons/icon-96x96.png',
    'vendor/bootstrap/bootstrap.min.css',
    'vendor/bootstrap/bootstrap.bundle.min.js',
    'vendor/bootstrap-icons/bootstrap-icons.min.css',
    'vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
    'vendor/bootstrap-icons/fonts/bootstrap-icons.woff',
    'vendor/leaflet/leaflet.css',
    'vendor/leaflet/leaflet.js',
    'vendor/leaflet/images/marker-icon.png',
    'vendor/leaflet/images/marker-icon-2x.png',
    'vendor/leaflet/images/marker-shadow.png',
    'icons/icon-192x192.png',
    'icons/icon-512x512.png',
    'images/favicon.ico',
]


def build_manifest() -> Dict[str, Any]:
    icon_sizes = [72, 96, 128, 144, 152, 192, 384, 512]
    icons = [{"src": f"/static/icons/icon-{s}x{s}.png", "sizes": f"{s}x{s}", "type": "image/png", "purpose": "any"}
             for s in icon_sizes]
    icons += [{"src": f"/static/icons/icon-{s}x{s}.png", "sizes": f"{s}x{s}", "type": "image/png", "purpose": "maskable"}
              for s in (192, 512)]
    return {
        "id": "/",
        "name": "FileRoom - Ephemeral File Sharing",
        "short_name": "FileRoom",
        "description": "Share files, messages, voice notes and locations in temporary rooms; encrypted calls and babyphone",
        "lang": "en",
        "start_url": "/?source=pwa",
        "scope": "/",
        "display": "standalone",
        "background_color": "#0f172a",
        "theme_color": "#1e293b",
        "icons": icons,
        "categories": ["productivity", "utilities"],
        "share_target": {
            "action": "/share",
            "method": "POST",
            "enctype": "multipart/form-data",
            "params": {
                "title": "title",
                "text": "text",
                "url": "url",
                "files": [{"name": "files", "accept": ["*/*"]}],
            },
        },
    }


class PwaBuild:
    def __init__(self) -> None:
        self.version = APP_VERSION
        self.build = ''
        self.shells: Dict[str, bytes] = {}
        self.manifest = b''
        self.sw = b''
        self.version_json = b''
        self.refresh()

    def refresh(self) -> None:
        placeholder = '__BUILD__'
        ctx = {'build': placeholder, 'version': self.version, 'max_file_size': MAX_FILE_SIZE,
               'max_room_code_length': MAX_ROOM_CODE_LENGTH}
        shells = {name: jinja.get_template(f"{name}.html").render(**ctx) for name in ('room', 'share')}
        manifest = json.dumps(build_manifest(), indent=2).encode()
        static = [(f'/static/{p}', (STATIC_DIR / p).read_bytes()) for p in PRECACHE_STATIC]
        template = (BASE_DIR / 'pwa' / 'sw.template.js').read_text()

        digest = hashlib.sha256()
        for part in [self.version, template, *shells.values()]:
            digest.update(part.encode())
        digest.update(manifest)
        for path, body in static:
            digest.update(path.encode() + hashlib.sha256(body).digest())
        self.build = digest.hexdigest()[:16]

        self.shells = {name: html.replace(placeholder, self.build).encode() for name, html in shells.items()}
        self.manifest = manifest
        sha = lambda b: hashlib.sha256(b).hexdigest()
        assets = [['/shell/room.html', sha(self.shells['room'])], ['/shell/share.html', sha(self.shells['share'])],
                  ['/manifest.webmanifest', sha(manifest)]] + [[p, sha(b)] for p, b in static]
        self.sw = (template.replace('__BUILD__', json.dumps(self.build))
                   .replace('__VERSION__', json.dumps(self.version))
                   .replace('__ASSETS__', json.dumps(assets))).encode()
        self.version_json = json.dumps({'version': self.version, 'build': self.build}).encode()
        logger.info("PWA build %s (v%s), %d offline assets", self.build, self.version, len(assets))


pwa = PwaBuild()

NO_CACHE = {'Cache-Control': 'no-cache'}


def shell_response(name: str) -> HTMLResponse:
    return HTMLResponse(pwa.shells[name], headers=NO_CACHE)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    # Rooms and file keys live in memory, so whatever a previous run left on disk is unreadable garbage.
    for path in UPLOAD_DIR.iterdir():
        if path.is_file():
            remove_file(path)
    task = asyncio.create_task(cleanup_loop())
    logger.info("FileRoom %s started, files on disk in %s (limit %d MB)", APP_VERSION, UPLOAD_DIR,
                MAX_STORAGE_SIZE // (1024 * 1024))
    yield
    task.cancel()


app = FastAPI(title="FileRoom", version=APP_VERSION, lifespan=lifespan)


class StaticWithHeaders(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Files are versioned with ?v=<build>; revalidate so non-SW clients get updates too.
        response.headers.setdefault('Cache-Control', 'no-cache')
        return response


app.mount("/static", StaticWithHeaders(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'same-origin')
    response.headers.setdefault('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=(self)')
    return response


# ----- Pages ---------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request, share: Optional[str] = None, source: Optional[str] = None,
               shareError: Optional[str] = None):
    if share is not None:
        # Share-target landing page: choose the room to send the shared content to.
        return shell_response('share')
    target = None
    if source == 'pwa':
        target = normalize_room_code(request.cookies.get('fileroom_last_room'))
    # A freshly created random room is marked "new": the first device creates a room key for it
    # (end-to-end encryption). The key itself only ever lives in the URL fragment on the devices.
    query = [] if target else ['new=1']
    if shareError:
        query.append(f"shareError={quote(shareError)}")
    url = room_path(target or generate_room_code()) + (f"?{'&'.join(query)}" if query else '')
    return RedirectResponse(url, status_code=302, headers={'Cache-Control': 'no-store'})


@app.get("/room/{room_code}", response_class=HTMLResponse)
async def room_page(request: Request, room_code: str):
    code = normalize_room_code(room_code)
    if code is None:
        return RedirectResponse("/?shareError=invalid-room", status_code=302)
    if code != room_code:
        query = f"?{request.url.query}" if request.url.query else ''
        return RedirectResponse(room_path(code) + query, status_code=302)
    ensure_room(code)
    return shell_response('room')


@app.get("/shell/{name}.html", include_in_schema=False)
async def shell(name: str):
    if name not in pwa.shells:
        raise HTTPException(404)
    return shell_response(name)


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return Response(pwa.sw, media_type='application/javascript',
                    headers={'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/'})


@app.get("/version.json", include_in_schema=False)
async def version_json():
    return Response(pwa.version_json, media_type='application/json', headers={'Cache-Control': 'no-store'})


@app.get("/manifest.webmanifest", include_in_schema=False)
@app.get("/manifest.json", include_in_schema=False)
async def manifest():
    return Response(pwa.manifest, media_type='application/manifest+json', headers=NO_CACHE)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(STATIC_DIR / 'images' / 'favicon.ico')


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok", "version": APP_VERSION, "build": pwa.build}


# ----- Rooms & users -------------------------------------------------------
@app.get("/api/room-code/{room_code}")
async def check_room_code(room_code: str):
    code = require_room_code(room_code)
    return {"success": True, "room_code": code, "url": room_path(code)}


@app.get("/api/join/{room_code}")
async def join_room(room_code: str, user_id: Optional[str] = None, user_name: Optional[str] = None, anon: int = 0):
    code = require_room_code(room_code)
    ensure_room(code)
    touch_room(code)
    # anon: the device wants to be anonymous here (again): it gets a fresh random name.
    name = generate_user_name() if anon else clean_name(user_name)

    user = users_db.get(user_id or '')
    if user and user['room'] == code:
        user['last_seen'] = now()
        was_present = user['id'] in room_users.setdefault(code, set())
        room_users[code].add(user['id'])
        if name and name != user['name']:
            old = user['name']
            user['name'] = name
            await broadcast_to_room(code, {'type': 'user_renamed', 'user_id': user['id'],
                                           'old_name': old, 'new_name': name})
        elif not was_present:
            await broadcast_to_room(code, {'type': 'user_joined', 'user_id': user['id'], 'user_name': user['name']})
        return {"success": True, "room_code": code, "user_id": user['id'], "user_name": user['name'], "existing": True}

    new_id = generate_id()
    users_db[new_id] = {'id': new_id, 'name': name or generate_user_name(), 'room': code,
                        'joined': now(), 'last_seen': now()}
    room_users.setdefault(code, set()).add(new_id)
    await broadcast_to_room(code, {'type': 'user_joined', 'user_id': new_id, 'user_name': users_db[new_id]['name']})
    return {"success": True, "room_code": code, "user_id": new_id, "user_name": users_db[new_id]['name'],
            "existing": False}


@app.get("/api/room/{room_code}/data")
async def get_room_data(room_code: str):
    code = require_room_code(room_code)
    return {"room_code": code, "messages": room_messages(code), "users": active_users(code),
            "server_time": now(), "max_file_size": MAX_FILE_SIZE}


@app.post("/api/heartbeat/{user_id}")
async def heartbeat(user_id: str):
    user = users_db.get(user_id)
    if not user:
        return {"success": False}
    user['last_seen'] = now()
    room_users.setdefault(user['room'], set()).add(user_id)
    return {"success": True}


@app.post("/api/room/change")
async def change_room(new_room: str, current_room: Optional[str] = None, user_id: Optional[str] = None):
    """Kept for compatibility: validates the target room and returns its URL."""
    code = require_room_code(new_room)
    ensure_room(code)
    return {"success": True, "new_room": code, "redirect_url": room_path(code)}


@app.get("/api/qr")
async def qr_code(data: str = Query(..., max_length=2048)):
    qr = qrcode.QRCode(box_size=8, border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(data)
    qr.make(fit=True)
    buf = BytesIO()
    qr.make_image(fill_color="black", back_color="white").save(buf, format='PNG')
    return Response(buf.getvalue(), media_type='image/png', headers={'Cache-Control': 'public, max-age=86400'})


# ----- Messages ------------------------------------------------------------
@app.post("/api/message/{room_code}")
async def send_message(request: Request, room_code: str):
    code = require_room_code(room_code)
    params: Dict[str, Any] = dict(request.query_params)
    if 'application/json' in request.headers.get('content-type', ''):
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Invalid JSON")
        if isinstance(body, dict):
            params.update({k: v for k, v in body.items() if v is not None})

    user_id = params.get('user_id')
    username = user_name_for(user_id, code)
    msg_type = params.get('message_type') or 'text'

    if msg_type == 'location':
        try:
            lat, lng = float(params['latitude']), float(params['longitude'])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "Missing location data")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise HTTPException(400, "Invalid coordinates")
        msg = new_message(code, user_id, username, 'location', latitude=lat, longitude=lng)
    elif msg_type == 'text':
        text = str(params.get('text') or '').strip()
        if not text:
            raise HTTPException(400, "Empty message")
        if len(text) > MAX_TEXT_LENGTH:
            raise HTTPException(413, f"Message too long (max {MAX_TEXT_LENGTH} characters)")
        msg = new_message(code, user_id, username, 'text', text=text)
    elif msg_type == 'sealed':
        data = params.get('data')
        if not isinstance(data, str) or not data:
            raise HTTPException(400, "Missing encrypted message")
        if len(data) > MAX_SEALED_LENGTH:
            raise HTTPException(413, "Message too long")
        if not SEALED_RE.match(data):
            raise HTTPException(400, "Invalid encrypted message")
        msg = new_message(code, user_id, username, 'sealed', data=data)
    else:
        raise HTTPException(400, "Unknown message type")

    data = await add_message(code, msg)
    return {"success": True, "message_id": msg['id'], "message": data}


@app.post("/api/upload/{room_code}")
async def upload_file(request: Request, room_code: str, user_id: Optional[str] = None,
                      message_type: str = "file", enc: int = 0, meta: Optional[str] = None):
    code = require_room_code(room_code)
    if enc:
        # End-to-end encrypted upload: the body is ciphertext, name/type/size travel sealed in 'meta'.
        if not meta or len(meta) > 4096 or not SEALED_RE.match(meta):
            raise HTTPException(400, "Encrypted uploads need sealed metadata")
    try:
        form = await request.form(max_files=1000, max_fields=1000)
    except Exception as exc:
        raise HTTPException(400, f"Invalid upload: {exc}")
    uploads = [f for f in form.getlist('files') if isinstance(f, StarletteUploadFile)]
    if not uploads:
        raise HTTPException(400, "No files received")

    username = user_name_for(user_id, code)
    uploaded, rejected = [], []
    try:
        for upload in uploads:
            free = MAX_STORAGE_SIZE - storage_used()
            if enc:
                name, mime = 'encrypted', 'application/octet-stream'
                msg = new_message(code, user_id, username, 'file', original_name=name, mime=mime, size=0,
                                  enc=True, meta=meta)
            else:
                name = sanitize_filename(upload.filename, 'voice_message' if message_type == 'voice' else 'file')
                mime = guess_mime(name, upload.content_type)
                msg = new_message(code, user_id, username, classify(mime, message_type),
                                  original_name=name, mime=mime, size=0, key=new_file_key())
            msg['filename'] = msg['id']
            try:
                msg['size'] = await save_upload(upload, file_path_for(msg), min(MAX_FILE_SIZE, max(free, 0)),
                                                msg.get('key'))
            except ValueError:
                rejected.append({'name': name, 'reason': f'larger than {MAX_FILE_SIZE // (1024 * 1024)} MB'
                                 if free >= MAX_FILE_SIZE else 'larger than the space left on the server'})
                continue
            if msg['size'] == 0:
                remove_file(file_path_for(msg))
                rejected.append({'name': name, 'reason': 'empty file'})
                continue
            data = await add_message(code, msg)
            uploaded.append({'id': msg['id'], 'name': name, 'type': msg['type'], 'message': data})
    finally:
        await form.close()

    if not uploaded:
        raise HTTPException(413 if any('larger' in r['reason'] for r in rejected) else 400,
                            "; ".join(f"{r['name']}: {r['reason']}" for r in rejected) or "Nothing uploaded")
    return {"success": True, "message": f"{len(uploaded)} file(s) uploaded", "files": uploaded,
            "rejected": rejected}


@app.delete("/api/message/{message_id}")
async def delete_message(message_id: str):
    if not await delete_message_internal(message_id):
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Deleted"}


@app.delete("/api/room/{room_code}/all")
async def delete_all_room_data(room_code: str):
    code = require_room_code(room_code)
    room = rooms_db.get(code)
    if not room:
        return {"success": True, "message": "Deleted 0 messages", "count": 0}
    ids = list(room['messages'])
    count = 0
    for mid in ids:
        if await delete_message_internal(mid, broadcast=False):
            count += 1
    room['messages'] = []
    await broadcast_to_room(code, {'type': 'room_cleared', 'message': 'All messages deleted'})
    return {"success": True, "message": f"Deleted {count} messages", "count": count}


def get_file_message(message_id: str) -> Dict[str, Any]:
    msg = messages_db.get(message_id)
    if not msg or msg['type'] not in FILE_TYPES:
        raise HTTPException(404, "File not found")
    if msg['expiry'] <= now():
        raise HTTPException(410, "File expired")
    if not file_path_for(msg).exists():
        raise HTTPException(404, "File not on disk")
    return msg


@app.get("/api/download/{message_id}")
async def download_file(message_id: str, request: Request):
    msg = get_file_message(message_id)
    # Always served as an attachment with its real type: <img>/<audio>/<video> can still embed it,
    # while opening it directly never renders user content as a page on this origin.
    if msg.get('key'):
        response = decrypted_response(msg, request.headers.get('range'))
    else:  # ciphertext from the browser: sent straight from disk
        response = FileResponse(file_path_for(msg), media_type=msg['mime'], filename=msg['original_name'])
    response.headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    response.headers['Cache-Control'] = 'private, max-age=3600'
    return response


def decrypted_response(msg: Dict[str, Any], range_header: Optional[str]) -> Response:
    """Stream a server-encrypted file, with Range support (seeking in videos and voice messages)."""
    size = msg['size']
    start, end, status = 0, size - 1, 200
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', (range_header or '').strip())
    if match and (match[1] or match[2]):
        if match[1]:
            start = int(match[1])
            end = min(int(match[2]), size - 1) if match[2] else size - 1
        else:
            start = max(0, size - int(match[2]))
        if start > end or start >= size:
            return Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})
        status = 206
    headers = {'Content-Length': str(end - start + 1), 'Accept-Ranges': 'bytes',
               'Content-Disposition': f"attachment; filename*=utf-8''{quote(msg['original_name'])}"}
    if status == 206:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return StreamingResponse(read_stored(msg, start, end - start + 1), status_code=status,
                             media_type=msg['mime'], headers=headers)


class _ZipSink:
    """Write-only, non-seekable "file": lets zipfile produce an archive that is sent while it is built."""
    def __init__(self) -> None:
        self.parts: List[bytes] = []
        self.position = 0

    def write(self, data) -> int:
        self.parts.append(bytes(data))
        self.position += len(data)
        return len(data)

    def tell(self) -> int:
        return self.position

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        data = b''.join(self.parts)
        self.parts.clear()
        return data


def zip_stream(msgs: List[Dict[str, Any]], tz: int):
    """ZIP archive as a stream of chunks: nothing is buffered in memory or written to disk."""
    sink, used = _ZipSink(), set()
    with zipfile.ZipFile(sink, 'w', zipfile.ZIP_STORED, allowZip64=True) as zf:
        for msg in msgs:
            stamp = time.gmtime(msg['timestamp'] - tz * 60)[:6]
            if msg['type'] in FILE_TYPES:
                if not file_path_for(msg).exists():
                    continue  # deleted in the meantime
                info = zipfile.ZipInfo(unique_name(msg['original_name'], used), date_time=stamp)
                with zf.open(info, 'w', force_zip64=msg['size'] >= 2 ** 31) as entry:
                    for chunk in read_stored(msg):
                        entry.write(chunk)
                        yield sink.take()
            else:
                zf.writestr(zipfile.ZipInfo(unique_name(text_filename(msg, tz), used), date_time=stamp),
                            message_text(msg) + '\n')
            yield sink.take()
    yield sink.take()


def unique_name(name: str, used: Set[str]) -> str:
    candidate, n = name, 1
    stem, dot, ext = name.rpartition('.')
    if not dot:
        stem, ext = name, ''
    while candidate.lower() in used:
        n += 1
        candidate = f"{stem} ({n}).{ext}" if dot else f"{stem} ({n})"
    used.add(candidate.lower())
    return candidate


def text_filename(msg: Dict[str, Any], tz_offset_minutes: int) -> str:
    """<timestamp>.txt in the client's local time (tz = JS getTimezoneOffset())."""
    return time.strftime('%Y-%m-%d_%H-%M-%S', time.gmtime(msg['timestamp'] - tz_offset_minutes * 60)) + '.txt'


def message_text(msg: Dict[str, Any]) -> Optional[str]:
    """Readable text of a message for ZIP archives (None for files and for ciphertext)."""
    if msg['type'] == 'text':
        return msg['text']
    if msg['type'] == 'location':
        lat, lng = msg['latitude'], msg['longitude']
        return f"https://www.openstreetmap.org/?mlat={lat}&mlon={lng}#map=16/{lat}/{lng}"
    return None


@app.get("/api/room/{room_code}/zip")
async def download_zip(room_code: str, ids: Optional[str] = None, tz: int = Query(0, ge=-1440, le=1440)):
    """Download several (or all) messages of a room as one ZIP archive (texts as <timestamp>.txt)."""
    code = require_room_code(room_code)
    room = rooms_db.get(code)
    if not room:
        raise HTTPException(404, "Room not found")
    wanted = [i for i in (ids or '').split(',') if i] or list(room['messages'])
    msgs = []
    for mid in wanted:
        msg = messages_db.get(mid)
        if not msg or msg['room'] != code or msg['expiry'] <= now():
            continue
        if msg.get('enc'):
            continue  # encrypted files are downloaded and decrypted by the client, one by one
        if (msg['type'] in FILE_TYPES and file_path_for(msg).exists()) or message_text(msg):
            msgs.append(msg)
    if not msgs:
        raise HTTPException(404, "Nothing to download")

    filename = f"FileRoom-{code}-{time.strftime('%Y%m%d-%H%M')}.zip"
    return StreamingResponse(zip_stream(msgs, tz), media_type='application/zip',
                             headers={'Content-Disposition': f'attachment; filename="{quote(filename)}"',
                                      'Cache-Control': 'no-store'})


# ----- Calls & babyphone: signaling relay, ICE servers, push relay ------------
async def send_to_user(code: str, uid: str, text: str) -> bool:
    delivered = False
    for ws in list(connections.get(code, {}).get(uid, ())):
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=10)
            delivered = True
        except Exception as exc:
            logger.info("Dropping websocket of %s: %s", uid, exc)
            drop_connection(code, uid, ws)
    return delivered


async def relay_signal(code: str, sender: str, raw: str, bucket: List[float]) -> Optional[Dict[str, Any]]:
    """Pass one signaling frame {"type": "signal", "to": <user id or null>, "data": <string>} on to
    one device or to everybody else in the room. The server neither reads nor stores `data` (with a
    room key it is ciphertext) and never sends it to another room. Returns an error for the sender."""
    if len(raw) > MAX_SIGNAL_LENGTH + 512:
        return {'reason': 'too-large'}
    try:
        frame = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(frame, dict) or frame.get('type') != 'signal':
        return None
    data, to = frame.get('data'), frame.get('to')
    if not isinstance(data, str) or not data or len(data) > MAX_SIGNAL_LENGTH or not (to is None or isinstance(to, str)):
        return {'reason': 'invalid'}
    if to == sender:
        return None

    t = time.monotonic()
    bucket[0] = min(float(SIGNAL_BURST), bucket[0] + (t - bucket[1]) * SIGNAL_RATE)
    bucket[1] = t
    if bucket[0] < 1:
        if t - bucket[2] < 1 and bucket[2]:
            return None  # do not answer a flood with a flood
        bucket[2] = t
        return {'reason': 'rate'}
    bucket[0] -= 1

    payload: Dict[str, Any] = {'type': 'signal', 'from': sender, 'data': data}
    if to is not None:
        payload['to'] = to
        if to not in connections.get(code, {}) or not await send_to_user(code, to, json.dumps(payload)):
            return {'reason': 'offline', 'to': to}
        return None
    text = json.dumps(payload)
    await asyncio.gather(*(send_to_user(code, uid, text) for uid in list(connections.get(code, {})) if uid != sender))
    return None


def require_user(user_id: Optional[str]) -> Dict[str, Any]:
    user = users_db.get(user_id or '')
    if not user:
        raise HTTPException(403, "Join a room first")
    return user


@app.get("/api/ice")
async def ice_servers(user_id: Optional[str] = None):
    """ICE servers for WebRTC. TURN credentials are short-lived and derived from a shared secret
    (coturn "use-auth-secret"), so the TURN server needs no user database and cannot be used by strangers."""
    require_user(user_id)
    servers: List[Dict[str, Any]] = []
    if STUN_URLS:
        servers.append({'urls': STUN_URLS})
    if TURN_URLS and TURN_SECRET:
        username = f"{int(now()) + TURN_TTL_SECONDS}:{secrets.token_urlsafe(6)}"
        credential = base64.b64encode(hmac.new(TURN_SECRET.encode(), username.encode(), hashlib.sha1).digest()).decode()
        servers.append({'urls': TURN_URLS, 'username': username, 'credential': credential})
    return JSONResponse({'iceServers': servers, 'ttl': TURN_TTL_SECONDS, 'push_relay': PUSH_RELAY},
                        headers={'Cache-Control': 'no-store'})


def push_host_allowed(host: str) -> bool:
    host = (host or '').lower().rstrip('.')
    return any(host == allowed.lstrip('.') if not allowed.startswith('.') else host.endswith(allowed)
               for allowed in (a.lower() for a in PUSH_HOSTS))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # a push service never redirects; do not follow anywhere
        return None


def forward_push(endpoint: str, headers: Dict[str, str], body: bytes) -> int:
    """POST one encrypted notification to a push service. Returns its HTTP status."""
    request = urllib.request.Request(endpoint, data=body, headers=headers, method='POST')
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


@app.post("/api/push")
async def push_relay(request: Request):
    """Forward a Web Push message that a baby station encrypted (RFC 8291) and signed (VAPID, RFC 8292)
    for a parent phone. The server holds no keys and no subscriptions and cannot read the message.
    It only talks to well-known push services, so it cannot be used to reach arbitrary hosts."""
    if not PUSH_RELAY:
        raise HTTPException(404, "Push relay is disabled")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Invalid JSON")
    user = require_user(body.get('user_id'))

    endpoint, auth, topic = body.get('endpoint'), body.get('auth'), body.get('topic')
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        raise HTTPException(400, "Invalid endpoint")
    try:
        url = urlsplit(endpoint)
        port = url.port
    except ValueError:
        raise HTTPException(400, "Invalid endpoint")
    if (url.scheme != 'https' or url.username is not None or url.password is not None or port not in (None, 443)
            or not push_host_allowed(url.hostname or '')):
        raise HTTPException(400, "Endpoint is not a known push service")
    if not isinstance(auth, str) or len(auth) > 2048 or not VAPID_RE.match(auth):
        raise HTTPException(400, "Invalid authorization")
    try:
        raw = body.get('body')
        payload = base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)) if isinstance(raw, str) and SEALED_RE.match(raw) else b''
    except (binascii.Error, ValueError):
        payload = b''
    if not payload or len(payload) > PUSH_MAX_BODY:
        raise HTTPException(400, "Invalid body")
    try:
        ttl = max(0, min(3600, int(body.get('ttl', 120))))
    except (TypeError, ValueError):
        ttl = 120

    t = time.monotonic()
    bucket = push_buckets.setdefault(user['id'], [float(PUSH_BURST), t])
    bucket[0] = min(float(PUSH_BURST), bucket[0] + (t - bucket[1]) * PUSH_RATE)
    bucket[1] = t
    if bucket[0] < 1:
        raise HTTPException(429, "Too many notifications")
    bucket[0] -= 1

    headers = {'Authorization': auth, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
               'TTL': str(ttl), 'Urgency': body.get('urgency') if body.get('urgency') in ('very-low', 'low', 'normal', 'high') else 'high'}
    if isinstance(topic, str) and TOPIC_RE.match(topic):
        headers['Topic'] = topic
    try:
        status = await asyncio.to_thread(forward_push, endpoint, headers, payload)
    except Exception as exc:
        logger.info("Push relay failed: %s", type(exc).__name__)
        raise HTTPException(502, "Push service not reachable")
    return {"success": True, "status": status}


# ----- WebSocket -----------------------------------------------------------
@app.websocket("/ws/{room_code}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, room_code: str, user_id: str):
    code = normalize_room_code(room_code)
    await websocket.accept()
    user = users_db.get(user_id)
    if code is None or not user or user['room'] != code:
        # Unknown user (e.g. the server restarted): the client re-joins and reconnects.
        await websocket.send_json({'type': 'rejoin'})
        await websocket.close(code=4001)
        return

    connections.setdefault(code, {}).setdefault(user_id, set()).add(websocket)
    user['last_seen'] = now()
    if user_id not in room_users.setdefault(code, set()):
        room_users[code].add(user_id)
        await broadcast_to_room(code, {'type': 'user_joined', 'user_id': user_id, 'user_name': user['name']})

    bucket = [float(SIGNAL_BURST), time.monotonic(), 0.0]  # tokens, last refill, last "rate" notice
    try:
        await websocket.send_json({'type': 'users_list', 'users': active_users(code)})
        while True:
            data = await websocket.receive_text()
            user['last_seen'] = now()
            if data == 'ping':
                await websocket.send_json({'type': 'pong'})
            elif data.startswith('{'):
                error = await relay_signal(code, user_id, data, bucket)
                if error:
                    await websocket.send_json({'type': 'signal_error', **error})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.info("WebSocket error: %s", exc)
    finally:
        drop_connection(code, user_id, websocket)
        user['last_seen'] = now()


# ----- Share target (incoming shares from other apps) ----------------------
@app.post("/share")
async def handle_share_target(request: Request):
    """PWA Web Share Target: receives text, links and any number of files from other apps.

    Installed apps normally never get here: their service worker keeps the shared content on the
    phone, so it can be encrypted with the room key before upload. This is the fallback (first start
    after installing, service worker not active). Files go straight to disk, encrypted at rest."""
    request_id = secrets.token_urlsafe(6)
    try:
        if int(request.headers.get('content-length') or 0) > MAX_SHARE_SIZE:
            return RedirectResponse(url="/?shareError=too-large", status_code=303)
        form = await request.form(max_files=1000, max_fields=1000)  # spools large parts to temp files
    except Exception:
        logger.exception("[%s] Share parsing failed", request_id)
        return RedirectResponse(url="/?shareError=invalid", status_code=303)

    session_id = secrets.token_urlsafe(16)
    data: Dict[str, Optional[str]] = {'title': None, 'text': None, 'url': None}
    files, skipped, total = [], [], 0
    try:
        for field, value in form.multi_items():
            is_upload = isinstance(value, StarletteUploadFile)
            if not is_upload and field != 'files':
                if field in data:
                    data[field] = str(value).strip() or None
                continue
            # Some browsers send files without a plain "filename" (only filename*=): those arrive as text.
            content_type = value.content_type if is_upload else 'text/plain'
            mime_guess = (content_type or '').split(';')[0].strip().lower()
            ext = mimetypes.guess_extension(mime_guess) if mime_guess else None
            index = len(files) + len(skipped)
            name = sanitize_filename(value.filename if is_upload else None, f"shared-{index + 1}{ext or ''}")
            mime = guess_mime(name, content_type)
            temp_name, key = f"share_{session_id}_{index}", new_file_key()
            limit = min(MAX_FILE_SIZE, MAX_SHARE_SIZE - total, max(MAX_STORAGE_SIZE - storage_used() - total, 0))
            try:
                if is_upload:
                    size = await save_upload(value, UPLOAD_DIR / temp_name, limit, key)
                else:
                    raw = str(value).encode()
                    size = len(raw) if len(raw) <= limit else -1
                    if size > 0:
                        (UPLOAD_DIR / temp_name).write_bytes(file_cipher(key).update(raw))
            except ValueError:
                size = -1
            if size <= 0:
                remove_file(UPLOAD_DIR / temp_name)
                skipped.append(name)
                continue
            total += size
            files.append({'temp_name': temp_name, 'original_name': name, 'size': size,
                          'mime': mime, 'type': classify(mime), 'key': key})
    finally:
        await form.close()

    title, text, url = data['title'], data['text'], data['url']
    if not (title or text or url or files):
        return RedirectResponse(url="/?shareError=empty", status_code=303)

    share_sessions[session_id] = {'created': now(), 'title': title, 'text': text, 'url': url,
                                  'files': files, 'skipped': skipped}
    logger.info("[%s] Share session %s: %d file(s), %d skipped", request_id, session_id, len(files), len(skipped))
    return RedirectResponse(url=f"/?share={session_id}", status_code=303)


def get_share_session_or_404(session_id: str) -> Dict[str, Any]:
    session = share_sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Share session not found or expired. Please share again.")
    if now() - session['created'] > SHARE_SESSION_SECONDS:
        discard_share_session(session_id)
        raise HTTPException(410, "Share session expired. Please share again.")
    return session


def share_text(session: Dict[str, Any]) -> Optional[str]:
    title, text, url = session.get('title'), session.get('text'), session.get('url')
    parts = []
    if title and title not in (text or '') and title != url:
        parts.append(title)
    if text:
        parts.append(text)
    if url and url not in (text or ''):
        parts.append(url)
    combined = '\n'.join(parts).strip()
    if not combined:
        return None
    return combined[:MAX_TEXT_LENGTH]


@app.get("/api/share/{session_id}")
async def get_share_session(session_id: str):
    session = get_share_session_or_404(session_id)
    return {
        "success": True,
        "title": session['title'], "text": session['text'], "url": session['url'],
        "combined_text": share_text(session),
        "age_seconds": int(now() - session['created']),
        "expires_in": int(SHARE_SESSION_SECONDS - (now() - session['created'])),
        "files": [{'name': f['original_name'], 'size': f['size'], 'type': f['type'], 'mime': f['mime']}
                  for f in session['files']],
        "skipped": session['skipped'],
    }


@app.delete("/api/share/{session_id}")
async def cancel_share_session(session_id: str):
    discard_share_session(session_id)
    return {"success": True}


@app.post("/api/share/{session_id}/upload/{room_code}")
async def upload_shared_files(session_id: str, room_code: str, user_id: Optional[str] = None):
    """Move the content of a share session into a room."""
    code = require_room_code(room_code)
    session = get_share_session_or_404(session_id)
    share_sessions.pop(session_id, None)  # consume it - prevents double posting
    ensure_room(code)
    username = user_name_for(user_id, code)

    uploaded = []
    text = share_text(session)
    if text:
        msg = new_message(code, user_id, username, 'text', text=text)
        await add_message(code, msg)
        uploaded.append({'id': msg['id'], 'type': 'text'})

    failed = 0
    for info in session['files']:
        temp = UPLOAD_DIR / info['temp_name']
        msg = new_message(code, user_id, username, info['type'], original_name=info['original_name'],
                          mime=info['mime'], size=info['size'], key=info['key'])
        msg['filename'] = msg['id']
        try:
            shutil.move(str(temp), str(file_path_for(msg)))
        except OSError as exc:
            logger.error("Moving shared file failed: %s", exc)
            failed += 1
            continue
        await add_message(code, msg)
        uploaded.append({'id': msg['id'], 'type': info['type'], 'name': info['original_name']})

    files_done = len([u for u in uploaded if u['type'] != 'text'])
    response = {"success": bool(uploaded), "room_code": code, "url": room_path(code),
                "message": f"Uploaded {len(uploaded)} item(s)", "uploaded": uploaded,
                "expected_files": len(session['files']), "uploaded_files": files_done}
    problems = failed + len(session['skipped'])
    if problems:
        response["warning"] = f"{problems} file(s) could not be shared (empty or larger than " \
                              f"{MAX_FILE_SIZE // (1024 * 1024)} MB)"
    if not uploaded:
        return JSONResponse(response, status_code=422)
    return response


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 8000)))
