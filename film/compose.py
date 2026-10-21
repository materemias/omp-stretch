# /// script
# dependencies = ["pillow"]
# ///
"""Turns a take (film/take.ts) into docs/stretch.mp4 and docs/stretch.gif: each frame is the
window's chat area, framed on a cream page under the caption of the moment, with the pointer drawn
in, since window shots carry none.

    uv run film/compose.py [WORK]   (default /tmp/omp-film)
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/omp-film")
DOCS = Path(__file__).resolve().parent.parent / "docs"
FPS = 20
PAGE = (960, 540)
CREAM = (244, 239, 227)
INK = (43, 42, 39)
ACCENT = (64, 156, 255)
CAPTION_BAND = 66
FADE_MS = 220


def font_file(pattern: str) -> str:
    return subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True, check=True).stdout


timeline = json.loads((WORK / "timeline.json").read_text())
# The crop leaves out Tern's title bar (tabs, account picture) and its bottom bar.
frames, events, crop = timeline["frames"], timeline["events"], timeline["crop"]
crop_w, crop_h = crop[2] - crop[0], crop[3] - crop[1]
scale = min((PAGE[0] - 80) / crop_w, (PAGE[1] - CAPTION_BAND - 14) / crop_h)
shown = (round(crop_w * scale), round(crop_h * scale))
origin = ((PAGE[0] - shown[0]) // 2, CAPTION_BAND)
caption_font = ImageFont.truetype(font_file("Noto Sans:bold"), 21)

mask = Image.new("L", shown, 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, shown[0] - 1, shown[1] - 1), radius=10, fill=255)
page = Image.new("RGB", PAGE, CREAM)
shadow = Image.new("L", PAGE, 0)
ImageDraw.Draw(shadow).rounded_rectangle(
    (origin[0], origin[1] + 6, origin[0] + shown[0], origin[1] + shown[1] + 6), radius=12, fill=90
)
page.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(9)))

# A classic arrow pointer, tip at (0, 0), in page pixels.
ARROW = [(0, 0), (0, 17), (4, 13), (7, 20), (10, 19), (7, 12), (12, 12)]


def latest(items: list[dict], t: float, kind: str | None = None) -> dict | None:
    found = None
    for item in items:
        if item["t"] > t:
            break
        if kind is None or item["kind"] == kind:
            found = item
    return found


def to_page(x: float, y: float) -> tuple[float, float]:
    return origin[0] + (x - crop[0]) * scale, origin[1] + (y - crop[1]) * scale


out = WORK / "composed"
shutil.rmtree(out, ignore_errors=True)
out.mkdir()
start, end = frames[0]["t"], frames[-1]["t"]
count = int((end - start) / 1000 * FPS) + 1
for n in range(count):
    t = start + n * 1000 / FPS
    image = page.copy()
    shot = Image.open(latest(frames, t)["file"]).convert("RGB").crop(crop).resize(shown, Image.LANCZOS)
    image.paste(shot, origin, mask)
    draw = ImageDraw.Draw(image, "RGBA")

    caption = latest(events, t, "caption")
    if caption and caption["text"]:
        alpha = round(255 * min(1, (t - caption["t"]) / FADE_MS))
        draw.text((PAGE[0] / 2, CAPTION_BAND / 2 + 1), caption["text"], font=caption_font, fill=(*INK, alpha), anchor="mm")

    click = latest(events, t, "click")
    move = latest(events, t, "move")
    if move:
        px, py = to_page(move["x"], move["y"])
        if click and t - click["t"] < 380:
            k = (t - click["t"]) / 380
            r = 5 + 13 * k
            draw.ellipse((px - r, py - r, px + r, py + r), outline=(*ACCENT, round(230 * (1 - k))), width=3)
        draw.polygon([(px + x, py + y) for x, y in ARROW], fill=(255, 255, 255, 255), outline=(20, 20, 20, 255))
    image.save(out / f"{n:05d}.png")

DOCS.mkdir(exist_ok=True)
frames_in = ["-framerate", str(FPS), "-i", str(out / "%05d.png")]
ffmpeg = ["ffmpeg", "-loglevel", "error", "-y"]
subprocess.run(
    [*ffmpeg, *frames_in, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", str(DOCS / "stretch.mp4")],
    check=True,
)
subprocess.run(
    [
        *ffmpeg,
        *frames_in,
        "-filter_complex",
        "[0]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
        str(DOCS / "stretch.gif"),
    ],
    check=True,
)
print(f"{count} frames, {count / FPS:.1f} s -> {DOCS / 'stretch.gif'}, {DOCS / 'stretch.mp4'}")
