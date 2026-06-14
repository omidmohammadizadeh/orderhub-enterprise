# WebSocket protocol

## Why WebSocket + polling, not WebSocket alone

A printer queue can't tolerate dropped jobs. WebSockets are the fast
path for instant printing; HTTP polling every 5s is the safety net
when the socket is disconnected, reconnecting, or behind a corporate
NAT that strips long-lived connections.

The agent runs both loops in parallel. Each loop calls
`POST /v1/print-jobs/claim` — the claim is atomic on the server
(Postgres `FOR UPDATE SKIP LOCKED`), so the two loops can't double-print
the same job.

## Connect

```
wss://orderhub-api-0re6.onrender.com   (Socket.IO transport)

auth handshake (Socket.IO `auth` field):
  {
    agentId:    "cmagent01...",
    agentToken: "oha_..."
  }
```

The server's Socket.IO gateway verifies the token (bcrypt compare),
joins the connection to the room `location:{locationId}`, and acks
the connection.

## Server → agent events

| Event                  | Payload                                                                              |
|------------------------|--------------------------------------------------------------------------------------|
| `printer:job:created`  | `{ id, type, printerId, stationId, status }` — kick the drain loop                    |
| `printer:job:updated`  | `{ id, status }` — only relevant for status panels; agent ignores                     |
| `printer:agent:online` | `{ agentId, lastSeenAt }` — for the future Printer Dashboard                          |
| `printer:agent:offline`| `{ agentId, lastSeenAt }` — for the future Printer Dashboard                          |

`printer:job:created` is the only event the agent reacts to today; the
others exist so the dashboard UI can render real-time printer health
without polling.

## Agent → server events

The agent doesn't publish — every state mutation goes through REST so
idempotency keys + retry on the outbox just work. WebSockets are
read-only for the agent.

## Reconnect behaviour

`socket.io-client` config:

```js
io(url, {
  auth: { agentId, agentToken },
  reconnection:        true,
  reconnectionDelay:   1000,
  reconnectionDelayMax: 5000,
})
```

When the socket reconnects, the agent calls drain() once immediately
to catch any jobs that fired while we were disconnected.

## Polling fallback

Every 5 seconds, the agent calls `POST /v1/print-jobs/claim` even when
the socket is connected. Costs ~12 cheap DB hits/min per agent — the
server's claim query is an indexed point lookup. In return: zero
missed jobs, ever.
