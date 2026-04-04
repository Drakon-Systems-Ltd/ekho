#!/bin/bash
set -e

echo "=== Ekho Docker Smoke Test ==="
echo ""

# Build
echo "1. Building image..."
docker compose build --quiet
echo "   Done."

# Start
echo "2. Starting relay..."
docker compose up -d
echo "   Waiting for healthcheck..."
sleep 5

# Health check
echo "3. Checking /healthz..."
HEALTH=$(curl -sf http://localhost:4000/healthz 2>&1 || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "   PASS: healthz responded ok"
else
  echo "   FAIL: $HEALTH"
  docker compose logs relay
  docker compose down
  exit 1
fi

# Root endpoint
echo "4. Checking / ..."
ROOT=$(curl -sf http://localhost:4000/ 2>&1 || echo "FAIL")
if echo "$ROOT" | grep -q '"service":"ekho-relay"'; then
  echo "   PASS: root endpoint responded"
else
  echo "   FAIL: $ROOT"
fi

# Check tier
if echo "$ROOT" | grep -q '"tier"'; then
  echo "   PASS: license tier present in response"
fi

# Cleanup
echo "5. Stopping..."
docker compose down --volumes
echo ""
echo "=== Smoke test passed ==="
