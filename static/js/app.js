/**
 * FileRoom Perfect - Enhanced with image modals, voice controls, link detection, circular timers
 */

'use strict';

// State
let currentUser = null;
let roomCode = null;
let websocket = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingInterval = null;
let audioPlayers = {}; // Track audio elements for voice messages

// Get room code
const path = window.location.pathname;
roomCode = path.split('/room/')[1];

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    if (!roomCode) return;

    console.log('Initializing Perfect FileRoom for room:', roomCode);

    loadTheme();
    initUser();
    setupUI();
    scrollToBottom();
    initializeMaps();
    setupDragAndDrop();


    // Heartbeat
    setInterval(() => {
        if (currentUser) {
            fetch(`/api/heartbeat/${currentUser.id}`, { method: 'POST' })
                .catch(err => console.error('Heartbeat failed:', err));
        }
    }, 30000);
});

// User initialization
async function initUser() {
    try {
        const storageKey = 'fileroom_user_' + roomCode;
        const stored = localStorage.getItem(storageKey);

        let existingUserId = null;
        let existingUserName = null;

        if (stored) {
            try {
                const userData = JSON.parse(stored);
                existingUserId = userData.id;
                existingUserName = userData.name;
            } catch (e) {
                console.error('Failed to parse stored user:', e);
            }
        }

        let url = `/api/join/${roomCode}`;
        const params = [];
        if (existingUserId) {
            params.push(`user_id=${encodeURIComponent(existingUserId)}`);
        }
        if (existingUserName) {
            params.push(`user_name=${encodeURIComponent(existingUserName)}`);
        }
        if (params.length > 0) {
            url += '?' + params.join('&');
        }

        const response = await fetch(url, { method: 'GET' });

        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                currentUser = {
                    id: data.user_id,
                    name: data.user_name
                };

                localStorage.setItem(storageKey, JSON.stringify(currentUser));

                console.log(data.existing ? 'Rejoined as:' : 'Joined as:', currentUser.name);

                connectWebSocket();
            }
        }
    } catch (error) {
        console.error('Init user failed:', error);

        currentUser = {
            id: 'anon-' + Date.now(),
            name: 'Anonymous'
        };
    }
}

