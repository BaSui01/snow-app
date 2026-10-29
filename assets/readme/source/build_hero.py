#!/usr/bin/env python3
"""Build the README hero boards (hybrid: SVG layout + the real app icon).

The pixel wordmark mirrors the pixel "SNOW APP" mark shown on the app's welcome
screen; the icon is the real resources/icon@2x.png shipped with the app.
The layout SVG is a build intermediate and is written to the temp directory;
only the rendered PNG is published (raster inside SVG is not reliable on GitHub).

Usage: python build_hero.py [zh|en]
"""

import base64
import json
import os
import subprocess
import sys
import tempfile

from theme import ASSETS, BRAND, FAINT, INK, LINE, MONO, PAPER, ROOT, SANS, TEXT_2

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

GLYPHS = {
    "S": ["01110", "10000", "10000", "01110", "00001", "00001", "11110"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    " ": ["00000"] * 7,
}

COPY = {
    "zh": {
        "eyebrow": "桌面 AI 开发工作区",
        "pitch": "把 AI 对话、终端、SSH、Git 与内置浏览器装进同一个工作区",
        "meta": ["macOS / Windows / Linux", "MIT License"],
        "title": "Snow App：桌面 AI 开发工作区",
        "desc": "Snow App 的像素标识、一句话定位与平台信息。",
    },
    "en": {
        "eyebrow": "DESKTOP AI WORKSPACE",
        "pitch": "AI chat, terminal, SSH, Git and a built-in browser in one workspace",
        "meta": ["macOS / Windows / Linux", "MIT License"],
        "title": "Snow App: desktop AI development workspace",
        "desc": "Snow App pixel wordmark, one-line positioning and platform metadata.",
    },
}

CELL = 10


def wordmark(text, x, y, cell=CELL, fill=INK):
    """Return SVG rects for a 5x7 pixel wordmark starting at (x, y)."""
    out = []
    cursor = x
    for ch in text:
        for r, row in enumerate(GLYPHS[ch]):
            run_start = None
            for c, bit in enumerate(row + "0"):
                if bit == "1" and run_start is None:
                    run_start = c
                elif bit == "0" and run_start is not None:
                    out.append(
                        f'<rect x="{cursor + run_start * cell}" y="{y + r * cell}" '
                        f'width="{(c - run_start) * cell}" height="{cell}" fill="{fill}"/>'
                    )
                    run_start = None
        cursor += 6 * cell  # 5 cells glyph + 1 cell gap
    return "".join(out)


def app_version():
    """Read the version straight from package.json so the banner cannot drift from the release."""
    with open(os.path.join(ROOT, "package.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)["version"]


def build_hero_svg(lang, icon_b64, version):
    c = COPY[lang]
    marks = wordmark("SNOW APP", 56, 122)
    meta_line = " · ".join([f"v{version}"] + c["meta"])
    eyebrow_face = MONO if lang == "en" else SANS
    eyebrow_spacing = "3" if lang == "en" else "1.2"
    eyebrow_size = 18 if lang == "en" else 19
    return f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="1200" height="340" viewBox="0 0 1200 340" role="img" aria-labelledby="t d">
  <title id="t">{c["title"]}</title>
  <desc id="d">{c["desc"]}</desc>
  <rect width="1200" height="340" rx="18" fill="{PAPER}"/>
  <rect x="0.5" y="0.5" width="1199" height="339" rx="18" fill="none" stroke="{LINE}"/>

  <image x="56" y="46" width="46" height="46" xlink:href="data:image/png;base64,{icon_b64}"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="120" y="76" font-family="{eyebrow_face}" font-size="{eyebrow_size}"
        letter-spacing="{eyebrow_spacing}" fill="{FAINT}">{c["eyebrow"]}</text>
  <rect x="120" y="88" width="72" height="3" rx="1.5" fill="{BRAND}"/>

  <g id="wordmark" shape-rendering="crispEdges">{marks}</g>

  <text x="56" y="252" font-family="{SANS}" font-size="22" fill="{TEXT_2}">{c["pitch"]}</text>
  <text x="56" y="298" font-family="{MONO}" font-size="17" letter-spacing="1.2"
        fill="{FAINT}">{meta_line}</text>

  <image x="930" y="60" width="220" height="220" xlink:href="data:image/png;base64,{icon_b64}"
         preserveAspectRatio="xMidYMid meet"/>
</svg>
'''


def render(svg_path, png_path, width, height):
    """Rasterise an SVG (or HTML) file with headless Chrome at 2x.

    Each call gets a private profile directory: sharing one profile between
    back-to-back headless runs makes Chrome intermittently emit a partially
    painted screenshot, which silently corrupts the published asset.
    """
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    profile = tempfile.mkdtemp(prefix="snow-readme-chrome-")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--default-background-color=00000000", "--force-device-scale-factor=2",
        f"--user-data-dir={profile}", f"--window-size={width},{height}",
        f"--screenshot={png_path}", "file:///" + svg_path.replace("\\", "/"),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if not os.path.exists(png_path):
        raise SystemExit(f"render failed ({res.returncode})\n{res.stdout[-2000:]}")
    print("rendered", os.path.relpath(png_path, ASSETS))


def main():
    langs = sys.argv[1:] or ["zh", "en"]
    icon_path = os.path.normpath(os.path.join(ASSETS, "..", "..", "resources", "icon@2x.png"))
    with open(icon_path, "rb") as fh:
        icon_b64 = base64.b64encode(fh.read()).decode("ascii")
    tmp = tempfile.mkdtemp(prefix="snow-readme-hero-")
    version = app_version()
    print("hero version", version)
    for lang in langs:
        layout = os.path.join(tmp, f"hero-layout.{lang}.svg")
        with open(layout, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(build_hero_svg(lang, icon_b64, version))
        render(layout, os.path.join(ASSETS, lang, "hero.png"), 1200, 340)


if __name__ == "__main__":
    main()
