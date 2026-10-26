#!/usr/bin/env python3
"""Stage isolated synthetic levels for debug validation; --clean removes only these fixtures."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets/resources/level-tests"
spec = importlib.util.spec_from_file_location("level_builder", ROOT / "tools/build-level.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def prepare():
    fixtures = json.loads((ROOT / "tests/fixtures/levels.json").read_text())
    palette = json.loads((ROOT / "assets/resources/data/palette.json").read_text())
    catalog = {"schemaVersion": 1, "testOnly": True,
               "defaults": {"layout": "data/layout", "palette": "data/palette", "tray": "art/tray"},
               "levels": []}
    for fixture in fixtures:
        name = fixture["id"]
        cols, rows, cell = (fixture[key] for key in ("cols", "rows", "cell"))
        source = ROOT / "temp/level-test-sources" / name
        source.mkdir(parents=True, exist_ok=True)
        for key in ("targets", "initial"):
            image = Image.new("RGBA", (cols * cell, rows * cell))
            draw = ImageDraw.Draw(image)
            for index, color in enumerate(fixture[key]):
                if color < 0:
                    continue
                x, y = (index % cols) * cell, (index // cols) * cell
                rgb = palette[color]["baseRGB" if key == "targets" else "gemRGB"]
                draw.ellipse((x + 3, y + 3, x + cell - 3, y + cell - 3), fill=tuple(rgb) + (255,))
            image.save(source / (key + ".png"))
        step, margin = cell + 16, cell // 2 + 12
        tw = margin * 2 + (fixture["trayCols"] - 1) * step
        th = margin * 2 + (fixture["trayRows"] - 1) * step
        layout = {"width": 1080, "height": 1920, "cell": cell,
                  "board": {"x": (1080 - cols * cell) / 2, "y": 500, "width": cols * cell, "height": rows * cell},
                  "tray": {"x": (1080 - tw) / 2, "y": 1376, "width": tw, "height": th},
                  "slot": {"x": margin, "y": margin, "stepX": step, "stepY": step, "radius": cell / 2}}
        config = {"id": name, "grid": {"cols": cols, "rows": rows, "sourceCell": cell},
                  "trayCols": fixture["trayCols"], "trayRows": fixture["trayRows"],
                  "target": "targets.png", "base": "targets.png", "initial": "initial.png",
                  "layout": layout, "colors": [{"id": color, "targetRGB": palette[color]["baseRGB"],
                  "initialRGB": palette[color]["gemRGB"]} for color in sorted(set(fixture["targets"])) if color >= 0]}
        builder.write_json(source / "import.json", config)
        target = OUTPUT / name
        builder.build(source / "import.json", target)
        original_meta = (target / "base.png.meta").read_text()
        builder.build(source / "import.json", target)
        assert (target / "base.png.meta").read_text() == original_meta, "meta must survive reimport"
        original_level = (target / "level.json").read_bytes()
        bad_image = Image.open(source / "initial.png").convert("RGBA")
        bad_image.putpixel((cell // 2, cell // 2), (255, 0, 255, 255))
        bad_image.save(source / "unmapped.png")
        builder.write_json(source / "bad-import.json", {**config, "initial": "unmapped.png"})
        try:
            builder.build(source / "bad-import.json", target)
        except ValueError as error:
            assert "0 matches" in str(error)
        else:
            raise AssertionError("unmapped pixels must be rejected")
        assert (target / "level.json").read_bytes() == original_level, "bad inputs must not replace a valid level"
        image = Image.new("RGBA", (tw, th), (252, 247, 236, 255))
        draw = ImageDraw.Draw(image)
        for row in range(fixture["trayRows"]):
            for col in range(fixture["trayCols"]):
                x, y, r = margin + col * step, margin + row * step, cell / 2
                draw.ellipse((x-r, y-r, x+r, y+r), fill=(235, 225, 208, 255), outline=(200, 180, 150, 255), width=2)
        image.save(target / "tray.png")
        builder.ensure_meta(target / "tray.png", "image")
        catalog["levels"].append({"id": name, "revision": 1, "data": f"level-tests/{name}/level",
                                  "base": f"level-tests/{name}/base", "layout": f"level-tests/{name}/layout",
                                  "tray": f"level-tests/{name}/tray"})
    builder.write_json(OUTPUT / "catalog.json", catalog)
    builder.ensure_meta(OUTPUT / "catalog.json", "json")
    assert (OUTPUT / fixtures[0]["id"] / "base.png.meta").read_text() != \
           (OUTPUT / fixtures[1]["id"] / "base.png.meta").read_text()
    print("Staged two isolated synthetic levels; equal color populations retain explicit IDs.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()
    if args.clean:
        if OUTPUT.exists():
            assert json.loads((OUTPUT / "catalog.json").read_text()).get("testOnly") is True
            shutil.rmtree(OUTPUT)
        OUTPUT.with_name(OUTPUT.name + ".meta").unlink(missing_ok=True)
        print("Removed staged level-test resources.")
    else:
        prepare()
