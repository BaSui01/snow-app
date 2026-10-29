#!/usr/bin/env python3
"""Shared palette, typography and helpers for the Snow App README assets.

The colours and font stacks are taken from the app's own design tokens
(src/renderer/themes/tokens.css, light theme) and from resources/icon.png,
so the generated assets keep the product's visual language.
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))  # repository root
ICONS = os.path.join(HERE, "icons")
ASSETS = os.path.join(ROOT, "assets", "readme")

# --- frozen visual system -------------------------------------------------
INK = "#0B1220"
PAPER = "#FFFFFF"
SURFACE = "#F5F7F9"
SURFACE_2 = "#F3F4F6"
LINE = "#E5E7EB"
TEXT_2 = "#374151"
MUTED = "#6B7280"
FAINT = "#9CA3AF"
BRAND = "#73AFD1"       # snow blue, sampled from resources/icon.png
BRAND_DEEP = "#3B82F6"  # tokens.css --accent-blue (light theme)

SANS = (
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', "
    "'Microsoft YaHei', sans-serif"
)
MONO = "'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace"

_cache = {}


def gl_icon_body(name):
    """Return the inner elements of a Lucide icon (ISC licensed) at 24x24."""
    if name in _cache:
        return _cache[name]
    with open(os.path.join(ICONS, name + ".svg"), "r", encoding="utf-8") as fh:
        raw = fh.read()
    raw = re.sub(r"<!--.*?-->", "", raw, flags=re.S).strip()
    inner = raw.split(">", 1)[1].rsplit("</svg>", 1)[0]
    inner = re.sub(r"\s+", " ", inner).strip()
    _cache[name] = inner
    return inner


def icon(name, x, y, size=28, color=INK, sw=1.9):
    """Inline a Lucide icon as a reusable 24x24 viewBox group."""
    s = size / 24.0
    return (
        f'<g transform="translate({x} {y}) scale({s:.4f})" fill="none" stroke="{color}" '
        f'stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">'
        f"{gl_icon_body(name)}</g>"
    )


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def svg_open(w, h, title, desc):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" role="img" aria-labelledby="t d">\n'
        f'  <title id="t">{esc(title)}</title>\n'
        f'  <desc id="d">{esc(desc)}</desc>\n'
    )


def write_svg(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    print("wrote", os.path.relpath(path, ROOT), len(content), "bytes")