function connectWebSocket() {
    if (!currentUser || websocket) return;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/${roomCode}/${currentUser.id}`;

    try {
        websocket = new WebSocket(wsUrl);

        websocket.onopen = function() {
            console.log('WebSocket connected');

            setInterval(() => {
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send('ping');
                }
            }, 30000);
        };

        websocket.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                handleWebSocketMessage(data);
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        };

        websocket.onerror = function(error) {
            console.error('WebSocket error:', error);
        };

        websocket.onclose = function() {
            console.log('WebSocket disconnected');
            websocket = null;

            setTimeout(() => {
                if (currentUser) {
                    connectWebSocket();
                }
            }, 5000);
        };

    } catch (error) {
        console.error('WebSocket connection failed:', error);
    }
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'users_list':
            updateUsersList(data.users);
            break;

        case 'new_message':
            addMessageToUI(data.message);
            break;

        case 'message_deleted':
            removeMessageFromUI(data.message_id);
            break;

        case 'user_joined':
            showToast(`${data.user_name} joined`, 'info');
            refreshData();
            break;

        case 'user_left':
            showToast(`${data.user_name} left`, 'info');
            refreshData();
            break;

        case 'user_renamed':
            if (data.user_id !== currentUser.id) {
                showToast(`${data.old_name} is now ${data.new_name}`, 'info');
            }
            refreshData();
            break;

        case 'room_cleared':
            const container = document.getElementById('messagesContainer');
            if (container) {
                container.innerHTML = '';
            }
            Object.keys(audioPlayers).forEach(id => {
                audioPlayers[id].pause();
            });
            audioPlayers = {};
            showToast('Room cleared by another user', 'info');
            break;
    }
}

// Drag and Drop setup
function setupDragAndDrop() {
    const mainChat = document.querySelector('.main-chat');
    if (!mainChat) return;

    let dragCounter = 0;

    // Prevent default drag behaviors on the whole document
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // Highlight drop area when item is dragged over it
    document.body.addEventListener('dragenter', function(e) {
        dragCounter++;
        if (e.dataTransfer.types.includes('Files')) {
            mainChat.classList.add('drag-over');
        }
    }, false);

    document.body.addEventListener('dragleave', function(e) {
        dragCounter--;
        if (dragCounter === 0) {
            mainChat.classList.remove('drag-over');
        }
    }, false);

    document.body.addEventListener('dragover', function(e) {
        if (e.dataTransfer.types.includes('Files')) {
            e.dataTransfer.dropEffect = 'copy';
        }
    }, false);

    // Handle dropped files
    document.body.addEventListener('drop', function(e) {
        dragCounter = 0;
        mainChat.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            handleDroppedFiles(files);
        }
    }, false);
}

function handleDroppedFiles(files) {
    if (!files || files.length === 0) return;
    
    console.log(`Dropped ${files.length} files`);
    
    // Separate images from other files
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    const otherFiles = files.filter(f => !f.type.startsWith('image/'));
    
    // Upload images as 'image' type
    if (imageFiles.length > 0) {
        console.log(`Uploading ${imageFiles.length} images`);
        uploadFiles(imageFiles, 'image');
    }
    
    // Upload other files as 'file' type
    if (otherFiles.length > 0) {
        console.log(`Uploading ${otherFiles.length} files`);
        uploadFiles(otherFiles, 'file');
    }
}


// UI Setup
function setupUI() {
    // File inputs
    const fileInput = document.getElementById('fileInput');
    const photoInput = document.getElementById('photoInput');

    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            console.log('File input changed:', this.files.length);
            if (this.files && this.files.length > 0) {
                uploadFiles(Array.from(this.files), 'file');
            }
        });
    }

    if (photoInput) {
        photoInput.addEventListener('change', function(e) {
            console.log('Photo input changed:', this.files.length);
            if (this.files && this.files.length > 0) {
                uploadFiles(Array.from(this.files), 'image');
            }
        });
    }

    // Initialize existing circular timers
    document.querySelectorAll('.circular-timer').forEach(el => {
        const seconds = parseInt(el.dataset.seconds);
        if (seconds > 0) {
            initCircularTimer(el, seconds);
        }
    });

    // Hide attach menu when clicking outside
    document.addEventListener('click', function(e) {
        const attachMenu = document.getElementById('attachMenu');
        const attachBtn = document.querySelector('.btn-attach');
        if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachBtn && !attachBtn.contains(e.target)) {
            attachMenu.classList.remove('show');
        }
    });
}

// Send text message
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();

    if (!text || !currentUser) return;

    try {
        const url = `/api/message/${roomCode}?text=${encodeURIComponent(text)}&user_id=${encodeURIComponent(currentUser.id)}`;

        const response = await fetch(url, {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error('Send failed');
        }

        input.value = '';

    } catch (error) {
        console.error('Send message error:', error);
        showToast('Failed to send message', 'danger');
    }
}

// Upload files
async function uploadFiles(files, type) {
    if (!files || files.length === 0 || !currentUser) {
        console.error('No files or user');
        return;
    }

    console.log(`Uploading ${files.length} files as type: ${type}`);

    try {
        const validFiles = files.filter(f => {
            if (f.size > 100 * 1024 * 1024) {
                showToast(`${f.name} too large (max 100MB)`, 'danger');
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) return;

        showToast(`Uploading ${validFiles.length} file(s)...`, 'info');

        const formData = new FormData();
        validFiles.forEach(f => {
            console.log('Adding file to FormData:', f.name);
            formData.append('files', f);
        });

        const url = `/api/upload/${roomCode}?user_id=${encodeURIComponent(currentUser.id)}&message_type=${type}`;

        console.log('Uploading to:', url);

        const response = await fetch(url, {
            method: 'POST',
            body: formData
        });

        console.log('Upload response status:', response.status);

        if (!response.ok) {
            const text = await response.text();
            console.error('Upload failed:', text);
            throw new Error('Upload failed');
        }

        const result = await response.json();
        console.log('Upload result:', result);

        showToast('Upload complete!', 'success');

        // Clear inputs
        document.getElementById('fileInput').value = '';
        document.getElementById('photoInput').value = '';

    } catch (error) {
        console.error('Upload error:', error);
        showToast('Failed to upload', 'danger');
    }
}

// Voice recording
async function startRecording(event) {
    event.preventDefault();

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const audioFile = new File([audioBlob], 'voice_message.webm', { type: 'audio/webm' });

            await uploadFiles([audioFile], 'voice');

            stream.getTracks().forEach(track => track.stop());

            hideRecordingIndicator();
        };

        mediaRecorder.start();
        recordingStartTime = Date.now();

        showRecordingIndicator();

        recordingInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            document.getElementById('recordingTime').textContent = 
                `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);

        document.getElementById('voiceBtn').classList.add('recording');

    } catch (error) {
        console.error('Recording error:', error);
        showToast('Microphone access denied', 'danger');
    }
}

