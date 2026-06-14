# Agent pairing

## Why a pair code (not a flat token)

Operators shouldn't have to copy-paste a 64-byte token from a Settings
screen into the bridge config. The pair code (6 chars, 10-minute TTL,
no ambiguous letters) keeps the handshake short and reusable.

## Flow

```
┌───────────────┐                                  ┌──────────┐
│  Dashboard    │  "Pair new device"               │ Operator │
│  (web)        │                                  └────┬─────┘
└──────┬────────┘                                       │
       │ POST /v1/print-agents/pair-codes               │
       │     { locationId }                             │
       │                                                │
       │ ←  { code: "K7M2QH", expiresAt, qr: "{api,code}" }
       │                                                │
       │  shows code + QR                               │
       │                                                ▼
       │                                       ┌──────────────────┐
       │                                       │ orderhub-print-  │
       │                                       │ bridge pair      │
       │                                       └────┬─────────────┘
       │                                            │
       │  POST /v1/print-agents/pair                │
       │  { code, deviceId, deviceName,             │
       │    hostname, osType, capabilities }        │
       │ ←  { id, apiToken, locationId }            │
       │                                            │
       │  config.json updated atomically            │
       │                                            ▼
       │                                       Agent runs.
       └────────────────────────────────────────────┘
```

## Codes

- 6 characters, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  (no `0/O`, no `1/I/L`)
- 10-minute TTL
- Single use (`usedAt` set on redemption)
- Unique constraint per row
- Linked back to the resulting `PrintAgent` row via `agentId`

## QR encoding

```json
{
  "api": "https://orderhub-api-0re6.onrender.com/api/v1",
  "code": "K7M2QH"
}
```

The Flutter app scans this directly; the desktop bridge prompts for
the code on the CLI.

## Re-pair / device re-install

When the bridge is reinstalled on the same machine, its `deviceId`
(stored in `config.json`) stays the same. The pair flow detects this:

```ts
const existing = await prisma.printAgent.findUnique({
  where: { deviceId: dto.deviceId }
});
if (existing) {
  // reuse the row, mint a new token, keep existing printer bindings
}
```

So the operator can hand over a fresh pair code, the agent re-pairs,
and previously assigned printers stay bound. **No re-setup needed.**

## Token revocation

`DELETE /v1/print-agents/:id` flips `isActive=false` and unbinds every
printer that had `agentId = this`. The agent's next claim returns
401, the agent loop logs the error and exits.

## Rotating tokens

`POST /v1/print-agents/:id/rotate-token` mints a fresh plaintext token
and saves the new bcrypt hash. The operator copies the new token into
the agent's config and restarts the bridge. The old hash is
immediately invalid.

## Security notes

- Tokens are bcrypt-hashed at rest (cost 10).
- Tokens are sent over TLS only.
- Token prefix `oha_` makes leaked-token detection scripts easy.
- Pair codes are unprivileged on their own — they only work in the
  10-minute window and one-shot.
- Stolen tokens are revocable in one click; stolen pair codes expire
  on their own.
