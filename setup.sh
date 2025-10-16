#!/bin/bash
echo "🚀 FileRoom Perfect - The Ultimate Chat Experience"
echo "=================================================="
echo ""

if ! command -v docker &> /dev/null; then
    echo "❌ Docker not installed"
    exit 1
fi

if docker compose version &> /dev/null; then
    COMPOSE="docker compose"
else
    COMPOSE="docker-compose"
fi

echo "🧹 Cleaning..."
$COMPOSE down -v 2>/dev/null

echo "🏗️  Building..."
$COMPOSE build

echo "🚀 Starting..."
$COMPOSE up -d

echo "⏳ Starting..."
sleep 8

for i in {1..10}; do
    if curl -f http://localhost:8000/manifest.json > /dev/null 2>&1; then
        echo ""
        echo "✅ FileRoom Perfect is ready!"
        echo ""
        echo "🔗 http://localhost:8000"
        echo ""
        echo "🎉 PERFECT FEATURES:"
        echo "   📸 Image previews with click-to-expand"
        echo "   🎵 Custom voice controls with play/pause"
        echo "   🔗 Link detection and highlighting"
        echo "   ⭕ Subtle circular progress timers"
        echo "   📱 Perfect mobile experience"
        echo "   📍 Location sharing with maps"
        echo "   📷 Camera photo capture"
        echo "   🌙 Dark mode support"
        echo "   ⚡ Real-time WebSocket updates"
        echo ""
        echo "The ultimate chat experience! 🎯"
        echo ""
        exit 0
    fi
    echo "   Checking... ($i/10)"
    sleep 2
done

echo "❌ Failed. Logs:"
$COMPOSE logs