function stopRecording(event) {
    event.preventDefault();

    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();

        if (recordingInterval) {
            clearInterval(recordingInterval);
            recordingInterval = null;
        }

        document.getElementById('voiceBtn').classList.remove('recording');
    }
}

function showRecordingIndicator() {
    const indicator = document.getElementById('recordingIndicator');
    if (indicator) {
        indicator.classList.add('show');
    }
}

function hideRecordingIndicator() {
    const indicator = document.getElementById('recordingIndicator');
    if (indicator) {
        indicator.classList.remove('show');
    }
}

// Location sharing
async function sendLocation() {
    if (!currentUser) {
        showToast('User not initialized', 'warning');
        return;
    }

    if (!navigator.geolocation) {
        showToast('Location not supported', 'danger');
        return;
    }

    showToast('Getting location...', 'info');

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            try {
                const url = `/api/message/${roomCode}?user_id=${encodeURIComponent(currentUser.id)}&message_type=location&latitude=${lat}&longitude=${lng}`;

                const response = await fetch(url, {
                    method: 'POST'
                });

                if (!response.ok) {
                    throw new Error('Failed to send location');
                }

                showToast('Location shared!', 'success');

            } catch (error) {
                console.error('Send location error:', error);
                showToast('Failed to share location', 'danger');
            }
        },
        (error) => {
            console.error('Geolocation error:', error);
            showToast('Could not get location', 'danger');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );

    // Hide attach menu
    const menu = document.getElementById('attachMenu');
    if (menu) {
        menu.classList.remove('show');
    }
}

