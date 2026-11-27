"""Build an editable draw.io ERD in UML class notation from erd.json.

Usage: python build_erd.py [erd.json] [out.drawio]

Each entity is a class box whose header shows its Level-0 data store as a
stereotype. Each relationship is an association line with multiplicities at
both ends and its name in the middle. Box heights come from the attribute
count. Lines run straight between facing sides unless the layout gives
waypoints ("points").
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from build_drawio import FONT, STROKE, YELLOW, cell

WIDTH = 230
HEADER = 40
ROW_H = 13.5   # rendered line height of 11px text in draw.io
PAD = 14


def attr_text(a):
    text = f"{a['name']}: {a['type']}"
    if a.get("nullable"):
        text += " [0..1]"
    tags = [t for t, on in (("PK", a.get("pk")), ("FK", a.get("fk"))) if on]
    return text + (" {" + ", ".join(tags) + "}" if tags else "")


def box(ent, pos):
    w = pos.get("w", WIDTH)
    return {"x": pos["x"], "y": pos["y"], "w": w, "h": HEADER + len(ent["attributes"]) * ROW_H + PAD}


def add_class(root, cid, ent, b):
    cell(root, cid, f"«{ent['store']}»<br><b>{ent['name']}</b>",
         f"swimlane;html=1;whiteSpace=wrap;startSize={HEADER};fillColor={YELLOW};swimlaneFillColor=#FFFFFF;"
         f"strokeColor={STROKE};fontSize=12;{FONT}collapsible=0;container=1;recursiveResize=0;",
         geo=(b["x"], b["y"], b["w"], b["h"]))
    c, _ = cell(root, f"{cid}-attrs", "<br>".join(attr_text(a) for a in ent["attributes"]),
                f"text;html=1;align=left;verticalAlign=top;spacingLeft=8;spacingTop=3;fillColor=none;"
                f"strokeColor=none;fontSize=11;{FONT}",
                parent=cid, geo=(0, HEADER, b["w"], b["h"] - HEADER))
    c.set("connectable", "0")


def side_point(b, side, along):
    return {"left": (b["x"], along), "right": (b["x"] + b["w"], along),
            "top": (along, b["y"]), "bottom": (along, b["y"] + b["h"])}[side]


def route(a, z, lay):
    """Polyline from box a to box z. Without waypoints, a straight line through the middle of the overlap."""
    fs, ts, pts = lay["from_side"], lay["to_side"], [tuple(p) for p in lay.get("points", [])]
    horizontal = lambda side: side in ("left", "right")
    if pts:
        start = side_point(a, fs, pts[0][1] if horizontal(fs) else pts[0][0])
        end = side_point(z, ts, pts[-1][1] if horizontal(ts) else pts[-1][0])
        return [start, *pts, end]
    if horizontal(fs):
        lo, hi = max(a["y"], z["y"]), min(a["y"] + a["h"], z["y"] + z["h"])
    else:
        lo, hi = max(a["x"], z["x"]), min(a["x"] + a["w"], z["x"] + z["w"])
    if lo >= hi:
        raise ValueError(f"boxes do not overlap for a straight line; add waypoints: {lay}")
    mid = (lo + hi) / 2
    return [side_point(a, fs, mid), side_point(z, ts, mid)]


def unit(p, q):
    dx, dy = q[0] - p[0], q[1] - p[1]
    n = abs(dx) + abs(dy)
    return (dx / n, dy / n)


def perp(d, text):
    """Offset to one side of a line running in direction d, far enough to clear the text."""
    px, py = d[1], -d[0]
    mag = len(text) * 3.2 + 6 if px else 11
    return (px * mag, py * mag)


def along(d, text):
    return len(text) * 3.2 + 8 if d[0] else 12


def add_label(root, eid, key, text, rel, offset):
    c, g = cell(root, f"{eid}-{key}", text,
                f"edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];"
                f"labelBackgroundColor=none;fontSize=11;{FONT}", parent=eid)
    c.set("connectable", "0")
    g.set("x", f"{rel}")
    g.set("relative", "1")
    ET.SubElement(g, "mxPoint", {"x": f"{offset[0]:.1f}", "y": f"{offset[1]:.1f}", "as": "offset"})


def add_association(root, rel, path, a_id, a, z_id, z):
    eid = f"rel-{rel['id']}"
    (sx, sy), (tx, ty) = path[0], path[-1]
    c, g = cell(root, eid, "",
                f"edgeStyle=none;rounded=0;html=1;endArrow=none;startArrow=none;strokeColor={STROKE};{FONT}"
                f"exitX={(sx - a['x']) / a['w']:.4f};exitY={(sy - a['y']) / a['h']:.4f};exitDx=0;exitDy=0;exitPerimeter=0;"
                f"entryX={(tx - z['x']) / z['w']:.4f};entryY={(ty - z['y']) / z['h']:.4f};entryDx=0;entryDy=0;entryPerimeter=0;",
                vertex=False)
    c.set("source", a_id)
    c.set("target", z_id)
    g.set("relative", "1")
    if len(path) > 2:
        pts = ET.SubElement(g, "Array", {"as": "points"})
        for x, y in path[1:-1]:
            ET.SubElement(pts, "mxPoint", {"x": str(x), "y": str(y)})

    # Multiplicities just inside each end, on the same side of the line.
    d0 = unit(path[0], path[1])
    p0 = perp(d0, rel["from_mult"])
    a0 = along(d0, rel["from_mult"])
    add_label(root, eid, "src", rel["from_mult"], -1, (d0[0] * a0 + p0[0], d0[1] * a0 + p0[1]))
    d1 = unit(path[-2], path[-1])
    p1 = perp(d1, rel["to_mult"])
    a1 = along(d1, rel["to_mult"])
    add_label(root, eid, "dst", rel["to_mult"], 1, (-d1[0] * a1 + p1[0], -d1[1] * a1 + p1[1]))

    # Name at the midpoint of the line, on the opposite side from the multiplicities.
    lengths = [abs(q[0] - p[0]) + abs(q[1] - p[1]) for p, q in zip(path, path[1:])]
    half, i = sum(lengths) / 2, 0
    while half > lengths[i]:
        half -= lengths[i]
        i += 1
    pn = perp(unit(path[i], path[i + 1]), rel["name"])
    add_label(root, eid, "name", rel["name"], 0, (-pn[0], -pn[1]))


def build(spec):
    lay = spec["layout"]
    boxes = {e["name"]: box(e, lay["entities"][e["name"]]) for e in spec["entities"]}
    ids = {name: f"class-{name}" for name in boxes}

    mxfile = ET.Element("mxfile", {"host": "build_erd.py"})
    diagram = ET.SubElement(mxfile, "diagram", {"id": "erd", "name": spec["diagram"]})
    model = ET.SubElement(diagram, "mxGraphModel", {
        "grid": "1", "gridSize": "10", "guides": "1", "page": "0", "background": "#FFFFFF"})
    root = ET.SubElement(model, "root")
    ET.SubElement(root, "mxCell", {"id": "0"})
    ET.SubElement(root, "mxCell", {"id": "1", "parent": "0"})

    for e in spec["entities"]:
        add_class(root, ids[e["name"]], e, boxes[e["name"]])
    for r in spec["relationships"]:
        a, z = boxes[r["from"]], boxes[r["to"]]
        add_association(root, r, route(a, z, lay["relationships"][r["id"]]), ids[r["from"]], a, ids[r["to"]], z)

    ET.indent(mxfile)
    return ET.tostring(mxfile, encoding="unicode")


def main():
    here = Path(__file__).parent
    spec_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "erd.json"
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else spec_path.with_suffix(".drawio")
    out_path.write_text(build(json.loads(spec_path.read_text(encoding="utf-8"))), encoding="utf-8")
    print(f"wrote {out_path.name}")


if __name__ == "__main__":
    main()
