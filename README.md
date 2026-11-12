# FileRoom

![Version](https://img.shields.io/badge/Version-2.6.0-blue.svg)
![Docker](https://img.shields.io/badge/Dockerized-yes-green.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)
![Lightweight](https://img.shields.io/badge/RAM_requirements-100_MB-green.svg)

**A modern, ephemeral chat application for temporary file and message sharing**

Share files, images, voice messages, and locations instantly in temporary rooms that auto-delete after one hour. Perfect for quick collaborations, temporary file transfers, and privacy-focused communications.

New in 2.1: **end-to-end encryption**, **voice calls** and a **babyphone** (baby monitor) - audio goes directly from phone to phone, so the server stays as light as before.

## Features

### Core Messaging
- **Text Messages** - Send messages with automatic link detection and highlighting
- **File Sharing** - Upload any number of files (any type, up to 100MB each) with progress and cancel
- **Share Out** - Share one, several or all files/messages to other apps (Web Share API), or download them as a ZIP
- **Share In** - Installed app appears in the system share sheet; text, links and multiple files go to a room of your choice
- **Image Sharing** - Take photos or upload from gallery with click-to-expand previews
- **Voice Messages** - Record and send voice messages with custom audio player
- **Location Sharing** - Share your GPS position with interactive OpenStreetMap integration

### Calls & Babyphone
- **Voice calls** - Tap the phone button: everyone who has the room open rings and can join (up to 7 devices, full mesh)
  - Starts on the earpiece like a phone call; one button switches between earpiece, speaker and a connected headset
  - Tuned for low delay (10 ms audio frames, no silence suppression); the call bar shows the measured network round trip and buffer and whether the audio is direct or relayed
- **Babyphone** - One phone is the *baby station*, any number of phones are *parent units*
  - Sound detection with an adaptive noise floor: a fan or white-noise machine does not trigger alerts, crying does
  - *Alerts only* (silent until there is sound - nothing is cut off, the audio is sent with a short delay) or *Live*
  - Level meter, sensitivity that can be changed from the parent unit, hold-to-talk back to the baby
  - Alerts as notifications even when the parent phone is locked (encrypted Web Push)
  - "Connection lost", "microphone problem" and "battery low" alarms; sessions resume after a reload or app update
  - Night screen: a black display that keeps the phone awake
  - The parent unit keeps running with the screen off (it registers as a media player: Android shows a playback notification); "Test alarm" checks that the phone is loud enough
  - The baby station always uses the phone's own microphone and loudspeaker, tells the parents when another app takes the microphone, and no alarm hides another
- **Peer-to-peer** - Audio never passes through the FileRoom server (WebRTC, Opus with DTX: silence costs almost no data)

### End-to-end encryption
- **Encrypted by default** - Every new random room gets a key. It travels in the invite link / QR code (`#k=...`), which browsers never send to the server
- **Or a password** - Tap the lock, set a room password, and tell the others. Works for rooms with names you type
- **Everything** - Texts, locations, files (including name and type), call setup and babyphone alerts are encrypted on the device (AES-256-GCM, WebCrypto); the server stores and relays ciphertext
- **Verified calls** - The room key also authenticates the call, so nobody (not even the server) can sit in the middle. Without a key both phones show a 6-digit code to compare

### Known devices
- **Persistent name** - Set once ("Name & known devices"), used in every room until you change or remove it
- **Private name** - Optionally only known devices see it (sent to them encrypted); everyone else, and the server, see a random name per room. Without a name you are anonymous everywhere
- **Known devices** - Phones that shared an encrypted room remember each other (a key pair per device, created in the browser; the private key cannot be read out, not even by the page)
- **Recognised in any room** - Also in rooms without a key and under any name, without telling the server who is who: the recognition messages are different every time
- **Automatic encryption** - A known device that arrives without the room key gets it. A room where everyone present is a known device creates a key by itself. With strangers present the app offers it instead (they would be locked out)

### Favourites, groups and invitations
- **Invite people** - Tick known devices and everybody ticked gets a notification "… invites you to a room"; one tap joins, with the room key already in place
- **From anywhere** - Works while the other phone is in a different room or has FileRoom closed (encrypted Web Push, sealed for that one device; the server and the push service see neither room nor key)
- **Favourites and groups** - Star the people you invite often, save a ticked set as a group ("Family") and tick it with one tap. Both are lists on your device only
- **Share to people** - In the share sheet of another app choose FileRoom, tick people or a group: the content goes into a new encrypted room and they are invited to it
- **Several rooms** - Invitations wait in a banner and in the "Invite people" sheet; joining switches rooms, the previous one stays in the recent rooms
- A phone can be invited once it has allowed notifications (and FileRoom is served over HTTPS)

### Linked devices
- **One identity on all your devices** - "Name & known devices" → "Link another device" shows a QR code; scan it with your other phone, tablet or computer and confirm on both. It receives your identity, known devices, favourites, groups and name
- **Same person everywhere** - Everybody who knows one of your devices recognises all of them: automatic encryption and invitations work from any of them, and an invitation for you reaches all your devices
- **Lists stay in line** - Whenever two of your devices are in a room together they merge known devices, favourites and groups
- **Safe transfer** - The code holds a one-time secret (in the link's fragment, never sent to the server), is valid for 5 minutes and for one device; the transfer is encrypted with it
- **Unlink** - "Forget known devices & reset identity" on a device makes it a separate device again

### User Experience
- **Real-time Updates** - WebSocket-powered instant message delivery
- **QR Code Sharing** - Quick room access via QR code
- **Dark Mode** - Full dark theme support
- **Mobile Optimized** - Perfect responsive design for all devices
- **Circular Progress Timers** - Subtle countdown indicators for message expiry
- **Auto-deletion** - Everything disappears after 1 hour for privacy

### Privacy & Security
- **Ephemeral** - All messages and files auto-delete after 1 hour
- **No Registration** - No accounts, emails, or personal data required
- **Temporary Storage** - Files are stored on disk, always encrypted (by the browser in rooms with a key, otherwise by the server with keys that only exist in memory), and wiped on every restart
- **Auto-cleanup** - Inactive users automatically removed after 60 seconds

### Progressive Web App
- **Installable** - "Install app" button (sidebar → *App & Updates*) or platform-specific instructions (iOS, Samsung, Firefox, …)
- **App shell offline** - All code, styles, icons and libraries are self-hosted and cached; the app opens offline and reconnects automatically
- **Staged, verified updates** - A new release is downloaded completely and every file is checked against its SHA-256 checksum. The running version stays active until you tap **Restart** in the update banner (or **Later**). Updates are checked at start, when the app returns to the foreground, when the network comes back and every 30 minutes.
- **Reopens your last room** when launched from the home screen

### Room names
Any room name with **1–64 characters** (configurable) is a valid room: letters of any alphabet, digits, `-` and `_`.
Names are case-insensitive (`team` = `TEAM`) and spaces become `-` (`my team` → `MY-TEAM`). Random rooms still get a 6-character code.

## Screenshots

### Chat Interface
Clean, modern interface with support for multiple message types and real-time updates.

### Dark Mode
Full dark theme support with carefully crafted color schemes for optimal readability.

## Quick Start

### Using Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/chuckmoritzgg/fileroom.git
cd fileroom

# Run setup script
chmod +x setup.sh
./setup.sh

# Access at http://localhost:8181
```

### Manual Installation

```bash
# Install dependencies
pip install -r requirements.txt

# Run the application
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Tech Stack

- **Backend**: FastAPI (Python 3.11)
- **Frontend**: Bootstrap 5 with custom CSS
- **Real-time**: WebSocket
- **Maps**: Leaflet.js with OpenStreetMap
- **Storage**: disk volume, encrypted at rest (ChaCha20, per-file keys in memory), streamed in and out; ephemeral
- **Deployment**: Docker

## Usage

### Creating a Room
1. Visit the application URL
2. You will be automatically redirected to a new unique room
3. Share the room code or QR code with others

### Sending Messages
- **Text**: Type and press Enter (Shift+Enter for a new line) or click send
- **Files**: Plus button → "Files" (multiple), drag & drop, or paste
- **Photos/Videos**: Plus button → "Photos & Videos" (gallery, multiple) or "Camera"
- **Voice**: Hold the microphone button to record, release to send
- **Location**: Click the plus button and select "Location"

### Sharing files out of FileRoom
- Every message has a **share** button (on browsers with the Web Share API, e.g. Android/iOS) and files a **download** button
- Tap the **select** button in the header to pick several messages, then **Share**, **Save** (ZIP for multiple files) or **Delete**
- Sidebar: **Share All Files** and **Download All (ZIP)**
- File types a browser refuses to share (e.g. ZIP on Android Chrome) are downloaded instead

### Sharing into FileRoom
Install the app, then use the system share sheet in any app (gallery, files, browser …) and choose FileRoom.
You can pick a recent room, type any room name or create a new room.

### Calls
Tap the green phone button → **Start voice call**. The other devices in the room ring; a badge on the phone button shows a running call you can join.

### Babyphone
1. Open the same room on both phones (scan the QR code - it carries the room key).
2. Phone that stays with the baby: phone button → **Baby station**. Put it on the charger, 1-2 m from the bed. Tap the moon for the dark screen.
3. Your phone: phone button → **Parent unit**. Allow notifications and install the app so alerts also arrive while the phone is locked.
4. Choose **Alerts only** or **Live**, adjust the sensitivity, hold **Hold to talk** to speak to the baby.

Before the first night: press **Test alarm** on the parent unit (alarms use the *media* volume), lock the parent phone for a few minutes and make a noise at the baby station.

Android notes: keep FileRoom open on the baby station (the dark screen keeps the phone awake) and exclude Chrome / the installed app from battery optimisation if the system stops it overnight. The parent unit raises an alarm when the baby station stops reporting, so a silent failure does not go unnoticed. A babyphone app does not replace supervision.

### Message Features
- **Images**: Click any image to view full-screen with download option
- **Voice**: Play/pause with custom controls and waveform visualization
- **Links**: URLs are automatically detected, highlighted, and open in new tabs
- **Timer**: Hover over the circular timer to see remaining time before deletion

## Development

This project was entirely developed using Perplexity AI Lab and Research prompts. The entire codebase, from initial concept to final implementation, was vibe-coded through conversational AI development.

### Future Roadmap

Potential features being considered for future releases:

- **Video** for calls and the babyphone (camera, night vision)
- **Screen sharing** for collaborative sessions
- **Video messages** with preview thumbnails
- **Room expiry settings** (30min, 2h, 4h options)
- **Read receipts** to see who has seen messages
- **Typing indicators** for real-time presence
- **Message reactions** with emoji support
- **Desktop notifications** for new messages

## Important Notice

**Use with Care**: This application is designed for temporary, ephemeral communication. While messages and files auto-delete after 1 hour:

- Do not share sensitive personal information
- Do not rely on this for permanent storage
- Without a room key, anyone with the room code can join and see all messages, and files are not encrypted on the server
- With a room key the content is end-to-end encrypted, but the server still sees who is in which room, when, and how much data is sent. Anyone who gets the invite link gets the key
- The key is kept in the browser's storage of each device (so the installed app can reopen the room); "Remove key from this device" deletes it
- Content shared *into* FileRoom from another app stays on the phone until you pick a room and is then encrypted like everything else in that room
- In rooms without a key the server can read the content while it handles it; on disk it is encrypted with keys that only exist in memory, so the disk alone reveals nothing
- A name you show publicly is visible to the server in every room you use it in; choose "only known devices" or no name to avoid that
- A known device that enters a room you hold the key for receives that key automatically. "Forget known devices & reset identity" ends this; clearing the browser's site data does the same
- To be invited, a device gives its known devices a push address and the signing key for it. Any known device can therefore send it notifications; only invitations sealed by a known device are accepted by the app. "Forget known devices & reset identity" does not revoke push addresses already handed out
- A linked device holds a full copy of your identity. If one is lost, the others cannot revoke it: reset the identity on the devices you still have and meet your known devices again. The identity key is stored so that it can be copied to your own devices, which also means a script running on this origin could read it
- There is no authentication or access control beyond the room name and key

This is a convenience tool for temporary sharing, not a hardened secure messenger.

## Configuration

### Environment Variables

```bash
UPLOAD_DIR=uploads             # where files are stored (a disk volume in Docker)
MAX_STORAGE_SIZE=2147483648    # all rooms together on disk (2 GB)
MAX_FILE_SIZE=104857600        # per file, bytes (100MB)
MAX_SHARE_SIZE=524288000       # total of one incoming share from another app, bytes
MESSAGE_EXPIRY_HOURS=1
USER_TIMEOUT_SECONDS=60
SHARE_SESSION_MINUTES=15       # time to pick a room for incoming shares
MAX_ROOM_CODE_LENGTH=64

# Calls & babyphone (all optional)
STUN_URLS=stun:your.domain:3478                 # comma separated
TURN_URLS=turn:your.domain:3478,turn:your.domain:3478?transport=tcp
TURN_SECRET=<long random string>                # shared with coturn (use-auth-secret)
TURN_TTL_SECONDS=86400                          # lifetime of the TURN credentials FileRoom hands out
PUSH_RELAY=1                                    # 0 = never forward babyphone alerts to push services
```

### Calls & babyphone: what the server does

| | |
|---|---|
| Audio | Never touches FileRoom. It flows phone to phone (WebRTC, DTLS-SRTP). |
| Signaling | Small opaque strings relayed over the room's existing WebSocket. No call state is stored. Rate and size limited. |
| Push alerts | The baby station encrypts and signs each alert for the parent phone (RFC 8291/8292). The server forwards the bytes to the push service (Google FCM for Chrome on Android) and holds no keys or subscriptions. Only known push services are contacted. |
| Extra RAM/CPU | None worth measuring for FileRoom itself. |

**Same Wi-Fi** (the usual babyphone case): nothing to configure.

**Different networks** (parent on mobile data, carrier-grade NAT): the phones need a STUN server to find each other and, when that is not enough, a TURN server that relays the (still encrypted) audio. `docker-compose.turn.yml` adds a coturn container for both - about 10-20 MB RAM, capped at 96 MB:

```bash
cat >> .env <<EOF
TURN_SECRET=$(openssl rand -hex 32)
STUN_URLS=stun:your.domain:3478
TURN_URLS=turn:your.domain:3478,turn:your.domain:3478?transport=tcp
EOF
docker compose -f docker-compose.yml -f docker-compose.turn.yml up -d
```

Open 3478/udp, 3478/tcp and 49160-49200/udp in the firewall. FileRoom hands out TURN credentials that expire, so the relay cannot be used by strangers, and coturn limits each connection to voice bitrates. A relayed babyphone stream is about 3 kB/s while there is sound and close to nothing during silence.

The app version lives in the `VERSION` file. The service worker, `version.json` and the build hash are generated
by the server on start from the current files, so every deployment with changed files is offered to installed
apps as an update automatically.

**HTTPS is required** for installation, offline mode, sharing, updates, encryption, calls and the babyphone (except on `localhost`).
Behind a reverse proxy make sure `/sw.js`, `/version.json` and the manifest are not cached, and that the
upload limit for `/share` covers several files at once (see `nginx-example.conf`).

### Tests

```bash
pip install -r requirements.txt pytest httpx
pytest -q                                   # server (API, signaling relay, ICE, push relay)
node tests/js/crypto.test.mjs               # encryption
node tests/js/qr.test.mjs                   # QR code generator

# Browser tests: encrypted room, call between three devices, babyphone (needs playwright + ws and Chrome)
NODE_PATH=$(npm root -g) node tests/e2e/voice.e2e.mjs
NODE_PATH=$(npm root -g) node tests/e2e/contacts.e2e.mjs   # known devices, automatic encryption, persistent name
NODE_PATH=$(npm root -g) node tests/e2e/favorites.e2e.mjs  # favourites, groups, invitations, share to people
NODE_PATH=$(npm root -g) node tests/e2e/linked.e2e.mjs     # linking devices, list sync, invitations to all devices
NODE_PATH=$(npm root -g) node tests/e2e/harden.e2e.mjs     # earpiece/speaker switching, call timing, babyphone failure cases
NODE_PATH=$(npm root -g) node tests/e2e/share.e2e.mjs      # sharing from other apps stays on the device
```

### Docker Deployment

**Production (behind a dockerised nginx, with calls working across networks):** everything is in `docker-compose-prod.yml`, all settings in `.env`:

```bash
cp .env.example .env        # set DOMAIN, TURN_HOST and TURN_SECRET (openssl rand -hex 32)
docker compose -f docker-compose-prod.yml --env-file .env up -d --build --remove-orphans
```

It starts FileRoom on the external network `fileroom_network` (nginx proxies to `http://fileroom:8000`, see `nginx-example.conf`) and a coturn container on the host network. Open `3478/udp`, `3478/tcp` and `49160-49200/udp` in the firewall; these do not go through nginx.

**Storage.** Nothing is kept in RAM except room and message metadata:

| What | Where |
|---|---|
| Uploaded files | Disk volume `fileroom_uploads`, streamed in and out in 1 MB chunks |
| Rooms with a key | The browser encrypts; the server stores ciphertext it cannot read |
| Rooms without a key | The server encrypts while writing; the per-file key exists only in memory. Delete, expiry or restart destroys it |
| ZIP downloads | Streamed while they are built - no temp file, no buffer |
| Shares from other apps | Stay on the phone (service worker) until a room is chosen, then go through the normal, encrypted upload |
| Limit | `MAX_STORAGE_SIZE` for all rooms together; the volume is emptied on every start |

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

Calls and the babyphone are built for and tested with Chrome on Android (wake lock, notifications and Web Push, battery status, audio worklets). They work in other current browsers with WebRTC, with fewer comforts.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run in development mode
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Built with FastAPI and modern web technologies
- Entirely vibe-coded using Perplexity AI Lab and Research prompts
- Map tiles provided by OpenStreetMap contributors
- Icons from Bootstrap Icons

## Inspired by

- [pairdrop](https://github.com/schlagmichdoch/pairdrop)
- [aqross](https://aqross.app)
- instant messengers

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

---

**Remember**: FileRoom is designed for temporary sharing. Always use appropriate tools for sensitive or permanent data.
