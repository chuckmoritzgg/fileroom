"""
FileRoom Perfect - Enhanced with link previews and perfect UX
"""
import os
import asyncio
import secrets
import string
import logging
import re
import aiohttp
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Set
from pathlib import Path
from io import BytesIO
import json
from urllib.parse import urlparse

import aiofiles
import qrcode

from fastapi import FastAPI, File, UploadFile, Request, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Config
UPLOAD_DIR = Path("uploads")
MAX_FILE_SIZE = 100 * 1024 * 1024
MESSAGE_EXPIRY_HOURS = 1
USER_TIMEOUT_SECONDS = 60

UPLOAD_DIR.mkdir(exist_ok=True, mode=0o777)

# App
app = FastAPI(title="FileRoom", version="6.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Storage
messages_db = {}
rooms_db = {}
users_db = {}
room_users = {}
websockets: Dict[str, WebSocket] = {}
link_previews = {}  # Cache for link previews

# Name generator
ADJECTIVES = ['Happy', 'Sunny', 'Bright', 'Swift', 'Cool', 'Smart', 'Lucky', 'Bold', 'Calm', 'Free']
NOUNS = ['Panda', 'Tiger', 'Eagle', 'Dolphin', 'Fox', 'Bear', 'Wolf', 'Cat', 'Dog', 'Lion']

def generate_room_code():
    chars = string.ascii_uppercase + string.digits
    chars = chars.replace('0', '').replace('O', '').replace('1', '').replace('I', '')
    return ''.join(secrets.choice(chars) for _ in range(6))

def generate_user_name():
    return f"{secrets.choice(ADJECTIVES)}{secrets.choice(NOUNS)}"

def generate_id():
    return secrets.token_urlsafe(8)

def extract_links(text):
    """Extract URLs from text"""
    url_pattern = re.compile(
        r'http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+'
    )
    return url_pattern.findall(text)

async def get_link_preview(url):
    """Get basic link preview data"""
    if url in link_previews:
        return link_previews[url]

    try:
        # Basic preview - just extract domain and title if possible
        parsed = urlparse(url)
        domain = parsed.netloc

        preview = {
            'url': url,
            'domain': domain,
            'title': domain,
            'description': f'Link to {domain}'
        }

        # Cache the preview
        link_previews[url] = preview
        return preview

    except Exception as e:
        logger.error(f"Error getting link preview: {e}")
        return None

async def broadcast_to_room(room_code: str, message: dict):
    """Broadcast message to all users in room"""
    if room_code not in room_users:
        return

    disconnected = []
    for user_id in room_users[room_code]:
        if user_id in websockets:
            try:
                await websockets[user_id].send_json(message)
            except Exception as e:
                logger.error(f"Failed to send to {user_id}: {e}")
                disconnected.append(user_id)

    for user_id in disconnected:
        if user_id in websockets:
            del websockets[user_id]

async def check_user_activity():
    """Remove inactive users"""
    while True:
        try:
            await asyncio.sleep(30)
            current = datetime.now()

            for room_code in list(room_users.keys()):
                inactive_users = []

                for user_id in list(room_users[room_code]):
                    if user_id in users_db:
                        last_seen = users_db[user_id].get('last_seen')
                        if last_seen and (current - last_seen).total_seconds() > USER_TIMEOUT_SECONDS:
                            inactive_users.append(user_id)

                for user_id in inactive_users:
                    user_name = users_db[user_id]['name'] if user_id in users_db else 'User'
                    room_users[room_code].discard(user_id)

                    await broadcast_to_room(room_code, {
                        'type': 'user_left',
                        'user_id': user_id,
                        'user_name': user_name
                    })

        except Exception as e:
            logger.error(f"User activity check error: {e}")

async def cleanup_expired():
    """Cleanup expired messages"""
    while True:
        try:
            await asyncio.sleep(60)
            current = datetime.now()

            expired = [mid for mid, msg in messages_db.items() if current >= msg['expiry']]
            for mid in expired:
                try:
                    msg = messages_db[mid]
                    if msg['type'] in ['file', 'image', 'voice']:
                        file_path = UPLOAD_DIR / msg['filename']
                        if file_path.exists():
                            file_path.unlink()
                    del messages_db[mid]
                except Exception as e:
                    logger.error(f"Cleanup error: {e}")

        except Exception as e:
            logger.error(f"Cleanup loop error: {e}")

@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup_expired())
    asyncio.create_task(check_user_activity())
    logger.info("FileRoom Perfect started")

