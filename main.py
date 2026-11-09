"""
FileRoom - ephemeral rooms for sharing files, messages, voice notes and locations.

All state lives in memory (and uploaded files in UPLOAD_DIR, a tmpfs in Docker).
Everything expires automatically.
"""
from __future__ import annotations

import asyncio
import hashlib
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
from email import message_from_bytes
from email.policy import default as email_default_policy
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote

import qrcode
from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
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
    else:
        data['filename'] = msg['original_name']
        data['size'] = msg['size']
        data['size_mb'] = round(msg['size'] / (1024 * 1024), 2)
        data['mime'] = msg['mime']
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


async def save_upload(upload: StarletteUploadFile, dest: Path, limit: int) -> int:
    """Stream an uploaded file to disk. Returns size, raises ValueError if too large."""
    size = 0
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
            out.write(chunk)
    return size


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
    'js/app.js',
    'js/pwa.js',
    'js/share.js',
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
        "description": "Share files, messages, voice notes and locations in temporary rooms",
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
    task = asyncio.create_task(cleanup_loop())
    logger.info("FileRoom %s started", APP_VERSION)
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
    url = room_path(target or generate_room_code())
    if shareError:
        url += f"?shareError={quote(shareError)}"
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
async def join_room(room_code: str, user_id: Optional[str] = None, user_name: Optional[str] = None):
    code = require_room_code(room_code)
    ensure_room(code)
    touch_room(code)
    name = clean_name(user_name)

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
    else:
        raise HTTPException(400, "Unknown message type")

    data = await add_message(code, msg)
    return {"success": True, "message_id": msg['id'], "message": data}


@app.post("/api/upload/{room_code}")
async def upload_file(request: Request, room_code: str, user_id: Optional[str] = None,
                      message_type: str = "file"):
    code = require_room_code(room_code)
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
            name = sanitize_filename(upload.filename, 'voice_message' if message_type == 'voice' else 'file')
            mime = guess_mime(name, upload.content_type)
            msg = new_message(code, user_id, username, classify(mime, message_type),
                              original_name=name, mime=mime, size=0)
            msg['filename'] = msg['id']
            try:
                msg['size'] = await save_upload(upload, file_path_for(msg), MAX_FILE_SIZE)
            except ValueError:
                rejected.append({'name': name, 'reason': f'larger than {MAX_FILE_SIZE // (1024 * 1024)} MB'})
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
async def download_file(message_id: str):
    msg = get_file_message(message_id)
    # Always served as an attachment with its real type: <img>/<audio>/<video> can still embed it,
    # while opening it directly never renders user content as a page on this origin.
    response = FileResponse(file_path_for(msg), media_type=msg['mime'], filename=msg['original_name'])
    response.headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    response.headers['Cache-Control'] = 'private, max-age=3600'
    return response


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
        if (msg['type'] in FILE_TYPES and file_path_for(msg).exists()) or message_text(msg):
            msgs.append(msg)
    if not msgs:
        raise HTTPException(404, "Nothing to download")

    def build_zip() -> str:
        fd, path = tempfile.mkstemp(prefix='fileroom-zip-', suffix='.zip')
        used: Set[str] = set()
        with os.fdopen(fd, 'wb') as fh, zipfile.ZipFile(fh, 'w', zipfile.ZIP_STORED, allowZip64=True) as zf:
            for msg in msgs:
                if msg['type'] in FILE_TYPES:
                    zf.write(file_path_for(msg), unique_name(msg['original_name'], used))
                else:
                    zf.writestr(unique_name(text_filename(msg, tz), used), message_text(msg) + '\n')
        return path

    path = await asyncio.to_thread(build_zip)
    filename = f"FileRoom-{code}-{time.strftime('%Y%m%d-%H%M')}.zip"
    return FileResponse(path, media_type='application/zip', filename=filename,
                        background=BackgroundTask(remove_file, Path(path)))


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

    try:
        await websocket.send_json({'type': 'users_list', 'users': active_users(code)})
        while True:
            data = await websocket.receive_text()
            user['last_seen'] = now()
            if data == 'ping':
                await websocket.send_json({'type': 'pong'})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.info("WebSocket error: %s", exc)
    finally:
        drop_connection(code, user_id, websocket)
        user['last_seen'] = now()


# ----- Share target (incoming shares from other apps) ----------------------
async def parse_share_form(request: Request, body: bytes) -> Dict[str, Any]:
    """Return {'title', 'text', 'url', 'files': [(filename, content_type, bytes)]}."""
    result: Dict[str, Any] = {'title': None, 'text': None, 'url': None, 'files': []}
    try:
        form = await request.form(max_files=1000, max_fields=1000)
        try:
            for key, value in form.multi_items():
                if isinstance(value, StarletteUploadFile):
                    await value.seek(0)
                    content = await value.read()
                    result['files'].append((value.filename, value.content_type, content))
                elif key in ('title', 'text', 'url'):
                    result[key] = str(value).strip() or None
        finally:
            await form.close()
        return result
    except Exception as exc:
        logger.warning("Standard form parsing failed (%s), using fallback parser", exc)

    # Fallback for browsers that send slightly non-standard multipart bodies.
    content_type = request.headers.get('content-type', '')
    if 'multipart/' not in content_type:
        raise ValueError("Unsupported content type")
    msg = message_from_bytes(f"MIME-Version: 1.0\r\nContent-Type: {content_type}\r\n\r\n".encode() + body,
                             policy=email_default_policy)
    if not msg.is_multipart():
        raise ValueError("Malformed multipart body")
    for part in msg.iter_parts():
        name = part.get_param('name', header='content-disposition')
        filename = part.get_filename()
        content = part.get_payload(decode=True) or b''
        if filename is not None or (name == 'files'):
            result['files'].append((filename, part.get_content_type(), content))
        elif name in ('title', 'text', 'url'):
            result[name] = content.decode(part.get_content_charset() or 'utf-8', errors='replace').strip() or None
    return result


@app.post("/share")
async def handle_share_target(request: Request):
    """PWA Web Share Target: receives text, links and any number of files from other apps."""
    request_id = secrets.token_urlsafe(6)
    try:
        length = int(request.headers.get('content-length') or 0)
        if length > MAX_SHARE_SIZE:
            return RedirectResponse(url="/?shareError=too-large", status_code=303)
        body = await request.body()  # cached, so the fallback parser can re-read it
        if len(body) > MAX_SHARE_SIZE:
            return RedirectResponse(url="/?shareError=too-large", status_code=303)
        data = await parse_share_form(request, body)
    except Exception:
        logger.exception("[%s] Share parsing failed", request_id)
        return RedirectResponse(url="/?shareError=invalid", status_code=303)

    session_id = secrets.token_urlsafe(16)
    files, skipped = [], []
    for index, (filename, content_type, content) in enumerate(data['files']):
        mime_guess = (content_type or '').split(';')[0].strip().lower()
        ext = mimetypes.guess_extension(mime_guess) if mime_guess else None
        name = sanitize_filename(filename, f"shared-{index + 1}{ext or ''}")
        if not content:
            skipped.append(name)
            continue
        if len(content) > MAX_FILE_SIZE:
            skipped.append(name)
            continue
        mime = guess_mime(name, content_type)
        temp_name = f"share_{session_id}_{index}"
        (UPLOAD_DIR / temp_name).write_bytes(content)
        files.append({'temp_name': temp_name, 'original_name': name, 'size': len(content),
                      'mime': mime, 'type': classify(mime)})

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
                          mime=info['mime'], size=info['size'])
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
