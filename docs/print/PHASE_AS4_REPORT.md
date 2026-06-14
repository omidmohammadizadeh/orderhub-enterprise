# Phase AS-4 — Printer Dashboard UI

## What shipped

- Sidebar entry **Printers** at `/dashboard/printers`, visible to
  PLATFORM_ADMIN / OWNER / DARK_KITCHEN_MANAGER / MANAGER (per
  AR-FIX-D nav matrix).
- Four-tab dashboard:
  - **Printers** — table with online/offline status, transport,
    paper width, agent binding; per-row Send test print / settings
    / delete; **Add printer wizard** (Location → Name → Type →
    Transport → IP/port → Paper width → Model → Save).
  - **Stations** — per-location CRUD; bind a default printer to
    each station.
  - **Agents** — paired devices with live online/offline (90s
    threshold), OS, hostname, version, printer count, last seen.
    Pair-new-device modal shows a 6-char code (and QR JSON) the
    bridge binary redeems.
  - **Alerts & sounds** — per-trigger configuration (sound URL,
    volume, repeat count, repeat interval, require acknowledgement)
    with browser audio preview.
- Widget strip: Online / Offline / Queue depth / Failed-last-24h /
  Last print time. Refetches every 15 s.
- **AlertSoundPlayer** mounted in the dashboard layout — subscribes
  to `new-order`, `order:updated` (CANCELLED / RIDER_ARRIVED),
  `printer:agent:offline`, `printer:job:failed` and triggers the
  matching configured sound + repeat pattern in every open tab.
- Reprint dropdown on every order row: Kitchen ticket / Customer
  receipt / Driver slip / Reprint everything. Each click creates new
  PrintJob rows (audit trail intact).
- API additions:
  - `AlertConfig` / `AlertAck` Prisma models + migration
    `20260615000000_phase_as4_alerts`
  - `/v1/alerts` (list / upsert / delete / ack)
  - `/v1/print-jobs/widgets` (counter strip)
  - `/v1/print-jobs?status=…&limit=…` (recent activity list)

## Deferred (clearly scoped follow-ups)

| Piece | Where it lives | Why deferred |
|---|---|---|
| **Routing UI** (assign menu item → station / category → station / modifier group → station) | Drawer in the Menu / Products tabs | Touches three existing pages; AS-1 API already supports it. Easier landed alongside Menu Manager edits than as a 4th tab here. |
| **Per-station alert override** | AlertsTab → add station picker | UI work only, no backend changes. |
| **Sound upload** | Use Supabase Storage upload from AlertsTab (currently URL paste) | Wait for AL-2 (Supabase Storage signed URLs). |
| **WebSocket-driven live status** | Replace 15s refetchInterval | Server emits already exist (`printer:job:created`, `printer:agent:online`). Wire up in AS-4.1. |
| **Per-printer logs view** | `/v1/print-jobs` list endpoint is in place — modal lands in AS-4.2. | Endpoint shipped; modal is a UI follow-up. |

## What the operator can do today

1. Open Printers → Stations → "Pizza station" + assign default printer.
2. Switch to Printers tab → wizard → adds Epson TM-m30 on LAN.
3. Open settings → enable auto-cut, set copies=2, add auto-print rule
   ORDER_ACCEPTED.
4. Open Alerts → upload a sound URL for `NEW_ORDER`, set repeat=3.
5. Open Agents → Pair new device → run `orderhub-print-bridge pair`
   on the kitchen Mac → enter the 6-char code. Agent appears Online
   ~15s later.
6. Place a test order — receipt prints on the front printer, kitchen
   ticket on the kitchen printer, browser plays the alert sound.
7. Hit the Printer icon on any order row → Reprint kitchen ticket.

## Next phase

AS-5 — Bluetooth printer concrete adapters (per-vendor characteristic
UUIDs in the bridge). AT — Uber / Deliveroo / Just Eat / HubRise
production connections.