// Delete message
async function deleteMessage(messageId) {
    // if (!confirm('Delete this message?')) return;

    try {
        const response = await fetch(`/api/message/${messageId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error('Delete failed');
        }

    } catch (error) {
        console.error('Delete error:', error);
        showToast('Failed to delete', 'danger');
    }
}

// PERFECT MESSAGE RENDERING
function addMessageToUI(msg) {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${msg.type}`;
    msgDiv.id = `msg-${msg.id}`;

    let content = '';

    // Create circular timer HTML
    const timerHtml = `
        <div class="circular-timer" data-seconds="${msg.time_remaining}">
            <svg class="timer-circle">
                <circle class="timer-track"></circle>
                <circle class="timer-progress"></circle>
            </svg>
            <span class="timer-text">${formatTime(msg.time_remaining)}</span>
        </div>
    `;

    if (msg.type === 'text') {
        // Process text for links
        const processedText = processTextWithLinks(msg.text);
        const linkPreviews = msg.links && msg.links.length > 0 ? 
            `<div class="link-previews">
                ${msg.links.map(link => `
                    <div class="link-preview">
                        <i class="bi bi-link-45deg"></i>
                        <a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a>
                    </div>
                `).join('')}
            </div>` : '';

        content = `
            <div class="message-header">
                ${escapeHtml(msg.username)}
                <span class="message-time">
                    ${msg.time}
                    ${timerHtml}
                </span>
            </div>
            <div class="message-content">${processedText}</div>
            ${linkPreviews}
        `;
    } else if (msg.type === 'location') {
        const mapId = `map-${msg.id}`;
        content = `
            <div class="message-header">
                ${escapeHtml(msg.username)}
                <span class="message-time">
                    ${msg.time}
                    ${timerHtml}
                </span>
            </div>
            <div class="location-preview" id="${mapId}" data-lat="${msg.latitude}" data-lng="${msg.longitude}"></div>
            <div class="location-link">
                <a href="https://www.openstreetmap.org/?mlat=${msg.latitude}&mlon=${msg.longitude}#map=15/${msg.latitude}/${msg.longitude}" target="_blank">
                    <i class="bi bi-geo-alt-fill me-1"></i>Open in Map
                </a>
            </div>
        `;

        // Initialize map after adding to DOM
        setTimeout(() => {
            initializeMap(mapId, msg.latitude, msg.longitude);
        }, 100);
    } else if (msg.type === 'image') {
        content = `
            <div class="message-header">
                ${escapeHtml(msg.username)}
                <span class="message-time">
                    ${msg.time}
                    ${timerHtml}
                </span>
            </div>
            <div class="image-preview" onclick="openImageModal('/api/download/${msg.id}', '${escapeHtml(msg.filename)}')">
                <img src="/api/download/${msg.id}" alt="${escapeHtml(msg.filename)}" loading="lazy">
                <div class="image-overlay">
                    <i class="bi bi-arrows-fullscreen"></i>
                    <span>Click to view</span>
                </div>
            </div>
        `;
    } else if (msg.type === 'voice') {
        const voicePlayerId = `voice-${msg.id}`;
        content = `
            <div class="message-header">
                ${escapeHtml(msg.username)}
                <span class="message-time">
                    ${msg.time}
                    ${timerHtml}
                </span>
            </div>
            <div class="voice-player" id="${voicePlayerId}" data-src="/api/download/${msg.id}">
                <button class="voice-play-btn" onclick="toggleVoicePlayback('${voicePlayerId}')">
                    <i class="bi bi-play-fill"></i>
                </button>
                <div class="voice-progress">
                    <div class="voice-waveform">
                        <div class="wave-bar"></div>
                        <div class="wave-bar"></div>
                        <div class="wave-bar"></div>
                        <div class="wave-bar"></div>
                        <div class="wave-bar"></div>
                    </div>
                    <div class="voice-time">0:00</div>
                </div>
                <button class="voice-download-btn" onclick="downloadFile('/api/download/${msg.id}', '${escapeHtml(msg.filename)}')">
                    <i class="bi bi-download"></i>
                </button>
            </div>
        `;
    } else {
        content = `
            <div class="message-header">
                ${escapeHtml(msg.username)}
                <span class="message-time">
                    ${msg.time}
                    ${timerHtml}
                </span>
            </div>
            <div class="file-info">
                <i class="bi bi-file-earmark file-icon"></i>
                <div class="flex-grow-1">
                    <div class="fw-semibold" onclick="downloadFile('/api/download/${msg.id}', '${escapeHtml(msg.filename)}')" style="cursor: pointer;">
                        ${escapeHtml(msg.filename)}
                    </div>
                    <small>${msg.size_mb} MB</small>
                </div>
                <a href="/api/download/${msg.id}" class="btn-download">
                    <i class="bi bi-download"></i>
                </a>
            </div>
        `;
    }

    msgDiv.innerHTML = content + `
        <div class="message-footer">
            <button class="btn-delete" onclick="deleteMessage('${msg.id}')">
                <i class="bi bi-trash"></i>
            </button>
        </div>
    `;

    container.appendChild(msgDiv);

    // Initialize circular timer
    const timer = msgDiv.querySelector('.circular-timer');
    if (timer && msg.time_remaining > 0) {
        initCircularTimer(timer, msg.time_remaining);
    }

    scrollToBottom();
}

// CIRCULAR TIMER FUNCTIONALITY
function initCircularTimer(timerElement, totalSeconds) {
    const progressCircle = timerElement.querySelector('.timer-progress');
    const timerText = timerElement.querySelector('.timer-text');

    if (!progressCircle || !timerText) return;

    const circumference = 2 * Math.PI * 8; // r = 8
    progressCircle.style.strokeDasharray = circumference;

    let remainingSeconds = totalSeconds;

    const updateTimer = () => {
        const progress = remainingSeconds / totalSeconds;
        const offset = circumference * (1 - progress);

        progressCircle.style.strokeDashoffset = offset;

        // Update colors based on remaining time
        if (remainingSeconds < 300) { // < 5 minutes
            progressCircle.classList.add('danger');
        } else if (remainingSeconds < 900) { // < 15 minutes
            progressCircle.classList.add('warning');
        }

        timerText.textContent = formatTime(remainingSeconds);

        remainingSeconds--;

        if (remainingSeconds < 0) {
            progressCircle.style.strokeDashoffset = circumference;
            timerText.textContent = 'Expired';
            return;
        }

        setTimeout(updateTimer, 1000);
    };

    updateTimer();
}

// VOICE PLAYER FUNCTIONALITY
function toggleVoicePlayback(playerId) {
    const player = document.getElementById(playerId);
    if (!player) return;

    const playBtn = player.querySelector('.voice-play-btn i');
    const timeDisplay = player.querySelector('.voice-time');
    const src = player.dataset.src;

    if (!audioPlayers[playerId]) {
        audioPlayers[playerId] = new Audio(src);

        audioPlayers[playerId].addEventListener('loadedmetadata', () => {
            const duration = audioPlayers[playerId].duration;
            timeDisplay.textContent = formatAudioTime(duration);
        });

        audioPlayers[playerId].addEventListener('timeupdate', () => {
            const currentTime = audioPlayers[playerId].currentTime;
            timeDisplay.textContent = formatAudioTime(currentTime);
        });

        audioPlayers[playerId].addEventListener('ended', () => {
            playBtn.className = 'bi bi-play-fill';
            player.classList.remove('playing');
            const duration = audioPlayers[playerId].duration;
            timeDisplay.textContent = formatAudioTime(duration);
        });
    }

    const audio = audioPlayers[playerId];

    if (audio.paused) {
        // Stop all other audio players
        Object.keys(audioPlayers).forEach(id => {
            if (id !== playerId && !audioPlayers[id].paused) {
                audioPlayers[id].pause();
                const otherPlayer = document.getElementById(id);
                if (otherPlayer) {
                    otherPlayer.querySelector('.voice-play-btn i').className = 'bi bi-play-fill';
                    otherPlayer.classList.remove('playing');
                }
            }
        });

        audio.play();
        playBtn.className = 'bi bi-pause-fill';
        player.classList.add('playing');
    } else {
        audio.pause();
        playBtn.className = 'bi bi-play-fill';
        player.classList.remove('playing');
    }
}

// IMAGE MODAL FUNCTIONALITY
function openImageModal(src, filename) {
    const modal = document.getElementById('imageModal');
    const img = document.getElementById('imageModalImg');
    const title = document.getElementById('imageModalTitle');
    const downloadBtn = document.getElementById('imageModalDownload');

    if (modal && img && title && downloadBtn) {
        img.src = src;
        title.textContent = filename;
        downloadBtn.onclick = () => downloadFile(src, filename);
        modal.classList.add('show');
    }
}

function closeImageModal() {
    const modal = document.getElementById('imageModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// LINK PROCESSING
function processTextWithLinks(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escapeHtml(text).replace(urlRegex, '<a href="$1" target="_blank" rel="noopener" class="inline-link">$1</a>');
}

// Download file
function downloadFile(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function removeMessageFromUI(messageId) {
    const msg = document.getElementById(`msg-${messageId}`);
    if (msg) {
        // Stop any playing audio
        if (audioPlayers[`voice-${messageId}`]) {
            audioPlayers[`voice-${messageId}`].pause();
            delete audioPlayers[`voice-${messageId}`];
        }

        msg.style.opacity = '0';
        msg.style.transform = 'translateX(-20px)';
        setTimeout(() => msg.remove(), 300);
    }
}

function updateUsersList(users) {
    const container = document.getElementById('usersList');
    if (!container || !users) return;

    if (users.length === 0) {
        container.innerHTML = '<div class="text-muted small">No users</div>';
        return;
    }

    container.innerHTML = users.map(u => `
        <div class="user-item ${currentUser && u.id === currentUser.id ? 'current' : ''}">
            <div class="user-status"></div>
            ${escapeHtml(u.name)}${currentUser && u.id === currentUser.id ? ' (you)' : ''}
        </div>
    `).join('');
}

async function refreshData() {
    try {
        const response = await fetch(`/api/room/${roomCode}/data`);
        if (!response.ok) return;

        const data = await response.json();
        updateUsersList(data.users);

    } catch (error) {
        console.error('Refresh error:', error);
    }
}

// Maps
function initializeMaps() {
    document.querySelectorAll('.location-preview').forEach(el => {
        const lat = parseFloat(el.dataset.lat);
        const lng = parseFloat(el.dataset.lng);
        if (!isNaN(lat) && !isNaN(lng)) {
            initializeMap(el.id, lat, lng);
        }
    });
}

function initializeMap(mapId, lat, lng) {
    try {
        if (typeof L === 'undefined') {
            console.error('Leaflet not loaded');
            return;
        }

        const mapEl = document.getElementById(mapId);
        if (!mapEl || mapEl._leaflet_id) return;

        const map = L.map(mapId).setView([lat, lng], 15);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);

        L.marker([lat, lng]).addTo(map);

    } catch (error) {
        console.error('Map initialization error:', error);
    }
}

// Theme Management
function loadTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeButton(theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const newTheme = current === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeButton(newTheme);
}

function updateThemeButton(theme) {
    const icon = document.getElementById('themeIcon');
    const text = document.getElementById('themeText');
    if (icon && text) {
        if (theme === 'dark') {
            icon.className = 'bi bi-sun-fill me-1';
            text.textContent = 'Light Mode';
        } else {
            icon.className = 'bi bi-moon-fill me-1';
            text.textContent = 'Dark Mode';
        }
    }
}

// UI Controls
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('show');
    }
}

function toggleAttachMenu() {
    const menu = document.getElementById('attachMenu');
    if (menu) {
        menu.classList.toggle('show');
    }
}

function selectAttachment(type) {
    console.log('Select attachment:', type);

    const menu = document.getElementById('attachMenu');
    if (menu) {
        menu.classList.remove('show');
    }

    if (type === 'file') {
        document.getElementById('fileInput').click();
    } else if (type === 'photo') {
        document.getElementById('photoInput').click();
    }
}

function openQR() {
    const modal = document.getElementById('qrModal');
    if (modal) {
        modal.classList.add('show');
    }
}

function closeQR() {
    const modal = document.getElementById('qrModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

function copyShareUrl() {
    const input = document.getElementById('shareUrl');
    if (input) {
        input.select();
        document.execCommand('copy');
        showToast('URL copied!', 'success');
    }
}

function changeName() {
    if (!currentUser) {
        showToast('User not initialized', 'warning');
        return;
    }

    const newName = prompt('Enter your name:', currentUser.name || '');
    if (!newName || !newName.trim()) return;

    currentUser.name = newName.trim();

    const storageKey = 'fileroom_user_' + roomCode;
    localStorage.setItem(storageKey, JSON.stringify(currentUser));

    initUser().then(() => {
        showToast('Name updated', 'success');
    });
}

// Delete all messages and files in the room
async function deleteAllRoomData() {
    if (!currentUser) {
        showToast('User not initialized', 'warning');
        return;
    }
    
    const confirmMsg = 'Are you sure you want to delete ALL messages and files in this room? This cannot be undone!';
    if (!confirm(confirmMsg)) return;
    
    try {
        showToast('Deleting all data...', 'info');
        
        const response = await fetch(`/api/room/${roomCode}/all`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error('Delete all failed');
        }
        
        const result = await response.json();
        
        // Clear the messages container
        const container = document.getElementById('messagesContainer');
        if (container) {
            container.innerHTML = '';
        }
        
        // Stop all audio players
        Object.keys(audioPlayers).forEach(id => {
            audioPlayers[id].pause();
        });
        audioPlayers = {};
        
        showToast(`Deleted ${result.count} messages`, 'success');
        
    } catch (error) {
        console.error('Delete all error:', error);
        showToast('Failed to delete all data', 'danger');
    }
}


// Download all files from the room
async function downloadAllFiles() {
    const fileMessages = document.querySelectorAll('.message.file, .message.image, .message.voice');
    
    if (fileMessages.length === 0) {
        showToast('No files to download', 'info');
        return;
    }
    
    showToast(`Downloading ${fileMessages.length} file(s)...`, 'info');
    
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let downloadCount = 0;
    
    for (const msgEl of fileMessages) {
        try {
            const fileInfo = msgEl.querySelector('.file-info');
            const filename = fileInfo ? fileInfo.querySelector('.fw-semibold').textContent : 'file';
            const downloadLink = msgEl.querySelector('.btn-download, [onclick*="downloadFile"]');
            
            if (downloadLink) {
                let downloadUrl = null;
                const href = downloadLink.getAttribute('href');
                const onclick = downloadLink.getAttribute('onclick');
                
                if (href) {
                    downloadUrl = href;
                } else if (onclick && onclick.includes('downloadFile')) {
                    const match = onclick.match(/'([^']+)'/);
                    if (match) {
                        downloadUrl = match[1];
                    }
                }
                
                if (downloadUrl) {
                    downloadFile(downloadUrl, filename);
                    downloadCount++;
                    await delay(200);
                }
            }
        } catch (error) {
            console.error('Download error:', error);
        }
    }
    
    showToast(`Started downloading ${downloadCount} file(s)`, 'success');
}


// Utilities
function formatTime(seconds) {
    if (seconds <= 0) return 'Expired';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatAudioTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    const container = document.getElementById('messagesContainer');
    if (container) {
        setTimeout(() => {
            container.scrollTop = container.scrollHeight;
        }, 100);
    }
}

function showToast(message, type) {
    const container = document.querySelector('.toast-container');
    if (!container) return;

    const colors = {
        success: 'text-bg-success',
        danger: 'text-bg-danger',
        warning: 'text-bg-warning',
        info: 'text-bg-primary'
    };

    const id = 'toast-' + Date.now();
    const toast = document.createElement('div');
    toast.className = `toast ${colors[type] || colors.info}`;
    toast.id = id;
    toast.innerHTML = `
        <div class="toast-body">
            ${message}
            <button type="button" class="btn-close btn-close-white ms-2 float-end" 
                    onclick="document.getElementById('${id}').remove()"></button>
        </div>
    `;

    container.appendChild(toast);

    const bsToast = new bootstrap.Toast(toast);
    bsToast.show();

    setTimeout(() => toast.remove(), 5000);
}
