#!/usr/bin/env python3
"""Export an SVG figure to a vector PDF with live text, and render PNG previews of it.

    python export_figure.py <figure.svg> <out.pdf> <preview-dir> [width ...]

The PDF comes from svglib and reportlab. svglib draws no <marker>, so every marker reference
(arrowheads) is first expanded into ordinary shapes placed and turned at the path's ends, the
way a browser paints it. Times New Roman, the font stack the figure skills require, is embedded
from the system fonts when they are there; otherwise the standard Times face is used without
embedding. Either way the labels stay text, not outlines. The previews are the PDF's page
rendered by pdfium at each width (1440 and 480 pixels unless given): the full view and the view
at column width, where small type fails first.

Prints one JSON line: {"pdf", "previews", "fonts", "embedded", "text", "images", "markers"}.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

SVG = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"
TIMES_FILES = {("normal", "normal"): "times.ttf", ("bold", "normal"): "timesbd.ttf",
               ("normal", "italic"): "timesi.ttf", ("bold", "italic"): "timesbi.ttf"}
NUMBER = r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def register_times() -> bool:
    """Register the system's Times New Roman faces with svglib; true when any was found."""
    from svglib.fonts import register_font
    folder = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    found = False
    for (weight, style), name in TIMES_FILES.items():
        path = folder / name
        if path.is_file():
            register_font("Times New Roman", str(path), weight=weight, style=style)
            found = True
    return found


def number(value, default=0.0):
    match = re.match(rf"\s*({NUMBER})", str(value or ""))
    return float(match.group(1)) if match else default


def style_of(element) -> dict:
    out = {}
    for part in (element.get("style") or "").split(";"):
        if ":" in part:
            key, value = part.split(":", 1)
            out[key.strip()] = value.strip()
    return out


def path_vertices(d: str) -> list[tuple[tuple[float, float], float, float]]:
    """(point, incoming angle, outgoing angle) for each vertex of a path, in degrees."""
    tokens = re.findall(rf"[MmLlHhVvCcSsQqTtAaZz]|{NUMBER}", d or "")
    counts = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}
    vertices = []   # (point, control before it, control after it's start)
    x = y = sx = sy = 0.0
    i, command = 0, None
    while i < len(tokens):
        if re.match(r"[A-Za-z]", tokens[i]):
            command = tokens[i]
            i += 1
            if command in "Zz":
                vertices.append(((sx, sy), (x, y), None))
                x, y = sx, sy
            continue
        if command is None:
            break
        upper, relative = command.upper(), command.islower()
        args = [float(t) for t in tokens[i:i + counts[upper]]]
        if len(args) < counts[upper]:
            break
        i += counts[upper]
        ox, oy = (x, y) if relative else (0.0, 0.0)
        if upper == "M":
            x, y = ox + args[0], oy + args[1]
            sx, sy = x, y
            vertices.append(((x, y), None, None))
            command = "l" if relative else "L"
            continue
        start = (x, y)
        if upper == "H":
            x = ox + args[0]
            before = start
        elif upper == "V":
            y = oy + args[0]
            before = start
        elif upper in ("L", "T"):
            x, y = ox + args[0], oy + args[1]
            before = start
        elif upper == "C":
            first, before = (ox + args[0], oy + args[1]), (ox + args[2], oy + args[3])
            x, y = ox + args[4], oy + args[5]
            vertices[-1] = (vertices[-1][0], vertices[-1][1], first)
        elif upper in ("S", "Q"):
            before = (ox + args[0], oy + args[1])
            x, y = ox + args[2], oy + args[3]
            vertices[-1] = (vertices[-1][0], vertices[-1][1], before if upper == "Q" else None)
        else:   # A: the chord stands in for the tangent
            x, y = ox + args[5], oy + args[6]
            before = start
        vertices.append(((x, y), before, None))

    def angle(a, b):
        return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) if a and b and a != b else None

    out = []
    for index, (point, before, after) in enumerate(vertices):
        incoming = angle(before, point)
        following = vertices[index + 1] if index + 1 < len(vertices) else None
        outgoing = angle(point, after or (following[1] if following and following[1] else following[0] if following else None))
        out.append((point, incoming if incoming is not None else outgoing or 0.0, outgoing if outgoing is not None else incoming or 0.0))
    return out


def element_vertices(element, tag):
    if tag == "line":
        a = (number(element.get("x1")), number(element.get("y1")))
        b = (number(element.get("x2")), number(element.get("y2")))
        heading = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        return [(a, heading, heading), (b, heading, heading)]
    if tag in ("polyline", "polygon"):
        values = [float(v) for v in re.findall(NUMBER, element.get("points", ""))]
        points = list(zip(values[0::2], values[1::2]))
        if tag == "polygon" and points:
            points.append(points[0])
        d = "M" + " L".join(f"{px} {py}" for px, py in points) if points else ""
        return path_vertices(d)
    return path_vertices(element.get("d", ""))


