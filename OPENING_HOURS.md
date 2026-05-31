# Opening Hours

## Storage

`locations.openingHours` is a JSON column shaped as:

```json
{
  "monday":    { "enabled": true,  "slots": [{ "from": "16:00", "to": "23:30" }] },
  "tuesday":   { "enabled": true,  "slots": [{ "from": "16:00", "to": "23:30" }, { "from": "00:00", "to": "01:00" }] },
  "wednesday": { "enabled": false, "slots": [] },
  …
}
```

Each day has up to 2 slots today; the JSON shape supports more if a later phase needs it. Times are `HH:MM` strings in the location's timezone.

## API

| Endpoint | Purpose |
|---|---|
| `GET  /v1/locations/:id/opening-hours` | Read current map (returns empty map when never set) |
| `PATCH /v1/locations/:id/opening-hours` | Replace the whole map |
| `POST /v1/locations/:id/opening-hours/apply-to` | `{ locationIds: [...] }` — copy this map onto other locations in the same tenant |

## Open/closed calculation

`isOpenAt(hours, at)` in `locations.service` is the canonical check used by:

- Online ordering "we're closed" banner (Phase AO)
- POS warning before placing a future-scheduled order outside hours
- Future Uber Eats / Deliveroo / Just Eat store-status sync jobs

Slot wrapping past midnight (`22:00 → 02:00`) is supported — the helper detects `to ≤ from` and shifts the comparison window by 24h.

## What's missing

- No JSON-schema validation on PATCH yet — invalid time strings make `isOpenAt` quietly return false.
- No outbox event emitted on save. The store-status push to delivery platforms is a Phase AO job.
- No timezone-aware comparison — `isOpenAt` uses the server's local `Date`. Acceptable while every tenant runs in `Europe/London`; the helper will gain a tz argument when we onboard the first non-UK tenant.
