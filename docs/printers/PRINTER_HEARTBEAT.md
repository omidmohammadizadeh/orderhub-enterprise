# Printer + Agent Heartbeat

Two independent heartbeats run in parallel:

## A) Server probes LAN printers

`PrinterHeartbeatCron.probeAll()` ticks every 30 seconds and probes
every LAN / EPSON_EPOS printer:

- LAN raw: `tcp.connect(host, port||9100)` with 3s timeout
- EPSON ePOS: `GET /cgi-bin/epos/service.cgi` with 4s timeout

Result flips `Printer.isOnline` and stamps `metadata.lastHeartbeatAt`.

This is the **server's view** of LAN reachability — independent of
any agent's view. Useful for spotting a powered-off printer with
nobody on the till to notice.

## B) Agents heartbeat the server

Web bridge / Flutter app POSTs to `POST /print-agents/:id/heartbeat`
**every 15 seconds**. Body shape:

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

`PrintAgentsService.heartbeat`:
- updates `lastSeenAt = now`
- merges `osType / hostname / versionString / printerCount`
- for each `printerStatuses[]` entry, updates `Printer.isOnline`

`PrintAgentsService.detectOfflineAgents()` runs from the same 30-second
housekeeping cron and flips agents whose `lastSeenAt` is older than
**90 seconds** offline. Their printers are also marked
`isOnline=false` and the `printer:agent:offline` socket event fires.

## Status semantics

```
agent.lastSeenAt = NULL          → never connected (just registered)
agent.lastSeenAt < now - 90s     → OFFLINE (cron flipped it)
agent.lastSeenAt >= now - 90s    → ONLINE
```

The dashboard derives `agentOnline` client-side from `lastSeenAt`
rather than a stored flag, so the moment a fresh heartbeat lands
the chip flips green without waiting for the next cron tick.

## When something looks wrong

1. **Agent shows offline but app says it's running.**
   Check the device's clock skew — bcrypt token compare is clock-
   free but the agent's loop may have died silently. Check the
   bridge process logs.

2. **Printer shows online but jobs FAILED with `printer_offline`.**
   The TCP probe succeeded against port 9100 but the print job
   itself timed out. Likely the printer is connected to LAN but
   USB cable to the till is broken, or the printer ran out of paper
   (probe doesn't detect that). Reprint after restocking.

3. **`printer.agent.offline` floods the dashboard.**
   Check the cron logs — likely a network blip between the agent
   and the API. The agent will self-recover when network returns.
