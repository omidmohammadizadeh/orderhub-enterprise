# Order Hub logo asset

The marketing site references `/orderhub-logo.png` in three places:

- `apps/web/src/components/marketing/site-nav.tsx` — top nav logo
- `apps/web/src/components/marketing/brand-logo.tsx` — marquee tile
- `apps/web/src/app/page.tsx` — footer logo

To use your real brand mark instead of the placeholder, save your
PNG/JPG at:

```
apps/web/public/orderhub-logo.png
```

Then commit and push. Render rebuilds and the new logo appears
everywhere `/orderhub-logo.png` is referenced.

## Recommended specs

| What | Why |
|---|---|
| **PNG with transparent background** | Lets the logo sit cleanly on both white (header) and zinc-50 (marquee tile) backgrounds |
| **Square aspect ratio** | The marquee tile is a fixed-size square; non-square logos get letterboxed |
| **At least 256×256 px** | Crisp on Retina screens. Larger is fine — the browser downscales |
| **Under ~50 KB** | Snappier first paint on slow connections |

## Quick sanity check after upload

After `git push` + Render finishes deploying, visit
`https://www.orderhubsolutions.com/orderhub-logo.png` directly in
your browser. You should see your logo. If you get a 404, the file
isn't in the right place — confirm it's under `apps/web/public/` and
named exactly `orderhub-logo.png` (case-sensitive).
