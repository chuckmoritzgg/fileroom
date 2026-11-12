"""Server side of calls, babyphone and end-to-end encryption: the server relays and stores opaque data.

Run with `pip install pytest httpx && pytest -q` (see also tests/js and tests/e2e for the browser side).
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("UPLOAD_DIR", tempfile.mkdtemp(prefix="fileroom-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def join(client, room, **params):
    r = client.get(f"/api/join/{room}", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def signal(to, data):
    return json.dumps({"type": "signal", "to": to, "data": data})


def test_signaling_is_relayed_opaquely_within_the_room(client):
    a, b, other = join(client, "SIG"), join(client, "SIG"), join(client, "ELSEWHERE")
    with client.websocket_connect(f"/ws/SIG/{a['user_id']}") as wa, \
            client.websocket_connect(f"/ws/SIG/{b['user_id']}") as wb, \
            client.websocket_connect(f"/ws/ELSEWHERE/{other['user_id']}") as wo:
        for ws in (wa, wb, wo):
            assert ws.receive_json()["type"] == "users_list"

        wa.send_text(signal(b["user_id"], "s.sealed-offer"))
        assert wb.receive_json() == {"type": "signal", "from": a["user_id"], "to": b["user_id"], "data": "s.sealed-offer"}
        wa.send_text(signal(None, "s.sealed-hello"))  # broadcast to everybody else in the room
        assert wb.receive_json() == {"type": "signal", "from": a["user_id"], "data": "s.sealed-hello"}

        # Never across rooms, never to unknown users
        wa.send_text(signal(other["user_id"], "s.wrong-room"))
        assert wa.receive_json() == {"type": "signal_error", "reason": "offline", "to": other["user_id"]}
        # Size and type limits
        wa.send_text(signal(b["user_id"], "x" * (main.MAX_SIGNAL_LENGTH + 1)))
        assert wa.receive_json() == {"type": "signal_error", "reason": "invalid"}
        wa.send_text(signal(b["user_id"], "x" * (main.MAX_SIGNAL_LENGTH + 1000)))
        assert wa.receive_json() == {"type": "signal_error", "reason": "too-large"}
        wa.send_text("{not json")
        wa.send_text("ping")
        assert wa.receive_json() == {"type": "pong"}

        # Nothing leaked into the other room, and the sender never hears itself
        wo.send_text("ping")
        assert wo.receive_json() == {"type": "pong"}
        wb.send_text("ping")
        assert wb.receive_json() == {"type": "pong"}


def test_signaling_rate_limit(client, monkeypatch):
    monkeypatch.setattr(main, "SIGNAL_BURST", 5)
    monkeypatch.setattr(main, "SIGNAL_RATE", 0.0)
    a, b = join(client, "FLOOD"), join(client, "FLOOD")
    with client.websocket_connect(f"/ws/FLOOD/{a['user_id']}") as wa, \
            client.websocket_connect(f"/ws/FLOOD/{b['user_id']}") as wb:
        wa.receive_json(), wb.receive_json()
        for i in range(6):
            wa.send_text(signal(b["user_id"], f"m{i}"))
        assert [wb.receive_json()["data"] for _ in range(5)] == [f"m{i}" for i in range(5)]
        assert wa.receive_json() == {"type": "signal_error", "reason": "rate"}


def test_ice_servers_with_short_lived_turn_credentials(client, monkeypatch):
    u = join(client, "ICE")
    assert client.get("/api/ice").status_code == 403
    assert client.get("/api/ice", params={"user_id": "nobody"}).status_code == 403
    assert client.get("/api/ice", params={"user_id": u["user_id"]}).json()["iceServers"] == []  # same Wi-Fi needs none

    monkeypatch.setattr(main, "STUN_URLS", ["stun:turn.example.org:3478"])
    monkeypatch.setattr(main, "TURN_URLS", ["turn:turn.example.org:3478"])
    monkeypatch.setattr(main, "TURN_SECRET", "s3cret")
    r = client.get("/api/ice", params={"user_id": u["user_id"]})
    assert r.headers["cache-control"] == "no-store"
    stun, turn = r.json()["iceServers"]
    assert stun == {"urls": ["stun:turn.example.org:3478"]}
    expiry, name = turn["username"].split(":")
    assert int(expiry) > main.now() and u["user_id"] not in turn["username"]
    expected = base64.b64encode(hmac.new(b"s3cret", turn["username"].encode(), hashlib.sha1).digest()).decode()
    assert turn["credential"] == expected  # what coturn computes with use-auth-secret


def test_sealed_messages_are_stored_as_they_are(client):
    u = join(client, "SEALED")
    r = client.post("/api/message/SEALED", json={"user_id": u["user_id"], "message_type": "sealed", "data": "kid.iv.ct-_"})
    assert r.status_code == 200, r.text
    msg = client.get("/api/room/SEALED/data").json()["messages"][-1]
    assert msg["type"] == "sealed" and msg["data"] == "kid.iv.ct-_" and "text" not in msg
    assert client.post("/api/message/SEALED", json={"message_type": "sealed", "data": "no spaces allowed"}).status_code == 400
    assert client.post("/api/message/SEALED", json={"message_type": "sealed"}).status_code == 400
    too_long = "a" * (main.MAX_SEALED_LENGTH + 1)
    assert client.post("/api/message/SEALED", json={"message_type": "sealed", "data": too_long}).status_code == 413
    # The server cannot put ciphertext into a ZIP as readable text
    assert client.get("/api/room/SEALED/zip").status_code == 404


def test_encrypted_upload_hides_name_and_type(client):
    u = join(client, "ENCFILE")
    files = [("files", ("holiday.jpg", b"\x00ciphertext\xff", "image/jpeg"))]
    r = client.post("/api/upload/ENCFILE", params={"user_id": u["user_id"], "enc": 1, "meta": "kid.iv.meta"}, files=files)
    assert r.status_code == 200, r.text
    msg = r.json()["files"][0]["message"]
    assert msg["type"] == "file" and msg["enc"] is True and msg["meta"] == "kid.iv.meta"
    assert msg["filename"] == "encrypted" and msg["mime"] == "application/octet-stream"
    assert "holiday" not in json.dumps(client.get("/api/room/ENCFILE/data").json())
    d = client.get(f"/api/download/{msg['id']}")
    assert d.content == b"\x00ciphertext\xff" and d.headers["content-type"] == "application/octet-stream"
    assert client.get("/api/room/ENCFILE/zip").status_code == 404
    assert client.post("/api/upload/ENCFILE", params={"enc": 1}, files=files).status_code == 400  # meta is required


def vapid_token():
    return "vapid t=" + ".".join(["abc_-"] * 3) + ", k=" + "B" * 87


def test_push_relay_forwards_ciphertext_to_push_services_only(client, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "forward_push", lambda endpoint, headers, body: calls.append((endpoint, headers, body)) or 201)
    u = join(client, "PUSH")
    good = {"user_id": u["user_id"], "endpoint": "https://fcm.googleapis.com/fcm/send/xyz", "auth": vapid_token(),
            "body": base64.urlsafe_b64encode(b"\x01" * 120).decode().rstrip("="), "ttl": 120, "topic": "fr-noise"}
    assert client.post("/api/push", json=good).json() == {"success": True, "status": 201}
    endpoint, headers, body = calls[0]
    assert endpoint == good["endpoint"] and body == b"\x01" * 120
    assert headers["Authorization"] == good["auth"] and headers["Content-Encoding"] == "aes128gcm"
    assert headers["TTL"] == "120" and headers["Urgency"] == "high" and headers["Topic"] == "fr-noise"

    for bad in ({"endpoint": "https://evil.example/x"}, {"endpoint": "http://fcm.googleapis.com/x"},
                {"endpoint": "https://fcm.googleapis.com.evil.example/x"}, {"endpoint": "https://user@fcm.googleapis.com/x"},
                {"endpoint": "https://fcm.googleapis.com:8443/x"}, {"endpoint": "https://169.254.169.254/latest/meta-data"},
                {"endpoint": "https://localhost/x"}, {"auth": "Bearer abc"}, {"body": ""},
                {"body": base64.urlsafe_b64encode(b"x" * (main.PUSH_MAX_BODY + 1)).decode()}):
        assert client.post("/api/push", json={**good, **bad}).status_code == 400, bad
    assert client.post("/api/push", json={**good, "user_id": "nobody"}).status_code == 403
    assert len(calls) == 1

    monkeypatch.setattr(main, "PUSH_RELAY", False)
    assert client.post("/api/push", json=good).status_code == 404


def test_push_relay_rate_limit(client, monkeypatch):
    monkeypatch.setattr(main, "forward_push", lambda *args: 201)
    monkeypatch.setattr(main, "PUSH_BURST", 3)
    monkeypatch.setattr(main, "PUSH_RATE", 0.0)
    u = join(client, "PUSHLIMIT")
    body = {"user_id": u["user_id"], "endpoint": "https://fcm.googleapis.com/fcm/send/xyz", "auth": vapid_token(), "body": "AQID"}
    assert [client.post("/api/push", json=body).status_code for _ in range(5)] == [200, 200, 200, 429, 429]


def test_new_random_room_is_marked_for_key_creation(client):
    r = client.get("/", follow_redirects=False)
    assert r.headers["location"].startswith("/room/") and r.headers["location"].endswith("?new=1")
    r = client.get("/?shareError=empty", follow_redirects=False)
    assert r.headers["location"].endswith("?new=1&shareError=empty")
    client.cookies.set("fileroom_last_room", "LASTROOM")
    r = client.get("/?source=pwa", follow_redirects=False)
    assert r.headers["location"] == "/room/LASTROOM"  # an existing room keeps its (stored) key
    client.cookies.clear()


def test_room_shell_and_service_worker_ship_the_voice_code(client):
    shell = client.get("/shell/room.html").text
    for script in ("e2ee.js", "qr.js", "app.js", "voice.js"):
        assert f"/static/js/{script}?v=" in shell
    sw = client.get("/sw.js").text
    assets = [a[0] for a in json.loads(sw.split("const ASSETS = ")[1].split(";\n")[0])]
    assert "/static/js/level-worklet.js" in assets and "/static/js/voice.js" in assets
    assert "addEventListener('push'" in sw and "notificationclick" in sw
