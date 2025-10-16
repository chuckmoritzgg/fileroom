# FileRoom

![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg)
![Docker](https://img.shields.io/badge/Dockerized-yes-green.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)

**A modern, ephemeral chat application for temporary file and message sharing**

Share files, images, voice messages, and locations instantly in temporary rooms that auto-delete after one hour. Perfect for quick collaborations, temporary file transfers, and privacy-focused communications.

## Features

### Core Messaging
- **Text Messages** - Send messages with automatic link detection and highlighting
- **File Sharing** - Upload any file type up to 100MB
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

# Access at http://localhost:8000
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
- **Text**: Type in the input field and press Enter or click send
- **Files**: Click the plus button and select "File"
- **Photos**: Click the plus button and select "Photo" (camera or gallery)
- **Voice**: Hold the microphone button to record, release to send
- **Location**: Click the plus button and select "Location"

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
- **Drag and drop** file upload support
- **Multiple room management** for power users
- **Custom room names** instead of random codes
- **Room expiry settings** (30min, 2h, 4h options)
- **Read receipts** to see who has seen messages
- **Typing indicators** for real-time presence
- **Message reactions** with emoji support
- **Desktop notifications** for new messages
- **PWA support** for offline functionality

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
# Server Configuration
HOST=0.0.0.0
PORT=8000

# Storage Configuration
UPLOAD_DIR=uploads
MAX_FILE_SIZE=104857600  # 100MB in bytes

# Message Configuration
MESSAGE_EXPIRY_HOURS=1
USER_TIMEOUT_SECONDS=60
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
- instant messagers

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

---

**Remember**: FileRoom is designed for temporary sharing. Always use appropriate tools for sensitive or permanent data.
