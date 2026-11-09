# FileRoom

![Version](https://img.shields.io/badge/Version-2.0.0-blue.svg)
![Docker](https://img.shields.io/badge/Dockerized-yes-green.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)
![Lightweight](https://img.shields.io/badge/RAM_requirements-100_MB_+_in_RAM_storage-green.svg)

**A modern, ephemeral chat application for temporary file and message sharing**

Share files, images, voice messages, and locations instantly in temporary rooms that auto-delete after one hour. Perfect for quick collaborations, temporary file transfers, and privacy-focused communications.

## Features

### Core Messaging
- **Text Messages** - Send messages with automatic link detection and highlighting
- **File Sharing** - Upload any number of files (any type, up to 100MB each) with progress and cancel
- **Share Out** - Share one, several or all files/messages to other apps (Web Share API), or download them as a ZIP
- **Share In** - Installed app appears in the system share sheet; text, links and multiple files go to a room of your choice
- **Image Sharing** - Take photos or upload from gallery with click-to-expand previews
- **Voice Messages** - Record and send voice messages with custom audio player
- **Location Sharing** - Share your GPS position with interactive OpenStreetMap integration

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
- **Temporary Storage** - Files stored in tmpfs (RAM-only)
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
- **Storage**: tmpfs (RAM-only, ephemeral)
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

### Message Features
- **Images**: Click any image to view full-screen with download option
- **Voice**: Play/pause with custom controls and waveform visualization
- **Links**: URLs are automatically detected, highlighted, and open in new tabs
- **Timer**: Hover over the circular timer to see remaining time before deletion

## Development

This project was entirely developed using Perplexity AI Lab and Research prompts. The entire codebase, from initial concept to final implementation, was vibe-coded through conversational AI development.

### Future Roadmap

Potential features being considered for future releases:

- **End-to-end encryption** for enhanced privacy
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
- Anyone with the room code can join and see all messages
- There is no authentication or access control
- Files are not encrypted at rest
- Consider using end-to-end encrypted alternatives for sensitive data

This is a convenience tool for temporary sharing, not a secure messaging platform.

## Configuration

### Environment Variables

```bash
UPLOAD_DIR=uploads             # where files are stored (tmpfs in Docker)
MAX_FILE_SIZE=104857600        # per file, bytes (100MB)
MAX_SHARE_SIZE=524288000       # total of one incoming share from another app, bytes
MESSAGE_EXPIRY_HOURS=1
USER_TIMEOUT_SECONDS=60
SHARE_SESSION_MINUTES=15       # time to pick a room for incoming shares
MAX_ROOM_CODE_LENGTH=64
```

The app version lives in the `VERSION` file. The service worker, `version.json` and the build hash are generated
by the server on start from the current files, so every deployment with changed files is offered to installed
apps as an update automatically.

**HTTPS is required** for installation, offline mode, sharing and updates (except on `localhost`).
Behind a reverse proxy make sure `/sw.js`, `/version.json` and the manifest are not cached, and that the
upload limit for `/share` covers several files at once (see `nginx-example.conf`).

### Tests

```bash
pip install -r requirements.txt pytest httpx
pytest -q
```

### Docker Deployment

The application uses tmpfs for ephemeral storage. To adjust the tmpfs size:

```yaml
volumes:
  - type: tmpfs
    target: /app/uploads
    tmpfs:
      size: 2G  # Adjust size as needed
      mode: 0777
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

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
