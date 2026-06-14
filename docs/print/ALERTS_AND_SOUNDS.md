# Alerts and sounds

## Triggers

| Trigger                 | Source event                                         |
|-------------------------|------------------------------------------------------|
| `NEW_ORDER`             | Socket `new-order`                                   |
| `ORDER_CANCELLED`       | Socket `order:updated` with status CANCELLED/REJECTED|
| `RIDER_ARRIVED`         | Socket `order:updated` with status RIDER_ARRIVED     |
| `SCHEDULED_ORDER_READY` | Cron flips a scheduled order's `scheduledAt` ≤ now   |
| `PRINTER_OFFLINE`       | Socket `printer:agent:offline`                       |
| `FAILED_PRINT`          | Socket `printer:job:failed`                          |

## Configuration shape

```ts
AlertConfig {
  trigger:                AlertTrigger
  enabled:                boolean
  soundUrl:               string         // mp3 / wav / ogg
  volume:                 number         // 0–1
  repeatCount:            number         // play N times
  repeatIntervalMs:       number         // gap between plays
  autoStopSeconds?:       number
  requireAcknowledgement: boolean        // keep ringing until ack
  stationId?:             string         // optional narrowing
}
```

## Acknowledgement

The dashboard sends `POST /v1/alerts/ack { locationId, trigger,
referenceKey }`. `referenceKey` is unique per alert instance (e.g.
`new-order:cmorder123`) so the same physical event can't double-fire.

## Browser autoplay

Modern browsers block `Audio.play()` until the user has interacted
with the page. The dashboard layout mounts the player after AuthGuard
/ AccessGate, so by the time an alert fires the operator has already
clicked Sign In and the audio context is unlocked.

## Sound hosting

Today: paste a public URL into the soundUrl field. Default sound is
`https://orderhub-static.onrender.com/sounds/notification.mp3`.

Future (AL-2): upload to Supabase Storage from the Alerts card. The
upload returns a signed URL that goes into `soundUrl` automatically.
