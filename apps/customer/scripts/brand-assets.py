#!/usr/bin/env python3
"""Make one brand's store artwork from a single logo.

    python3 scripts/brand-assets.py <slug> <logo.png> [--bg "#FFFFFF"] [--initial B]

Writes brands/<slug>/icon.png, adaptive-icon.png, splash.png and
notification-icon.png. Needs Pillow (pip install pillow).

The App Store rejects an icon with an alpha channel, so icon.png is flattened
onto --bg. Android's notification icon is drawn by the OS as a white
silhouette of the alpha channel, so a full-colour logo would show as a solid
square: it gets the brand's initial instead.
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def hex_rgb(value: str):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def fit(logo: Image.Image, size: int, scale: float) -> Image.Image:
    """Logo scaled to `scale` of a size×size transparent square, centred."""
    box = int(size * scale)
    copy = logo.copy()
    copy.thumbnail((box, box), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(copy, ((size - copy.width) // 2, (size - copy.height) // 2), copy)
    return out


def bold_font(px: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    return ImageFont.load_default(size=px)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("logo")
    ap.add_argument("--bg", default="#FFFFFF")
    ap.add_argument("--initial", default=None)
    args = ap.parse_args()

    out_dir = os.path.join(HERE, "..", "brands", args.slug)
    os.makedirs(out_dir, exist_ok=True)
    logo = Image.open(args.logo).convert("RGBA")
    bg = hex_rgb(args.bg)

    icon = Image.new("RGB", (1024, 1024), bg)
    icon.paste(fit(logo, 1024, 0.9), (0, 0), fit(logo, 1024, 0.9))
    icon.save(os.path.join(out_dir, "icon.png"))

    # Android masks the adaptive foreground to a circle/squircle that keeps
    # only the middle ~66%, so the logo has to sit well inside it.
    fit(logo, 1024, 0.62).save(os.path.join(out_dir, "adaptive-icon.png"))
    fit(logo, 1024, 1.0).save(os.path.join(out_dir, "splash.png"))

    initial = (args.initial or args.slug[:1]).upper()
    note = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(note)
    draw.ellipse((4, 4, 92, 92), outline=(255, 255, 255, 255), width=7)
    font = bold_font(54)
    l, t, r, b = draw.textbbox((0, 0), initial, font=font)
    draw.text(((96 - (r - l)) / 2 - l, (96 - (b - t)) / 2 - t), initial, font=font, fill=(255, 255, 255, 255))
    note.save(os.path.join(out_dir, "notification-icon.png"))

    print(f"wrote {os.path.normpath(out_dir)}/{{icon,adaptive-icon,splash,notification-icon}}.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
