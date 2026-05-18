#!/usr/bin/env bash
# simulate-webhook.sh
# Sends a test webhook payload to the API as if it came from a platform.
# WARNING: Signature verification will FAIL for real secrets — this only works
# when the integration's webhookSecret is set to "test-secret-for-dev".
#
# Usage:
#   ./scripts/simulate-webhook.sh uber-eats <locationId>
#   ./scripts/simulate-webhook.sh deliveroo <locationId>

set -euo pipefail

API="http://localhost:4000/api/v1"
PLATFORM="${1:?Usage: $0 <platform> <locationId>}"
LOCATION_ID="${2:?Usage: $0 <platform> <locationId>}"
SECRET="${3:-test-secret-for-dev}"

FIXTURE="scripts/fixtures/${PLATFORM}-order.json"
if [[ ! -f "$FIXTURE" ]]; then
  echo "ERROR: Fixture not found: $FIXTURE"
  exit 1
fi

BODY=$(cat "$FIXTURE")
# Compute HMAC-SHA256 signature matching each platform's scheme
case "$PLATFORM" in
  uber-eats)
    SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
    SIG_HEADER="x-uber-signature: $SIG"
    ;;
  deliveroo)
    SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
    SIG_HEADER="deliveroo-signature: $SIG"
    ;;
  just-eat)
    SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
    SIG_HEADER="x-je-signature: $SIG"
    ;;
  hubrise)
    SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
    SIG_HEADER="x-hubrise-signature: $SIG"
    ;;
  *)
    echo "Unknown platform: $PLATFORM"
    exit 1
    ;;
esac

echo "=== Simulating $PLATFORM webhook → location $LOCATION_ID ==="
echo "Signature header: $SIG_HEADER"
echo ""

RESPONSE=$(curl -sf -w "\n%{http_code}" \
  -X POST "$API/webhooks/$PLATFORM/$LOCATION_ID" \
  -H "Content-Type: application/json" \
  -H "$SIG_HEADER" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo "HTTP $HTTP_CODE: $BODY"

# ── Duplicate test ─────────────────────────────────────────
echo ""
echo "Sending duplicate (should return {duplicate: true})..."
RESPONSE2=$(curl -sf -w "\n%{http_code}" \
  -X POST "$API/webhooks/$PLATFORM/$LOCATION_ID" \
  -H "Content-Type: application/json" \
  -H "$SIG_HEADER" \
  -d "$BODY")
HTTP_CODE2=$(echo "$RESPONSE2" | tail -1)
BODY2=$(echo "$RESPONSE2" | head -n -1)
echo "HTTP $HTTP_CODE2: $BODY2"
