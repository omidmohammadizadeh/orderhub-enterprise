# Brand logo assets

Operator-uploaded PNG logos for delivery platforms and integrations.
Drop the files in this folder and they appear everywhere — marketing
site (header, marquee, footer, Integrations menu), POS publish modal,
Orders board badges, Locations → Brands → platform cards.

## Filenames (exact, case-sensitive)

| File              | Used for                       |
|-------------------|--------------------------------|
| `ubereats.png`    | Uber Eats                      |
| `deliveroo.png`   | Deliveroo                      |
| `justeat.png`     | Just Eat                       |
| `uberdirect.png`  | Uber Direct                    |
| `stuart.png`      | Stuart                         |
| `hubrise.png`     | HubRise                        |
| `stripe.png`      | Stripe                         |
| `online.png`      | Generic "online ordering" tile |

Note: the Order Hub POS badge lives at `/orderhub-logo.png` (one
folder up), not here — that's already wired in.

## Recommended specs

- **Square PNG** with transparent background (256×256 px or larger)
- **Under ~50 KB** for snappy loading
- The logo sits on a brand-coloured tile (set in code), so PNGs with
  transparent backgrounds blend in cleanly. Solid-background PNGs work
  too — they just hide the tile colour.

## Sanity check

After uploading + Render redeploying, each file should be reachable
directly, e.g.:

```
https://www.orderhubsolutions.com/brand-logos/ubereats.png
```

If a file 404s, the UI silently falls back to a hand-drawn SVG
placeholder, so the page never breaks while you're partway through
uploading.