def expand_markers(root) -> int:
    """Replace every marker reference with a group of the marker's shapes; returns how many were drawn."""
    markers = {m.get("id"): m for m in root.iter(f"{{{SVG}}}marker") if m.get("id")}
    parents = {child: parent for parent in root.iter() for child in parent}
    drawn = 0
    for element in list(root.iter()):
        tag = element.tag.rsplit("}", 1)[-1]
        if tag not in ("path", "line", "polyline", "polygon"):
            continue
        style = style_of(element)
        refs = {}
        for position in ("start", "mid", "end"):
            value = style.pop(f"marker-{position}", None) or element.attrib.pop(f"marker-{position}", None)
            match = re.match(r"url\(\s*#([^)\s]+)\s*\)", value or "")
            if match and match.group(1) in markers:
                refs[position] = markers[match.group(1)]
        element.attrib.pop("marker", None)
        if style:
            element.set("style", ";".join(f"{k}:{v}" for k, v in style.items()))
        elif "style" in element.attrib:
            del element.attrib["style"]
        if not refs:
            continue
        vertices = element_vertices(element, tag)
        if not vertices:
            continue
        stroke_width = number(style.get("stroke-width") or element.get("stroke-width"), 1.0)
        stroke = style.get("stroke") or element.get("stroke") or "black"
        places = []
        if "start" in refs:
            places.append((refs["start"], vertices[0], "start"))
        if "mid" in refs:
            places += [(refs["mid"], vertex, "mid") for vertex in vertices[1:-1]]
        if "end" in refs:
            places.append((refs["end"], vertices[-1], "end"))
        parent = parents.get(element)
        if parent is None:
            continue
        position = list(parent).index(element) + 1
        for marker, (point, incoming, outgoing), where in places:
            orient = (marker.get("orient") or "0").strip()
            if orient == "auto-start-reverse" and where == "start":
                turn = outgoing + 180
            elif orient.startswith("auto"):
                turn = outgoing if where == "start" else incoming if where == "end" else (incoming + outgoing) / 2
            else:
                turn = number(orient)
            scale = stroke_width if (marker.get("markerUnits") or "strokeWidth") == "strokeWidth" else 1.0
            view = [float(v) for v in re.findall(NUMBER, marker.get("viewBox") or "")]
            fit = f"scale({scale})"
            if len(view) == 4 and view[2] and view[3]:
                width, height = number(marker.get("markerWidth"), 3.0), number(marker.get("markerHeight"), 3.0)
                ratio = min(width / view[2], height / view[3])
                fit = f"scale({scale * ratio}) translate({-view[0]} {-view[1]})"
            group = ET.Element(f"{{{SVG}}}g", {
                "transform": f"translate({point[0]} {point[1]}) rotate({turn}) {fit} "
                             f"translate({-number(marker.get('refX'))} {-number(marker.get('refY'))})",
            })
            for attribute in ("fill", "stroke", "stroke-width"):
                if marker.get(attribute):
                    group.set(attribute, marker.get(attribute))
            for child in marker:
                shape = copy.deepcopy(child)
                for node in shape.iter():
                    for attribute in ("fill", "stroke"):
                        if node.get(attribute) in ("context-stroke", "currentColor"):
                            node.set(attribute, stroke)
                group.append(shape)
            parent.insert(position, group)
            position += 1
            drawn += 1
    return drawn


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    svg, pdf, previews = Path(argv[0]), Path(argv[1]), Path(argv[2])
    widths = [int(width) for width in argv[3:]] or [1440, 480]
    register_times()
    from svglib.svglib import svg2rlg
    from reportlab.graphics import renderPDF
    import pypdfium2 as pdfium

    ET.register_namespace("", SVG)
    ET.register_namespace("xlink", XLINK)
    try:
        tree = ET.parse(svg)
    except ET.ParseError as error:
        print(json.dumps({"error": f"{svg.name} is not well-formed XML: {error}"}))
        return 1
    markers = expand_markers(tree.getroot())
    with tempfile.TemporaryDirectory() as scratch:
        expanded = Path(scratch) / svg.name
        tree.write(expanded, encoding="utf-8", xml_declaration=True)
        drawing = svg2rlg(str(expanded))
    if drawing is None:
        print(json.dumps({"error": f"svglib could not read {svg.name}"}))
        return 1
    pdf.parent.mkdir(parents=True, exist_ok=True)
    renderPDF.drawToFile(drawing, str(pdf))
    data = pdf.read_bytes()
    fonts = sorted({name.decode() for name in re.findall(rb"/BaseFont\s*/([A-Za-z0-9+_.-]+)", data)})
    images = data.count(b"/Subtype /Image") + data.count(b"/Subtype/Image")

    document = pdfium.PdfDocument(str(pdf))
    page = document[0]
    previews.mkdir(parents=True, exist_ok=True)
    written = []
    for width in widths:
        target = previews / f"{svg.stem}.{width}.png"
        page.render(scale=width / page.get_width()).to_pil().save(target)
        written.append(str(target))
    page.close()
    document.close()
    print(json.dumps({"pdf": str(pdf), "previews": written, "fonts": fonts, "embedded": b"/FontFile2" in data,
                      "text": bool(fonts), "images": images, "markers": markers}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
