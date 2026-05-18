#!/usr/bin/env bash
# simulate-order-flow.sh
# Tests the full order lifecycle: create → accept → prepare → ready → complete
# Usage: ./scripts/simulate-order-flow.sh <locationId> <jwtToken>
#
# Requirements:
#   - API running at localhost:4000
#   - jq installed (brew install jq)
#   - Valid JWT from POST /api/v1/auth/login

set -euo pipefail

API="http://localhost:4000/api/v1"
LOCATION_ID="${1:?Usage: $0 <locationId> <jwtToken>}"
TOKEN="${2:?Usage: $0 <locationId> <jwtToken>}"

HEADERS=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "=== OrderHub Solutions Order Flow Simulator ==="
echo "Location: $LOCATION_ID"
echo ""

# ── 1. Create a direct order ──────────────────────────────
echo "[1/6] Creating direct order..."
ORDER=$(curl -sf -X POST "$API/orders" "${HEADERS[@]}" \
  -d "$(jq --arg loc "$LOCATION_ID" '.locationId = $loc' scripts/fixtures/direct-order.json)")
ORDER_ID=$(echo "$ORDER" | jq -r '.id')
echo "    Order created: $ORDER_ID (status: $(echo "$ORDER" | jq -r '.status'))"
sleep 1

# ── 2. Accept ─────────────────────────────────────────────
echo "[2/6] Accepting order..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"ACCEPTED","note":"Accepted by staff"}' | jq -r '"    Status: " + .status'
sleep 1

# ── 3. Start preparing ────────────────────────────────────
echo "[3/6] Starting preparation..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"PREPARING"}' | jq -r '"    Status: " + .status'
sleep 2

# ── 4. Mark ready ─────────────────────────────────────────
echo "[4/6] Marking ready..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"READY"}' | jq -r '"    Status: " + .status'
sleep 1

# ── 5. Dispatch ───────────────────────────────────────────
echo "[5/6] Dispatching..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"DISPATCHED"}' | jq -r '"    Status: " + .status'
sleep 1

# ── 6. Complete ───────────────────────────────────────────
echo "[6/6] Completing order..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"COMPLETED"}' | jq -r '"    Status: " + .status'

echo ""
echo "=== Order $ORDER_ID completed successfully ==="
echo ""
echo "Fetch full order with:"
echo "  curl -s '$API/orders/$ORDER_ID' -H 'Authorization: Bearer $TOKEN' | jq ."
