# @orderhub/print-bridge

Order Hub Print Bridge — cross-platform agent that drives local
printers (LAN / Bluetooth / USB) on behalf of the Order Hub API.

```
orderhub-print-bridge pair          # interactive pairing
orderhub-print-bridge                # run (after pairing)
orderhub-print-bridge config         # print config path + contents
orderhub-print-bridge test-print     # render a sample receipt to stdout
```

## Build

```
pnpm install
pnpm --filter @orderhub/print-bridge build

# Standalone binaries via pkg:
pnpm --filter @orderhub/print-bridge package:mac    # macOS x64 + arm64
pnpm --filter @orderhub/print-bridge package:win    # Windows x64
pnpm --filter @orderhub/print-bridge package:linux  # Linux x64
```

## Docs

- `docs/print/PHASE_AS3_REPORT.md` — what shipped and why
- `docs/print/PRINT_AGENT_INSTALL.md` — install + service unit
- `docs/print/AGENT_PAIRING.md` — pair code protocol
- `docs/print/WEBSOCKET_PROTOCOL.md` — connect / events / fallback
- `docs/print/BLUETOOTH_PRINTING.md` — vendor adapters
- `docs/print/USB_PRINTING.md` — vendor/product IDs + permissions

The same protocol is what the future Flutter mobile/desktop apps
will speak — no API rewrite needed when those land.
