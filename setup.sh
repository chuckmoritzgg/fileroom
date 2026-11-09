#!/bin/bash
# Build and start FileRoom with Docker Compose.
set -e
PORT="${FILEROOM_PORT:-8181}"   # host port, see docker-compose.yml

if ! command -v docker &> /dev/null; then
    echo "❌ Docker not installed"
    exit 1
fi
if docker compose version &> /dev/null; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

echo "🏗️  Building..."
$COMPOSE build
echo "🚀 Starting..."
$COMPOSE up -d

for i in {1..20}; do
    if curl -fsS "http://localhost:${PORT}/health" > /dev/null 2>&1; then
        echo "✅ FileRoom is ready: http://localhost:${PORT}"
        echo "   (Installing the app / offline mode / share target need HTTPS or localhost.)"
        exit 0
    fi
    echo "   Waiting... ($i/20)"
    sleep 2
done
echo "❌ Failed to start. Logs:"
$COMPOSE logs
exit 1
