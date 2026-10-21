"""Cut the driver app's icons out of assets/brand/logo-source.webp.

Crop and scale only — nothing is redrawn, so the tile, arrow and wordmark stay
exactly as the artwork has them. Run from apps/driver:

    python3 scripts/make-brand-assets.py

Writes:
  assets/icon.png               1024² tile on the dark background (iOS rounds it)
  assets/adaptive-icon.png      1024² tile inside Android's 66% safe circle, transparent
  assets/splash-icon.png        1024² tile sized for Android 12's circular splash mask
  assets/notification-icon.png  96² white arrow on transparent (Android status bar)
  assets/brand/logo-full.png    tile + wordmark on the dark background
"""

from collections import deque
from math import hypot

from PIL import Image, ImageChops, ImageFilter

SRC = "assets/brand/logo-source.webp"
BG = (0x0A, 0x0C, 0x0F)  # theme.ts C.bg
TILE_BOX = (430, 266, 826, 662)  # generous box around the tile (measured 443..812 × 279..649)
WORDMARK_BOX = (223, 279, 1036, 968)  # tile top to the bottom of "DRIVER"

src = Image.open(SRC).convert("RGB")


def greenness(p, bg, tile):
    """0 = background, 1 = tile green; the green channel separates them cleanly.
    The ends are clipped so WebP noise doesn't leave a faint haze in the alpha."""
    t = (p[1] - bg[1]) / (tile[1] - bg[1])
    return max(0.0, min(1.0, (t - 0.08) / 0.84))


def cut_tile():
    """The tile as RGBA: exterior transparent with anti-aliased edges, the dark
    arrow inside it kept opaque. Also returns the arrow alone as an alpha mask."""
    crop = src.crop(TILE_BOX)
    w, h = crop.size
    px = crop.load()
    bg = px[2, 2]
    tile = px[w // 2, int(h * 0.2)]
    g = [[greenness(px[x, y], bg, tile) for x in range(w)] for y in range(h)]

    # Exterior = everything below half-green that is reachable from the border.
    # The arrow is also dark but enclosed by green, so the flood never gets in.
    outside = [[False] * w for _ in range(h)]
    q = deque((x, y) for x in range(w) for y in (0, h - 1))
    q.extend((x, y) for y in range(h) for x in (0, w - 1))
    while q:
        x, y = q.popleft()
        if outside[y][x] or g[y][x] >= 0.5:
            continue
        outside[y][x] = True
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not outside[ny][nx]:
                q.append((nx, ny))

    def near_outside(x, y):
        return any(
            outside[ny][nx]
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
            if 0 <= nx < w and 0 <= ny < h
        )

    out = Image.new("RGBA", (w, h))
    arrow = Image.new("L", (w, h), 0)
    op, ap = out.load(), arrow.load()
    for y in range(h):
        for x in range(w):
            if outside[y][x]:
                op[x, y] = (*tile, round(g[y][x] * 255))
            elif near_outside(x, y):
                # Outer anti-aliasing ring: the colour is the tile's, blended with bg.
                op[x, y] = (*tile, round(g[y][x] * 255))
            else:
                op[x, y] = (*px[x, y], 255)
                ap[x, y] = round((1 - g[y][x]) * 255)
    # The tile's own edge fades from green too; only keep "dark" well inside it.
    inside = Image.new("L", (w, h), 0)
    ip = inside.load()
    for y in range(h):
        for x in range(w):
            if not outside[y][x]:
                ip[x, y] = 255
    arrow = ImageChops.multiply(arrow, inside.filter(ImageFilter.MinFilter(15)))
    return out.crop(out.getbbox()), arrow.crop(arrow.getbbox())


def max_radius(rgba):
    """Distance from the centre to the furthest visible pixel."""
    w, h = rgba.size
    a = rgba.getchannel("A").load()
    return max(
        hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) for y in range(h) for x in range(w) if a[x, y] > 16
    )


def place(tile, canvas, radius, fill=None):
    """Scale the tile so its furthest pixel sits `radius` px from the centre."""
    s = radius / max_radius(tile)
    t = tile.resize((round(tile.width * s), round(tile.height * s)), Image.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (*fill, 255) if fill else (0, 0, 0, 0))
    out.alpha_composite(t, ((canvas - t.width) // 2, (canvas - t.height) // 2))
    return out


tile, arrow = cut_tile()

# iOS / store icon: opaque, no wordmark. ~62% of the edge, like the artwork's own framing.
place(tile, 1024, 1024 * 0.36, BG).convert("RGB").save("assets/icon.png", optimize=True)

# Android adaptive foreground: the visible safe zone is a circle of 66/108 of the
# canvas (626 px of 1024); keep every pixel of the tile inside it with margin.
place(tile, 1024, 1024 * 66 / 108 / 2 * 0.92).save("assets/adaptive-icon.png", optimize=True)

# Splash: the plugin draws this at imageWidth dp in a 288 dp canvas and Android 12+
# masks it to a 192 dp circle. At imageWidth 200 a radius of 0.46·W is 92 dp — inside.
place(tile, 1024, 1024 * 0.46).save("assets/splash-icon.png", optimize=True)

# Notification small icon: Android only uses the alpha, tinted with `color`.
# 96 px is the xxxhdpi size of the 24 dp icon; keep the glyph in the 22 dp live area.
side = 96
live = round(side * 22 / 24)
s = live / max(arrow.size)
a = arrow.resize((round(arrow.width * s), round(arrow.height * s)), Image.LANCZOS)
note = Image.new("RGBA", (side, side), (255, 255, 255, 0))
white = Image.new("RGBA", a.size, (255, 255, 255, 255))
white.putalpha(a)
note.alpha_composite(white, ((side - a.width) // 2, (side - a.height) // 2))
note.save("assets/notification-icon.png", optimize=True)

# Full logo: the artwork's tile + wordmark with an even margin of its own background.
margin = 80
x0, y0, x1, y1 = WORDMARK_BOX
src.crop((x0 - margin, y0 - margin, x1 + margin, y1 + margin)).save(
    "assets/brand/logo-full.png", optimize=True
)

print("tile", tile.size, "arrow", arrow.size)
