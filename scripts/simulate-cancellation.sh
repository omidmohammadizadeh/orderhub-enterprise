#!/usr/bin/env bash
# simulate-cancellation.sh
# Creates an order and immediately cancels it to test cancel ticket print + sync

set -euo pipefail

API="http://localhost:4000/api/v1"
LOCATION_ID="${1:?Usage: $0 <locationId> <jwtToken>}"
TOKEN="${2:?Usage: $0 <locationId> <jwtToken>}"

HEADERS=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "=== Cancellation Flow Test ==="

ORDER=$(curl -sf -X POST "$API/orders" "${HEADERS[@]}" \
  -d "$(jq --arg loc "$LOCATION_ID" '.locationId = $loc' scripts/fixtures/direct-order.json)")
ORDER_ID=$(echo "$ORDER" | jq -r '.id')
echo "Order created: $ORDER_ID"
sleep 1

echo "Accepting..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"ACCEPTED"}' | jq -r '"Status: " + .status'
sleep 1

echo "Cancelling..."
curl -sf -X PATCH "$API/orders/$ORDER_ID/status" "${HEADERS[@]}" \
  -d '{"status":"CANCELLED","cancelReason":"Customer called to cancel","note":"Via phone"}' \
  | jq -r '"Status: " + .status + " | Reason: " + (.cancelReason // "n/a")'

echo ""
echo "=== Cancellation complete for $ORDER_ID ==="
