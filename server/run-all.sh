#!/bin/bash
# Run all 3 RS-SDK services in parallel with colored output
# Usage: bash server/run-all.sh

cleanup() {
    echo ""
    echo "Shutting down..."
    kill $ENGINE_PID $WEBCLIENT_PID $GATEWAY_PID 2>/dev/null
    wait $ENGINE_PID $WEBCLIENT_PID $GATEWAY_PID 2>/dev/null
    echo "All services stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM

DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "Starting RS-SDK services..."
echo ""

# 1. Game Engine
cd "$DIR/engine"
bun run src/app.ts 2>&1 | sed "s/^/$(printf "${RED}[engine]${NC}  ")/" &
ENGINE_PID=$!

# 2. Web Client bundler
cd "$DIR/webclient"
bun --watch run bundle.ts dev 2>&1 | sed "s/^/$(printf "${BLUE}[client]${NC}  ")/" &
WEBCLIENT_PID=$!

# 3. Gateway
cd "$DIR/gateway"
bun run gateway.ts 2>&1 | sed "s/^/$(printf "${GREEN}[gateway]${NC} ")/" &
GATEWAY_PID=$!

echo ""
echo "Services started:"
echo "  Engine:    PID $ENGINE_PID"
echo "  WebClient: PID $WEBCLIENT_PID"
echo "  Gateway:   PID $GATEWAY_PID (ws://localhost:7780)"
echo ""
echo "Game client: http://localhost:8888/rs2.cgi"
echo "Press Ctrl+C to stop all services."
echo ""

wait
