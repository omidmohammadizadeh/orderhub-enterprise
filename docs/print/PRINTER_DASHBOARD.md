# Printer Dashboard — operator guide

## Where it lives

Sidebar → **Printers**.

Visible to: PLATFORM_ADMIN, OWNER, DARK_KITCHEN_MANAGER, MANAGER.

## Tabs

### Printers
Add / edit / remove printers. Per-row buttons:
- **Send test print** — server queues a TEST_PRINT PrintJob targeting
  that printer. Includes logo placeholder, location name, datetime,
  QR code, optional cash-drawer kick.
- **Settings** — copies, print logo, QR code, large font, open cash
  drawer, auto-cut. Auto-print rules: one or more (trigger, copies)
  pairs.

### Stations
Per-location rows. Each station has a kind (KITCHEN / BAR / EXPO etc.)
and a default printer. Routing engine sends items here based on the
most-specific-wins rule (see STATION_ROUTING.md).

### Agents
Devices running the OrderHub Print Bridge or the Flutter app. Pair
new devices via 6-char code or QR. Rotate or revoke tokens per device.
Live online/offline (90s threshold), OS, hostname, version, printer
count.

### Alerts & sounds
Configure how the dashboard reacts to: new orders, cancellations,
rider arrived, scheduled-order-ready, printer offline, failed print.
Sound URL + volume + repeat × interval + require-ack. Preview from
the card.

## Widget strip

- **Online / Offline** — printer counts at the selected location
- **Queue** — PrintJobs in QUEUED or CLAIMED state
- **Failed 24h** — PrintJobs that hit FAILED in the last 24h
- **Last print** — most recent successful PRINTED timestamp

Refetches every 15s.
