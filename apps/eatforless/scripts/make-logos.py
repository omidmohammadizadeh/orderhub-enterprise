"""Draws every Eat For Less logo file from one definition: the wordmark on
the app's welcome screen — "eat for" in white, "less" in ink on a lime tag.

    python3 scripts/make-logos.py

Writes the app icons into assets/ and the brand kit (store icon, Stripe,
web) into assets/brand/. Re-run after changing the colours or the font.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "node_modules/@expo-google-fonts/inter-tight/800ExtraBold/InterTight_800ExtraBold.ttf"
INK = (11, 11, 11, 255)
LIME = (212, 255, 63, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def font(px):
    return ImageFont.truetype(str(FONT), px)


def text_box(draw, txt, f):
    l, t, r, b = draw.textbbox((0, 0), txt, font=f)
    return l, t, r - l, b - t


def tag(draw, x, y, txt, f, fill_box, fill_text, pad, radius):
    """`txt` on a rounded tag whose top-left is (x, y). Returns its width."""
    l, t, w, h = text_box(draw, txt, f)
    cap = text_box(draw, "l", f)[3]  # tag hugs letter height, not descenders
    draw.rounded_rectangle([x, y, x + w + pad * 2, y + cap + pad * 2], radius=radius, fill=fill_box)
    draw.text((x + pad - l, y + pad - t), txt, font=f, fill=fill_text)
    return w + pad * 2, cap + pad * 2


def stacked(size, bg, word, box, box_text, scale=1.0):
    """Square logo: "eat" / "for" / [less], centred. `scale` shrinks the
    block for icons whose edges get masked (Android adaptive icons)."""
    img = Image.new("RGBA", (size, size), bg)
    d = ImageDraw.Draw(img)
    px = int(size * 0.27 * scale)
    f = font(px)
    cap = text_box(d, "l", f)[3]
    pad = int(px * 0.10)
    gap = int(px * 0.06)
    widths = [text_box(d, s, f)[2] for s in ("eat", "for")] + [text_box(d, "less", f)[2] + pad * 2]
    block_w = max(widths)
    block_h = cap * 2 + (cap + pad * 2) + gap * 2
    x0 = (size - block_w) // 2
    y = (size - block_h) // 2
    for s in ("eat", "for"):
        l, t, _, _ = text_box(d, s, f)
        d.text((x0 - l, y - t), s, font=f, fill=word)
        y += cap + gap
    tag(d, x0 - pad, y, "less", f, box, box_text, pad, int(px * 0.16))
    return img


def wide(height, word, box, box_text, bg=CLEAR, margin=0.0):
    """One line: "eat for [less]", as on the welcome screen."""
    px = int(height * 0.62)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    f = font(px)
    cap = text_box(probe, "l", f)[3]
    pad = int(px * 0.10)
    head_l, head_t, head_w, _ = text_box(probe, "eat for ", f)
    less_w = text_box(probe, "less", f)[2] + pad * 2
    m = int(height * margin)
    w = head_w + less_w + m * 2
    h = cap + pad * 2 + m * 2
    img = Image.new("RGBA", (w, h), bg)
    d = ImageDraw.Draw(img)
    d.text((m - head_l, m + pad - head_t), "eat for ", font=f, fill=word)
    tag(d, m + head_w, m, "less", f, box, box_text, pad, int(px * 0.16))
    return img


def silhouette(img):
    """Android notification icons are white-on-transparent: keep shape only."""
    alpha = img.getchannel("A")
    out = Image.new("RGBA", img.size, WHITE)
    out.putalpha(alpha)
    return out


def main():
    assets = ROOT / "assets"
    brand = assets / "brand"
    brand.mkdir(exist_ok=True)

    icon = stacked(1024, INK, WHITE, LIME, INK)
    icon.convert("RGB").save(assets / "icon.png")
    # Adaptive icon: the launcher crops to a circle/squircle, so the block
    # sits inside the 66% safe zone; the black comes from app.json.
    stacked(1024, CLEAR, WHITE, LIME, INK, scale=0.66).save(assets / "adaptive-icon.png")
    # Splash: one line, on the black splash background.
    wide(140, WHITE, LIME, INK).save(assets / "splash-icon.png")
    # Notification small icon: "less" knocked out of a white tag.
    note = stacked(96, CLEAR, WHITE, WHITE, CLEAR, scale=0.95)
    silhouette(note).save(assets / "notification-icon.png")

    icon.convert("RGB").resize((512, 512), Image.LANCZOS).save(brand / "play-store-icon-512.png")
    icon.convert("RGB").save(brand / "icon-1024.png")
    # On white (Stripe checkout, emails): black words, lime tag.
    wide(200, INK, LIME, INK, bg=WHITE, margin=0.25).convert("RGB").save(brand / "logo-on-white.png")
    wide(200, WHITE, LIME, INK, bg=INK, margin=0.25).convert("RGB").save(brand / "logo-on-black.png")


if __name__ == "__main__":
    main()
