# FileRoom Perfect 🚀

[![License: MIT](https://img.shields.io/badge 
[![Version](https://img.shields.io/badge 
[![Perplexity Lab](https://img.shields.io/badge/Built%20with-Perplexity%
**The ultimate real-time chat experience with images, voice, links, location & more!**

***

## Features ✨

- 📸 **Image Previews**  
  - In-chat thumbnails, click to expand in full-screen modal  
  - Download button in modal, lazy loading, smooth hover effects  

- 🎵 **Enhanced Voice Messages**  
  - Custom play/pause controls with animated waveform bars  
  - Live time progress, auto-stop other messages, optional download  

- 🔗 **Smart Link Detection**  
  - Automatic URL highlighting & clickable links  
  - Link preview cards with domain info, opens safely in new tab  

- ⭕ **Circular Progress Timers**  
  - Subtle SVG rings next to timestamps, hover to reveal remaining time  
  - Color-coded by urgency: normal ▶️ warning ⚠️ danger ❗  

- 📱 **Mobile-First Design**  
  - Responsive layout with safe-area support (100dvh, `env(safe-area-inset-*)`)  
  - Fixed input above bottom bar, no hidden fields  
  - Touch-optimized controls

- 📍 **Location Sharing**  
  - Geolocation API & Leaflet.js maps (OpenStreetMap)  
  - Interactive map previews & direct “Open in Map” links  

- 📷 **Camera Photo Capture**  
  - Capture from back camera or select from gallery  
  - Inline preview & upload  

- 🌙 **Dark Mode**  
  - Toggle in sidebar, persisted preference via `localStorage`  
  - Beautiful dark theme with CSS variables  

- ⚡ **Real-Time Updates**  
  - FastAPI + WebSocket backend for true push notifications  
  - Instant message delivery & live user presence  

- 🔄 **Auto-Deletion**  
  - All messages, files & media expire after 1 hour  
  - Clean slate for privacy & performance  

***

## Installation 📦

```bash
git clone https://github.com/chuckmoritzgg/fileroom.git
cd fileroom-perfect
chmod +x setup.sh
./setup.sh
```

Open your browser at [http://localhost:8000](http://localhost:8000)

***

## Usage 📝

- **Text**: Type and press Enter or click send  
- **Files**: Click ➕ → File  
- **Photos**: Click ➕ → Photo (camera or gallery)  
- **Voice**: Hold 🎤 button to record, release to send  
- **Location**: Click ➕ → Location  
- **Links**: Paste any `http://` or `https://` URL into chat  

***

## Built with ❤️ by Perplexity Lab & Research Prompts

This entire project was **vibe coded** using Perplexity AI’s Lab environment and carefully crafted research prompts to achieve a perfect, polished user experience.

***

## Future Plans 🚧

- 🔒 **End-to-end encryption** for private rooms  
- 🖼️ **GIF & video support**  
- 🤖 **AI-powered moderation** & auto-summaries  
- 📊 **Analytics dashboard** for usage insights  
- 🌐 **Multi-language support**  

***

## ⚠️ Use with Great Care

This tool is powerful and flexible. Please use responsibly and respect privacy. Data is stored in memory or tmpfs and auto-deleted, but always avoid sharing sensitive personal information.

***

## License

Released under the [MIT License](LICENSE). Enjoy!