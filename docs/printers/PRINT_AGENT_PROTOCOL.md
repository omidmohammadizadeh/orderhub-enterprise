# Print Agent Protocol

All endpoints under `https://orderhub-api-0re6.onrender.com/api/v1`.

Agent endpoints accept `X-Agent-Id` + `X-Agent-Token` headers in place
of the user JWT. Token is bcrypt'd server-side; rotation invalidates
in-flight headers.

## Register

`POST /print-agents` (user JWT)

```json
{
  "locationId": "loc_abc",
  "name": "Front-of-house Mac",
  "kind": "WEB_BRIDGE",      // WEB_BRIDGE | FLUTTER_MOBILE | FLUTTER_DESKTOP | SERVER_DIRECT
  "capabilities": { "transports": ["lan","bluetooth","usb"] },
  "versionString": "1.0.0"
}
```

→ `{ "id": "agt_xyz", "apiToken": "oha_..." }` — token is shown
**once**; the operator copies it into the bridge config / Flutter
app QR pairing.

## Heartbeat

`POST /print-agents/:id/heartbeat` every **15 seconds**.

Headers: `X-Agent-Token: oha_...`

```json
{
  "versionString": "1.0.4",
  "osType": "macOS 14.5",
  "hostname": "front-pos.local",
  "printerCount": 3,
  "printerStatuses": [
    { "printerId": "prn_a", "isOnline": true },
    { "printerId": "prn_b", "isOnline": false }
  ]
}
```

The server flips `Printer.isOnline` for each row reported and updates
`lastSeenAt`. **If no heartbeat for 90 seconds the agent is marked
offline** and `printer:agent:offline` fires.

## Claim a batch

`POST /print-jobs/claim`

Headers: `X-Agent-Id`, `X-Agent-Token`

```json
{
  "printerIds": ["prn_a","prn_b"],
  "limit": 5
}
```

→ array of PrintJob rows now bound to this agent with `status=CLAIMED`.

## Lifecycle

```
POST /print-jobs/:id/start     → status=PRINTING
POST /print-jobs/:id/complete  → status=PRINTED, printedAt=now
POST /print-jobs/:id/fail      body: { failureReason, lastError, retryable }
```

`retryable=true` + attempts<max → status=RETRYING with `nextRetryAt`.
`retryable=false` OR attempts>=max → status=FAILED with `deadLetteredAt`.

## Standard failureReason tags

| Tag | Meaning |
|---|---|
| `printer_offline` | TCP timeout / connect refused / bluetooth not paired |
| `network` | Agent itself can't reach the API or the printer |
| `bad_payload` | Renderer threw on a structural defect |
| `paper_out` | Printer ACK'd but reported paper end |
| `unknown` | Anything else; surfaces in the dashboard as-is |
