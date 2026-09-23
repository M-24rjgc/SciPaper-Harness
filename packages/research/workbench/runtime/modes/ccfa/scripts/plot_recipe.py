#!/usr/bin/env python3
"""Draw one CCFA plot recipe as an editable SVG.

    python -I plot_recipe.py --list
    python -I plot_recipe.py <recipe> --spec <arguments.json> --out <figure.svg> [--palette NAME] [--width W --height H]

The recipes are the upstream ccf-visual-composer ones (../upstream/ccf-visual-
composer/resources/python/ccfa_plot_recipes.py), imported unchanged. The spec
file holds the recipe's keyword arguments as JSON — the rows, matrix or series
from real results, the keys to read and the title — so the numbers come from a
file a script wrote, never from the command line. Prints one JSON line: the
recipe, the SVG path and the palette. Standard library only.
"""
from __future__ import annotations

import argparse
import inspect
import json
import runpy
import sys
from pathlib import Path

RECIPES = Path(__file__).resolve().parent.parent / "upstream" / "ccf-visual-composer" / "resources" / "python" / "ccfa_plot_recipes.py"


def main(argv):
    module = runpy.run_path(str(RECIPES))
    catalog = module["recipe_catalog"]()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("recipe", nargs="?", help="one of: " + ", ".join(catalog))
    parser.add_argument("--list", action="store_true", help="print each recipe with its arguments")
    parser.add_argument("--spec", help="JSON file of the recipe's keyword arguments")
    parser.add_argument("--out", help="the SVG to write")
    parser.add_argument("--palette", help="a named palette: " + ", ".join(module["PALETTES"]))
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    args = parser.parse_args(argv)
    if args.list:
        listing = {name: {"use": use, "arguments": str(inspect.signature(module[name]))} for name, use in catalog.items()}
        print(json.dumps({"recipes": listing, "palettes": list(module["PALETTES"])}, ensure_ascii=False))
        return 0
    if args.recipe not in catalog or not args.spec or not args.out:
        parser.error("give a recipe, --spec and --out (or --list)")
    if not args.out.lower().endswith(".svg"):
        parser.error("--out must be an .svg file")
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8-sig"))
    if not isinstance(spec, dict):
        parser.error("the spec must be a JSON object of keyword arguments")
    recipe = module[args.recipe]
    accepted = inspect.signature(recipe).parameters
    unknown = sorted(set(spec) - set(accepted) - {"palette", "theme"})
    if unknown:
        parser.error(f"{args.recipe} takes no argument(s) {', '.join(unknown)}; it takes {', '.join(accepted)}")
    palette = args.palette or (spec["palette"] if isinstance(spec.get("palette"), str) else None)
    if palette is not None:
        if palette not in module["PALETTES"]:
            parser.error(f"unknown palette {palette}")
        spec["palette"] = module["PALETTES"][palette]
    spec.pop("theme", None)
    if args.width or args.height:
        theme = module["Theme"]()
        spec["theme"] = module["Theme"](width=args.width or theme.width, height=args.height or theme.height)
    path = module["save_svg"](recipe(**spec), args.out)
    print(json.dumps({"recipe": args.recipe, "svg": str(path), "palette": palette}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
