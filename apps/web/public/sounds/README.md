# Order alert sounds

Operator-uploaded sound clips for the Orders board. Drop the mp3s
here and the dashboard plays them automatically on the matching
socket events — no code change, no redeploy needed beyond the next
Render build picking up the new files.

## Filenames (exact, case-sensitive)

| File                      | Plays when                                        |
|---------------------------|---------------------------------------------------|
| `new_order.mp3`           | A new order lands (POS, Direct online, Uber Eats, Just Eat, Deliveroo, HubRise — any source) |
| `canceled_order.mp3`      | An order moves into CANCELLED / REJECTED / FAILED |
| `rider_arrived.mp3`       | A platform rider reaches the shop (RIDER_ARRIVED) — Uber Eats / Just Eat / Deliveroo / Stuart / Uber Direct |

## Recommended specs

- **Format**: MP3 (universally supported by browsers; no codec headaches)
- **Length**: 0.5–2 seconds. Longer clips collide with each other
  when orders come in quick succession.
- **Volume**: Normalise around -14 LUFS. The dashboard plays at 70%
  by default, so headroom matters more than peak loudness.
- **File size**: Under ~50 KB each. They're preloaded on every page
  visit and we'd rather not punish slow connections.

## Sanity check

After upload + Render redeploy, each file should be reachable directly:

```
https://www.orderhubsolutions.com/sounds/new-order.mp3
https://www.orderhubsolutions.com/sounds/cancelled-order.mp3
https://www.orderhubsolutions.com/sounds/rider-arrived.mp3
```

Open any of those URLs in a browser tab and you should see a tiny
audio player. If you get 404, the filename is wrong or the file
landed in the wrong folder — re-check both.

## Why no UI to upload sounds?

Sound files don't need to be tenant-specific (every shop hears the
same beeps), and the operator wanted these in place fast. Wiring a
proper upload UI behind admin auth + serving from object storage is
a Phase-B nice-to-have; for now `public/sounds/` is the
zero-config, ship-it-today path.

## Browser autoplay caveat

Modern browsers block audio.play() until the user has interacted
with the page (clicked, tapped, pressed a key). The first sound
after a page load may not play. After the operator touches any
control on the board once, every subsequent event plays correctly.
This is a browser constraint, not a bug — there is no way around
it without asking the operator to grant audio permission, which is
worse UX than "first beep is silent, then it works".