# Routes
@app.get("/", response_class=HTMLResponse)
async def home():
    room_code = generate_room_code()
    return HTMLResponse(f'<meta http-equiv="refresh" content="0;url=/room/{room_code}">')

@app.get("/room/{room_code}", response_class=HTMLResponse)
async def room_page(request: Request, room_code: str):
    room_code = room_code.upper()

    if room_code not in rooms_db:
        rooms_db[room_code] = {
            'code': room_code,
            'created': datetime.now(),
            'messages': []
        }
        room_users[room_code] = set()

    # QR code
    qr_code = ""
    try:
        qr = qrcode.QRCode(version=1, box_size=6, border=2)
        qr.add_data(str(request.url))
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buffer = BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        import base64
        qr_code = f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"
    except:
        pass

    # Get messages
    room_messages = []
    now = datetime.now()
    for mid in rooms_db[room_code]['messages']:
        if mid in messages_db:
            msg = messages_db[mid]
            if now < msg['expiry']:
                remaining = int((msg['expiry'] - now).total_seconds())

                msg_data = {
                    'id': mid,
                    'type': msg['type'],
                    'username': msg['username'],
                    'time': msg['timestamp'].strftime("%H:%M"),
                    'time_remaining': remaining
                }

                if msg['type'] == 'text':
                    msg_data['text'] = msg['text']
                    # Extract links for preview
                    links = extract_links(msg['text'])
                    msg_data['links'] = links
                elif msg['type'] == 'location':
                    msg_data['latitude'] = msg.get('latitude')
                    msg_data['longitude'] = msg.get('longitude')
                elif msg['type'] in ['file', 'image', 'voice']:
                    msg_data['filename'] = msg['original_name']
                    msg_data['size_mb'] = round(msg['size'] / (1024*1024), 2)

                room_messages.append(msg_data)

    return templates.TemplateResponse("room.html", {
        "request": request,
        "room_code": room_code,
        "qr_code": qr_code,
        "messages": room_messages,
        "base_url": str(request.base_url).rstrip('/')
    })

