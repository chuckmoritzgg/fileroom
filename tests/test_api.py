"""API regression tests: run with `pip install pytest httpx && pytest -q`."""
import hashlib
import io
import json
import re
import os
import sys
import tempfile
import zipfile
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


@pytest.mark.parametrize("raw,expected", [
    ("abc123", "ABC123"),
    ("A", "A"),
    ("my team room", "MY-TEAM-ROOM"),
    ("münchen", "MÜNCHEN"),
    ("x" * 64, "X" * 64),
    ("team_2026-q4", "TEAM_2026-Q4"),
])
def test_room_codes_of_any_length_are_valid(client, raw, expected):
    assert main.normalize_room_code(raw) == expected
    data = join(client, raw)
    assert data["room_code"] == expected


@pytest.mark.parametrize("raw", ["", "   ", "a/b", "a.b", "<script>", "x" * 65])
def test_invalid_room_codes(client, raw):
    assert main.normalize_room_code(raw) is None


def test_room_page_redirects_to_canonical_code(client):
    r = client.get("/room/hello%20world", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/room/HELLO-WORLD"
    r = client.get("/room/HELLO-WORLD")
    assert r.status_code == 200 and 'name="app-build"' in r.text


def test_text_message_and_xss_safe_storage(client):
    u = join(client, "ROOM1")
    payload = {"text": "hi <b>x</b> https://example.com/a?b=1", "user_id": u["user_id"]}
    r = client.post("/api/message/ROOM1", json=payload)
    assert r.status_code == 200
    data = client.get("/api/room/ROOM1/data").json()
    msg = data["messages"][-1]
    assert msg["text"] == payload["text"] and msg["username"] == u["user_name"]
    assert msg["links"] == ["https://example.com/a?b=1"]


def test_rejoin_does_not_spam_rename(client):
    u = join(client, "ROOM2", user_name="Alice")
    with client.websocket_connect(f"/ws/ROOM2/{u['user_id']}") as ws:
        assert ws.receive_json()["type"] == "users_list"
        join(client, "ROOM2", user_id=u["user_id"], user_name="Alice")  # same name -> no event
        join(client, "ROOM2", user_id=u["user_id"], user_name="Bob")
        event = ws.receive_json()
        assert event == {"type": "user_renamed", "user_id": u["user_id"], "old_name": "Alice", "new_name": "Bob"}


def test_multi_file_upload_download_zip(client):
    u = join(client, "FILES")
    files = [
        ("files", ("../../etc/passwd", b"evil", "text/plain")),
        ("files", ("photo.png", b"\x89PNG fake", "image/png")),
        ("files", ("clip.mp4", b"video", "video/mp4")),
        ("files", ("doc.pdf", b"%PDF", "application/pdf")),
    ]
    r = client.post("/api/upload/FILES", params={"user_id": u["user_id"]}, files=files)
    assert r.status_code == 200, r.text
    uploaded = r.json()["files"]
    assert [f["type"] for f in uploaded] == ["file", "image", "video", "file"]
    assert uploaded[0]["name"] == "passwd"  # path components stripped
    for f in Path(main.UPLOAD_DIR).iterdir():
        assert f.resolve().parent == Path(main.UPLOAD_DIR).resolve()

    d = client.get(f"/api/download/{uploaded[1]['id']}")
    assert d.status_code == 200 and d.content == b"\x89PNG fake"
    assert d.headers["content-type"] == "image/png"
    assert "attachment" in d.headers["content-disposition"]
    assert d.headers["x-content-type-options"] == "nosniff"

    ids = ",".join(f["id"] for f in uploaded[1:])
    z = client.get("/api/room/FILES/zip", params={"ids": ids})
    assert z.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert sorted(names) == ["clip.mp4", "doc.pdf", "photo.png"]


def test_voice_and_oversize(client, monkeypatch):
    u = join(client, "VOICE")
    r = client.post("/api/upload/VOICE", params={"user_id": u["user_id"], "message_type": "voice"},
                    files=[("files", ("voice_message.webm", b"abc", "audio/webm;codecs=opus"))])
    assert r.json()["files"][0]["type"] == "voice"
    monkeypatch.setattr(main, "MAX_FILE_SIZE", 10)
    r = client.post("/api/upload/VOICE", files=[("files", ("big.bin", b"x" * 11, "application/octet-stream"))])
    assert r.status_code == 413


def test_share_target_multiple_files_and_text(client):
    files = [("files", (f"pic{i}.jpg", f"img{i}".encode(), "image/jpeg")) for i in range(5)]
    files.append(("files", ("notes.txt", b"hello", "text/plain")))
    r = client.post("/share", data={"title": "Holiday", "text": "Look at these", "url": "https://x.example/p"},
                    files=files, follow_redirects=False)
    assert r.status_code == 303
    sid = r.headers["location"].split("share=")[1]
    page = client.get(f"/?share={sid}")
    assert page.status_code == 200 and "share.js" in page.text
    info = client.get(f"/api/share/{sid}").json()
    assert len(info["files"]) == 6
    assert info["combined_text"] == "Holiday\nLook at these\nhttps://x.example/p"

    u = join(client, "My Shared Room")
    res = client.post(f"/api/share/{sid}/upload/My Shared Room", params={"user_id": u["user_id"]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["uploaded_files"] == 6 and body["room_code"] == "MY-SHARED-ROOM"
    msgs = client.get("/api/room/MY-SHARED-ROOM/data").json()["messages"]
    assert [m["type"] for m in msgs] == ["text"] + ["image"] * 5 + ["file"]
    # Session is consumed: sharing twice is not possible
    assert client.post(f"/api/share/{sid}/upload/OTHER").status_code == 404


def test_share_target_fallback_parser(client):
    boundary = "----SamsungBoundary"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename*=UTF-8''%C3%BCber.txt\r\n"
        f"Content-Type: text/plain\r\n\r\nueber\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nhi\r\n--{boundary}--\r\n"
    ).encode()
    r = client.post("/share", content=body, headers={"content-type": f"multipart/form-data; boundary={boundary}"},
                    follow_redirects=False)
    assert r.status_code == 303 and "share=" in r.headers["location"]
    sid = r.headers["location"].split("share=")[1]
    info = client.get(f"/api/share/{sid}").json()
    assert info["text"] == "hi" and len(info["files"]) == 1


def test_empty_share(client):
    r = client.post("/share", data={"text": ""}, files=[("files", ("", b"", "application/octet-stream"))],
                    follow_redirects=False)
    assert r.headers["location"] == "/?shareError=empty"


def test_pwa_assets_are_consistent(client):
    v = client.get("/version.json").json()
    sw = client.get("/sw.js")
    assert sw.headers["cache-control"] == "no-cache"
    assert f'const BUILD = "{v["build"]}";' in sw.text
    assets = json.loads(sw.text.split("const ASSETS = ")[1].split(";\n")[0])
    for path, digest in assets:
        r = client.get(path)
        assert r.status_code == 200, path
        assert hashlib.sha256(r.content).hexdigest() == digest, path
    shell = client.get("/shell/room.html").text
    assert f'<meta name="app-build" content="{v["build"]}">' in shell
    manifest = client.get("/manifest.webmanifest").json()
    assert manifest["share_target"]["params"]["files"][0]["name"] == "files"
    assert manifest["start_url"] == "/?source=pwa"


def test_pwa_launch_reopens_last_room(client):
    client.cookies.set("fileroom_last_room", "LASTROOM")
    r = client.get("/?source=pwa", follow_redirects=False)
    assert r.headers["location"] == "/room/LASTROOM"
    client.cookies.clear()
    r = client.get("/", follow_redirects=False)
    assert r.headers["location"].startswith("/room/") and r.headers["location"] != "/room/LASTROOM"


def test_unknown_websocket_user_is_asked_to_rejoin(client):
    with client.websocket_connect("/ws/ABC/doesnotexist") as ws:
        assert ws.receive_json() == {"type": "rejoin"}


def test_delete_all(client):
    u = join(client, "DEL")
    client.post("/api/message/DEL", json={"text": "a", "user_id": u["user_id"]})
    client.post("/api/upload/DEL", files=[("files", ("a.txt", b"a", "text/plain"))])
    assert client.delete("/api/room/DEL/all").json()["count"] == 2
    assert client.get("/api/room/DEL/data").json()["messages"] == []


def test_browser_escaped_filename():
    assert main.sanitize_filename('it\'s %22quoted%22.txt') == "it's quoted.txt"


def test_zip_contains_texts_as_timestamp_txt(client):
    u = join(client, "ZIPTEXT")
    client.post("/api/message/ZIPTEXT", json={"text": "first", "user_id": u["user_id"]})
    client.post("/api/message/ZIPTEXT", json={"text": "second", "user_id": u["user_id"]})
    client.post("/api/upload/ZIPTEXT", files=[("files", ("a.txt", b"file", "text/plain"))])
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/room/ZIPTEXT/zip", params={"tz": -60}).content))
    names = z.namelist()
    texts = [n for n in names if n != "a.txt"]
    assert len(texts) == 2 and all(re.fullmatch(r"\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d( \(\d\))?\.txt", n) for n in texts)
    assert sorted(z.read(n).decode().strip() for n in texts) == ["first", "second"]
