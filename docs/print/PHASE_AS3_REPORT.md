# Phase AS-3 — Cross-Platform Print Agent

## Goal

A single agent codebase that drives Order Hub printers on every platform
(Windows, macOS, Linux today; Android/iOS/desktop Flutter tomorrow)
without any API rewrite. The API stays the source of truth; the agent
is the local hands.

## What shipped

- `apps/print-bridge/` — Node 18+ TypeScript binary
  - `src/main.ts` — CLI (`run` | `pair` | `config` | `test-print`)
  - `src/pair.ts` — interactive pair-code redemption
  - `src/agent.ts` — heartbeat loop, claim loop, outbox drain
  - `src/config/` — `~/.orderhub-print-bridge/config.json` persistence
  - `src/net/` — REST `ApiClient` + Socket.IO `JobSocket`
  - `src/queue/outbox.ts` — local SQLite outbox + printed history
  - `src/renderer/escpos-renderer.ts` — JSON → ESC/POS bytes
  - `src/transport/` — pluggable LAN / Bluetooth / USB
- `pkg`-targeted builds: `pnpm package:mac|win|linux`
- API extensions:
  - `AgentPairCode` model + migration `20260614200000_phase_as3_agent_pairing`
  - `PrintAgent.deviceId` (unique), `deviceName`, `osType`, `hostname`
  - `POST /v1/print-agents/pair-codes` (operator) → 6-char code + QR
  - `POST /v1/print-agents/pair` (public) → exchanges code for token

## Architecture

```
┌─────────────┐  WebSocket  ┌──────────────┐
│   API       │ ◀──────────▶│  print-bridge│
│   (NestJS)  │  REST       │  (Node + pkg)│
└─────────────┘             └──────┬───────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
            ┌──────┐           ┌──────────┐       ┌─────┐
            │ LAN  │           │ Bluetooth│       │ USB │
            │ TCP  │           │  noble   │       │ libusb │
            └──────┘           └──────────┘       └─────┘
              Epson TM-m30        Sunmi V2          XPrinter
              Star TSP143         Star TSP650       Epson TM
```

Single mental model: the agent claims jobs, renders JSON → bytes, hands
bytes to the right transport. Adding a new transport (cloud print, Star
CloudPRNT, etc.) is one file in `src/transport/`.

## Pairing flow

1. Operator clicks **Pair new device** on the printers dashboard.
2. API generates a 6-char code (`alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, no
   ambiguous chars) + 10-minute TTL + bakes it into a QR with the API
   URL.
3. Operator runs the bridge binary: `orderhub-print-bridge pair`.
4. Agent posts `{ code, deviceId, deviceName, hostname, osType }` to
   `/v1/print-agents/pair`.
5. API verifies the code, creates a `PrintAgent` row, returns
   `{ id, apiToken, locationId }`. Token is stored in config — only
   bcrypt hash kept on the server.
6. Re-pair with the same `deviceId` reuses the existing agent row
   (idempotent install).

## Decisions

- **Node + pkg, not Tauri/Electron**: zero install dependencies, single
  binary per OS, ~50MB, includes node + npm deps. Tauri would need a
  Rust toolchain on the build server; Electron is too heavy for a
  background daemon.
- **better-sqlite3 for the outbox**: synchronous API maps well to a
  background poller, ships native binaries via pkg.
- **Optional native deps**: `noble` (Bluetooth) and `usb` are
  `optionalDependencies`. Operators running LAN-only never see the BLE
  install error on Linux.
- **WebSocket-first, polling fallback**: instant printing in the happy
  path, no missed jobs when the socket drops.
- **Per-printer transport in config**: one device can serve a LAN
  receipt printer + a Bluetooth kitchen printer simultaneously.

## Not in AS-3 (deferred)

- mDNS auto-discovery — printers must be configured by IP/MAC today.
  Discovery library plumbing is sketched in `transport/index.ts` for
  AS-3.1.
- System tray UI — for now the agent runs as a foreground binary or
  systemd service. Tray is AS-3.2 once we pick between `node-systray2`
  and a small Tauri shell.
- Bluetooth concrete adapter — file stubbed with the protocol; vendor
  characteristic UUIDs differ per printer brand so AS-3.3 lands per
  manufacturer.
- Flutter desktop port — AS-3 deliberately *doesn't* ship Flutter.
  The bridge protocol is identical to what the Flutter app will
  speak; AS-4 documentation captures it.

## Hand-off to AS-4 (Printer Dashboard UI)

The dashboard needs to render the data AS-3 exposes:

- `GET /v1/print-agents?locationId=` — list, with `lastSeenAt`,
  `osType`, `hostname`, `printerCount`, online/offline (derived from
  `lastSeenAt < now-90s`).
- `POST /v1/print-agents/pair-codes` — generate code + QR.
- `DELETE /v1/print-agents/:id` — revoke; cascades to unbind printers.
- `POST /v1/print-agents/:id/rotate-token` — new token without re-pair.

Everything else (printer CRUD, station CRUD, auto-print rules) is
already in place from AS-1/AS-2.
