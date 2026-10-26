#!/usr/bin/env python3
"""Import one explicitly mapped grid into an isolated Cocos resources directory."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re
import uuid

from PIL import Image, ImageDraw

PROJECT = Path(__file__).resolve().parents[1]
RESOURCES = PROJECT / "assets/resources"


def read_grid(image, cols, rows, cell, origin, colors, field, tolerance):
    if cell <= 0 or origin[0] < 0 or origin[1] < 0:
        raise ValueError("source cell and origin must define a positive grid")
    if origin[0] + cols * cell > image.width or origin[1] + rows * cell > image.height:
        raise ValueError("source grid extends beyond the image")
    values = []
    for row in range(rows):
        for col in range(cols):
            x = int(origin[0] + (col + 0.5) * cell)
            y = int(origin[1] + (row + 0.5) * cell)
            pixel = image.getpixel((x, y))
            if pixel[3] < 16:
                values.append(-1)
                continue
            matches = [entry["id"] for entry in colors
                       if sum((pixel[i] - entry[field][i]) ** 2 for i in range(3)) <= tolerance ** 2]
            if len(matches) != 1:
                raise ValueError(f"{field} cell ({col}, {row}): RGB {pixel[:3]} has {len(matches)} matches")
            values.append(matches[0])
    return values


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def ensure_meta(path, importer):
    meta = path.with_name(path.name + ".meta")
    if meta.exists():
        return
    relative = path.relative_to(RESOURCES).as_posix()
    write_json(meta, {
        "ver": "2.0.1" if importer == "json" else "1.0.27",
        "importer": importer, "imported": False,
        "uuid": str(uuid.uuid5(uuid.NAMESPACE_URL, "jewel-coloring/resources/" + relative)),
        "files": [], "subMetas": {},
        "userData": {"type": "sprite-frame"} if importer == "image" else {},
    })


def build(config_path, output, overlay=None):
    config_path, output = Path(config_path).resolve(), Path(output).resolve()
    relative = output.relative_to(RESOURCES)
    if len(relative.parts) < 2 or relative.parts[0] in {"art", "audio", "data"}:
        raise ValueError("output must be a dedicated level directory under assets/resources")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(config["id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", config["id"]):
        raise ValueError("level ID must be a stable catalog identifier")
    grid, layout = config["grid"], config["layout"]
    cols, rows, cell = grid["cols"], grid["rows"], grid["sourceCell"]
    tray_cols, tray_rows = config["trayCols"], config["trayRows"]
    if not all(type(n) is int and n > 0 for n in (cols, rows, cell, tray_cols, tray_rows)):
        raise ValueError("grid and tray dimensions must be positive integers")
    colors = config["colors"]
    ids = [entry["id"] for entry in colors]
    if len(set(ids)) != len(ids) or any(type(i) is not int or i < 0 for i in ids):
        raise ValueError("color IDs must be unique nonnegative integers")
    for entry in colors:
        for key in ("targetRGB", "initialRGB"):
            rgb = entry[key]
            if len(rgb) != 3 or any(type(c) is not int or not 0 <= c <= 255 for c in rgb):
                raise ValueError(f"invalid {key}")
    palette_path = (RESOURCES / (config.get("palette", "data/palette") + ".json")).resolve()
    palette_path.relative_to(RESOURCES)
    palette = json.loads(palette_path.read_text(encoding="utf-8"))
    if any(i >= len(palette) or palette[i]["id"] != i for i in ids):
        raise ValueError("color IDs must match the selected palette")
    origin = grid.get("origin", [0, 0])
    tolerance = config.get("tolerance", 12)
    if not isinstance(tolerance, (int, float)) or not 0 <= tolerance <= 64:
        raise ValueError("tolerance must be between 0 and 64")
    image = lambda key: Image.open(config_path.parent / config[key]).convert("RGBA")
    target, initial, base = image("target"), image("initial"), image("base")
    tray_image = image("tray") if config.get("tray") else None
    targets = read_grid(target, cols, rows, cell, origin, colors, "targetRGB", tolerance)
    gems = read_grid(initial, cols, rows, cell, origin, colors, "initialRGB", tolerance)
    if Counter(targets) != Counter(gems) or any((a < 0) != (b < 0) for a, b in zip(targets, gems)):
        raise ValueError("target/initial shapes or color populations differ")
    if not any(color >= 0 for color in targets) or targets == gems:
        raise ValueError("a playable level needs at least one misplaced gem")
    if base.width * rows != base.height * cols or base.width % cols:
        raise ValueError("base image must preserve the complete grid bounds")
    if read_grid(base, cols, rows, base.width // cols, [0, 0], colors, "targetRGB", tolerance) != targets:
        raise ValueError("base image colors do not match target cells")
    if layout["width"] != 1080 or layout["height"] != 1920 or layout["cell"] <= 0:
        raise ValueError("layout must use a 1080 x 1920 design area")
    board, tray, slot = layout["board"], layout["tray"], layout["slot"]
    numbers = [layout["cell"], *board.values(), *tray.values(), *slot.values()]
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in numbers):
        raise ValueError("layout values must be finite numbers")
    if board["width"] != cols * layout["cell"] or board["height"] != rows * layout["cell"]:
        raise ValueError("layout board must match the grid")
    for rect in (board, tray):
        if min(rect["x"], rect["y"]) < 0 or min(rect["width"], rect["height"]) <= 0 \
                or rect["x"] + rect["width"] > 1080 or rect["y"] + rect["height"] > 1920:
            raise ValueError("layout rectangle extends beyond the design area")
    if board["x"] < tray["x"] + tray["width"] and board["x"] + board["width"] > tray["x"] \
            and board["y"] < tray["y"] + tray["height"] and board["y"] + board["height"] > tray["y"]:
        raise ValueError("board and tray must not overlap")
    margin = max(layout["cell"] / 2, slot["radius"])
    if slot["radius"] <= 0 or min(slot["stepX"], slot["stepY"]) < 2 * margin or min(slot["x"], slot["y"]) < margin \
            or slot["x"] + (tray_cols - 1) * slot["stepX"] + margin > tray["width"] \
            or slot["y"] + (tray_rows - 1) * slot["stepY"] + margin > tray["height"]:
        raise ValueError("tray slots do not fit")
    if tray_image and abs(tray_image.width / tray_image.height - tray["width"] / tray["height"]) > 0.001:
        raise ValueError("tray image aspect ratio must match layout")
    level = {"schemaVersion": 1, "id": config["id"], "cols": cols, "rows": rows,
             "trayCols": tray_cols, "trayRows": tray_rows, "targets": targets,
             "gems": [{"id": i, "color": color, "cell": index} for i, (index, color) in
                      enumerate((index, color) for index, color in enumerate(gems) if color >= 0)]}
    preview = base.copy()
    drawing = ImageDraw.Draw(preview)
    step = base.width // cols
    for index, color in enumerate(targets):
        if color < 0:
            continue
        x, y = (index % cols) * step, (index // cols) * step
        drawing.rectangle((x, y, x + step - 1, y + step - 1), outline=(255, 0, 160, 255))
        drawing.text((x + 2, y + 2), str(color), fill=(255, 255, 255, 255), stroke_width=1, stroke_fill=(0, 0, 0))
    # Validate everything before replacing this level's three generated files.
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "level.json", level)
    write_json(output / "layout.json", layout)
    base.save(output / "base.png")
    for name, importer in [("level.json", "json"), ("layout.json", "json"), ("base.png", "image")]:
        ensure_meta(output / name, importer)
    if tray_image:
        tray_image.save(output / "tray.png")
        ensure_meta(output / "tray.png", "image")
    overlay = Path(overlay) if overlay else PROJECT / "temp/level-previews" / (config["id"] + ".png")
    overlay.parent.mkdir(parents=True, exist_ok=True)
    preview.save(overlay)
    return level


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--overlay", type=Path)
    args = parser.parse_args()
    result = build(args.config, args.output, args.overlay)
    print(f"Built {result['id']}: {result['cols']}x{result['rows']}, {len(result['gems'])} gems")