@app.get("/api/join/{room_code}")
async def join_room(
    room_code: str,
    user_id: Optional[str] = Query(None),
    user_name: Optional[str] = Query(None)
):
    """Join room"""
    try:
        room_code = room_code.upper()

        if room_code not in rooms_db:
            rooms_db[room_code] = {
                'code': room_code,
                'created': datetime.now(),
                'messages': []
            }
            room_users[room_code] = set()

        if user_id and user_id in users_db:
            users_db[user_id]['last_seen'] = datetime.now()

            if user_name and user_name.strip():
                old_name = users_db[user_id]['name']
                users_db[user_id]['name'] = user_name.strip()[:20]

                await broadcast_to_room(room_code, {
                    'type': 'user_renamed',
                    'user_id': user_id,
                    'old_name': old_name,
                    'new_name': users_db[user_id]['name']
                })

            room_users[room_code].add(user_id)

            return {
                "success": True,
                "user_id": user_id,
                "user_name": users_db[user_id]['name'],
                "existing": True
            }

        new_user_id = generate_id()
        if not user_name or not user_name.strip():
            user_name = generate_user_name()
        else:
            user_name = user_name.strip()[:20]

        users_db[new_user_id] = {
            'id': new_user_id,
            'name': user_name,
            'room': room_code,
            'joined': datetime.now(),
            'last_seen': datetime.now()
        }

        room_users[room_code].add(new_user_id)

        await broadcast_to_room(room_code, {
            'type': 'user_joined',
            'user_id': new_user_id,
            'user_name': user_name
        })

        return {
            "success": True,
            "user_id": new_user_id,
            "user_name": user_name,
            "existing": False
        }

    except Exception as e:
        logger.error(f"Join error: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.post("/api/message/{room_code}")
async def send_message(
    room_code: str,
    text: str = Query(None),
    user_id: str = Query(...),
    message_type: str = Query("text"),
    latitude: Optional[float] = Query(None),
    longitude: Optional[float] = Query(None)
):
    """Send text or location message"""
    try:
        room_code = room_code.upper()

        if room_code not in rooms_db:
            raise HTTPException(status_code=404, detail="Room not found")

        username = "Anonymous"
        if user_id in users_db:
            username = users_db[user_id]['name']
            users_db[user_id]['last_seen'] = datetime.now()

        msg_id = generate_id()
        now = datetime.now()
        expiry = now + timedelta(hours=MESSAGE_EXPIRY_HOURS)

        if message_type == 'location':
            if latitude is None or longitude is None:
                raise HTTPException(status_code=400, detail="Missing location data")

            messages_db[msg_id] = {
                'id': msg_id,
                'type': 'location',
                'latitude': latitude,
                'longitude': longitude,
                'username': username,
                'user_id': user_id,
                'room': room_code,
                'timestamp': now,
                'expiry': expiry
            }

            await broadcast_to_room(room_code, {
                'type': 'new_message',
                'message': {
                    'id': msg_id,
                    'type': 'location',
                    'latitude': latitude,
                    'longitude': longitude,
                    'username': username,
                    'time': now.strftime("%H:%M"),
                    'time_remaining': int((expiry - now).total_seconds())
                }
            })
        else:
            if not text or not text.strip():
                raise HTTPException(status_code=400, detail="Empty message")

            # Extract links
            links = extract_links(text.strip())

            messages_db[msg_id] = {
                'id': msg_id,
                'type': 'text',
                'text': text.strip(),
                'username': username,
                'user_id': user_id,
                'room': room_code,
                'timestamp': now,
                'expiry': expiry
            }

            await broadcast_to_room(room_code, {
                'type': 'new_message',
                'message': {
                    'id': msg_id,
                    'type': 'text',
                    'text': text.strip(),
                    'links': links,
                    'username': username,
                    'time': now.strftime("%H:%M"),
                    'time_remaining': int((expiry - now).total_seconds())
                }
            })

        rooms_db[room_code]['messages'].append(msg_id)

        return {"success": True, "message_id": msg_id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Send message error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/upload/{room_code}")
async def upload_file(
    room_code: str,
    files: List[UploadFile] = File(...),
    user_id: Optional[str] = Query(None),
    message_type: str = Query("file")
):
    """Upload file/image/voice"""
    try:
        room_code = room_code.upper()

        if room_code not in rooms_db:
            raise HTTPException(status_code=404, detail="Room not found")

        username = "Anonymous"
        if user_id and user_id in users_db:
            username = users_db[user_id]['name']
            users_db[user_id]['last_seen'] = datetime.now()

        uploaded = []
        now = datetime.now()
        expiry = now + timedelta(hours=MESSAGE_EXPIRY_HOURS)

        for file in files:
            if not file.filename:
                continue

            content = await file.read()

            if len(content) > MAX_FILE_SIZE:
                continue

            msg_id = generate_id()
            safe_name = f"{msg_id}_{file.filename}"
            file_path = UPLOAD_DIR / safe_name

            async with aiofiles.open(file_path, 'wb') as f:
                await f.write(content)

            messages_db[msg_id] = {
                'id': msg_id,
                'type': message_type,
                'original_name': file.filename,
                'filename': safe_name,
                'size': len(content),
                'username': username,
                'user_id': user_id,
                'room': room_code,
                'timestamp': now,
                'expiry': expiry
            }

            rooms_db[room_code]['messages'].append(msg_id)

            await broadcast_to_room(room_code, {
                'type': 'new_message',
                'message': {
                    'id': msg_id,
                    'type': message_type,
                    'filename': file.filename,
                    'size_mb': round(len(content) / (1024*1024), 2),
                    'username': username,
                    'time': now.strftime("%H:%M"),
                    'time_remaining': int((expiry - now).total_seconds())
                }
            })

            uploaded.append({'id': msg_id, 'name': file.filename})

        return {
            "success": True,
            "message": f"{len(uploaded)} file(s) uploaded",
            "files": uploaded
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/message/{message_id}")
async def delete_message(message_id: str):
    """Delete message"""
    try:
        if message_id not in messages_db:
            raise HTTPException(status_code=404, detail="Message not found")

        msg = messages_db[message_id]
        room_code = msg['room']

        if msg['type'] in ['file', 'image', 'voice']:
            file_path = UPLOAD_DIR / msg['filename']
            if file_path.exists():
                file_path.unlink()

        del messages_db[message_id]

        if room_code in rooms_db:
            if message_id in rooms_db[room_code]['messages']:
                rooms_db[room_code]['messages'].remove(message_id)

        await broadcast_to_room(room_code, {
            'type': 'message_deleted',
            'message_id': message_id
        })

        return {"success": True, "message": "Deleted"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/room/{room_code}/data")
async def get_room_data(room_code: str):
    """Get messages and active users"""
    try:
        room_code = room_code.upper()

        if room_code not in rooms_db:
            return {"messages": [], "users": []}

        room_messages = []
        now = datetime.now()
        for mid in rooms_db[room_code]['messages']:
            if mid in messages_db:
                msg = messages_db[mid]
                if now < msg['expiry']:
                    remaining = int((msg['expiry'] - now).total_seconds())

                    msg_data = {
                        'id': mid,
                        'type': msg['type'],
                        'username': msg['username'],
                        'time': msg['timestamp'].strftime("%H:%M"),
                        'time_remaining': remaining
                    }

                    if msg['type'] == 'text':
                        msg_data['text'] = msg['text']
                        msg_data['links'] = extract_links(msg['text'])
                    elif msg['type'] == 'location':
                        msg_data['latitude'] = msg.get('latitude')
                        msg_data['longitude'] = msg.get('longitude')
                    elif msg['type'] in ['file', 'image', 'voice']:
                        msg_data['filename'] = msg['original_name']
                        msg_data['size_mb'] = round(msg['size'] / (1024*1024), 2)

                    room_messages.append(msg_data)

        users = []
        for uid in room_users.get(room_code, set()):
            if uid in users_db:
                last_seen = users_db[uid].get('last_seen')
                if last_seen and (now - last_seen).total_seconds() < USER_TIMEOUT_SECONDS:
                    users.append({
                        'id': uid,
                        'name': users_db[uid]['name']
                    })

        return {
            "messages": room_messages,
            "users": users
        }

    except Exception as e:
        logger.error(f"Get room data error: {e}")
        return {"messages": [], "users": []}

@app.get("/api/download/{message_id}")
async def download_file(message_id: str):
    """Download file"""
    try:
        if message_id not in messages_db:
            raise HTTPException(status_code=404, detail="File not found")

        msg = messages_db[message_id]

        if msg['type'] not in ['file', 'image', 'voice']:
            raise HTTPException(status_code=400, detail="Not a file")

        file_path = UPLOAD_DIR / msg['filename']

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not on disk")

        if datetime.now() >= msg['expiry']:
            raise HTTPException(status_code=410, detail="File expired")

        return FileResponse(
            path=file_path,
            filename=msg['original_name'],
            media_type='application/octet-stream'
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/heartbeat/{user_id}")
async def heartbeat(user_id: str):
    """Update user last seen"""
    if user_id in users_db:
        users_db[user_id]['last_seen'] = datetime.now()
        return {"success": True}
    return {"success": False}

@app.websocket("/ws/{room_code}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, room_code: str, user_id: str):
    """WebSocket for real-time updates"""
    await websocket.accept()
    room_code = room_code.upper()

    websockets[user_id] = websocket

    try:
        users = []
        now = datetime.now()
        for uid in room_users.get(room_code, set()):
            if uid in users_db:
                last_seen = users_db[uid].get('last_seen')
                if last_seen and (now - last_seen).total_seconds() < USER_TIMEOUT_SECONDS:
                    users.append({
                        'id': uid,
                        'name': users_db[uid]['name']
                    })

        await websocket.send_json({
            'type': 'users_list',
            'users': users
        })

        while True:
            data = await websocket.receive_text()

            if user_id in users_db:
                users_db[user_id]['last_seen'] = datetime.now()

    except WebSocketDisconnect:
        if user_id in websockets:
            del websockets[user_id]
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        if user_id in websockets:
            del websockets[user_id]

@app.get("/favicon.ico")
async def favicon():
    favicon_path = Path("static/images/favicon.ico")
    if favicon_path.exists():
        return FileResponse(favicon_path)
    return Response(status_code=204)

@app.get("/manifest.json")
async def manifest():
    return {
        "name": "FileRoom",
        "short_name": "FileRoom",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#ffffff",
        "theme_color": "#2563eb"
    }

@app.delete("/api/room/{room_code}/all")
async def delete_all_room_data(room_code: str):
    """Delete all messages and files in a room"""
    try:
        room_code = room_code.upper()
        
        if room_code not in rooms_db:
            raise HTTPException(status_code=404, detail="Room not found")
        
        deleted_count = 0
        
        # Get all message IDs for this room
        message_ids = list(rooms_db[room_code]['messages'])
        
        # Delete all messages and their files
        for message_id in message_ids:
            if message_id in messages_db:
                msg = messages_db[message_id]
                
                # Delete file if it exists
                if msg['type'] in ['file', 'image', 'voice']:
                    file_path = UPLOAD_DIR / msg['filename']
                    if file_path.exists():
                        file_path.unlink()
                
                # Remove from messages_db
                del messages_db[message_id]
                deleted_count += 1
        
        # Clear the room's message list
        rooms_db[room_code]['messages'] = []
        
        # Broadcast room cleared event
        await broadcast_to_room(room_code, {
            'type': 'room_cleared',
            'message': 'All messages deleted'
        })
        
        return {"success": True, "message": f"Deleted {deleted_count} messages", "count": deleted_count}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete all error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
