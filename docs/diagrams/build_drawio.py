"""Build editable draw.io data flow diagrams (Gane-Sarson) from JSON specs.

Usage: python build_drawio.py [spec.json ...]
With no arguments, builds every *-dfd.json in this folder. Each spec becomes a
.drawio file with the same name.

The JSON "layout" section gives each node's box (x, y, w, h) and each flow's
route as an absolute polyline from the source edge to the target edge, plus
which segment carries the label, on which side, and optionally label_t
(position along that segment, 0-1) and label_wrap (characters per line).

A spec with "parent_diagram" inherits its external entities from the parent
and is checked for balancing against it (see check_balance).
"""

import json
import sys
import textwrap
import xml.etree.ElementTree as ET
from pathlib import Path

YELLOW = "#F7EBA1"
GREY = "#D3D3D3"
STROKE = "#000000"
FONT = "fontFamily=Helvetica;fontColor=#000000;"
LABEL_WRAP = 34           # characters per line in flow labels
CHAR_W, LINE_H = 6.0, 14  # approximate size of 11px Helvetica text
ID_CELL_W = 34


def cell(root, cid, value="", style="", parent="1", vertex=True, geo=None):
    attrs = {"id": cid, "value": value, "style": style, "parent": parent}
    attrs["vertex" if vertex else "edge"] = "1"
    c = ET.SubElement(root, "mxCell", attrs)
    g = ET.SubElement(c, "mxGeometry", {"as": "geometry"})
    if geo:
        for k, v in zip(("x", "y", "width", "height"), geo):
            g.set(k, str(v))
    return c, g


def child_style(extra):
    return f"connectable=0;html=1;whiteSpace=wrap;strokeColor={STROKE};{FONT}{extra}"


def add_entity(root, cid, ent, box):
    cell(root, cid, ent["name"],
         f"rounded=0;whiteSpace=wrap;html=1;fillColor={YELLOW};strokeColor={STROKE};"
         f"fontSize=12;{FONT}",
         geo=(box["x"], box["y"], box["w"], box["h"]))


def add_process(root, cid, proc, box):
    """Rounded box: ID cell and location in the header band, name on a white middle band."""
    w, h = box["w"], box["h"]
    header, footer = 24, 30
    cell(root, cid, "",
         f"rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor={YELLOW};strokeColor={STROKE};"
         "container=1;collapsible=0;recursiveResize=0;",
         geo=(box["x"], box["y"], w, h))
    # ID cell: only its right border is drawn.
    cell(root, f"{cid}-id", proc["id"],
         child_style("shape=partialRectangle;top=0;left=0;bottom=0;right=1;fillColor=none;fontSize=11;"),
         parent=cid, geo=(0, 0, ID_CELL_W, header))
    if proc.get("location"):
        cell(root, f"{cid}-loc", proc["location"],
             child_style("text;fillColor=none;strokeColor=none;fontSize=10;fontStyle=2;"),
             parent=cid, geo=(ID_CELL_W, 0, w - ID_CELL_W, header))
    # Middle band: white, borders top and bottom only, inset 1px so the outline stays visible.
    cell(root, f"{cid}-name", proc["name"],
         child_style("shape=partialRectangle;top=1;left=0;bottom=1;right=0;fillColor=#FFFFFF;fontSize=12;"
                     "spacingLeft=12;spacingRight=12;"),
         parent=cid, geo=(1, header, w - 2, h - header - footer))


def add_store(root, cid, store, box):
    """Open-ended rectangle (no right border) with a grey ID cell on the left."""
    cell(root, cid, store["name"],
         f"shape=partialRectangle;top=1;left=1;bottom=1;right=0;html=1;whiteSpace=wrap;"
         f"fillColor={YELLOW};strokeColor={STROKE};fontSize=12;{FONT}spacingLeft={ID_CELL_W + 6};"
         "container=1;collapsible=0;recursiveResize=0;",
         geo=(box["x"], box["y"], box["w"], box["h"]))
    cell(root, f"{cid}-id", store["id"],
         child_style(f"shape=partialRectangle;top=0;left=0;bottom=0;right=1;fillColor={GREY};fontSize=11;"),
         parent=cid, geo=(0, 0, ID_CELL_W, box["h"]))


def label_geometry(path, route, lines):
    """Relative position along the edge (-1..1) plus a pixel offset to the chosen side."""
    segment, side, t = route["label_segment"], route["label_side"], route.get("label_t", 0.5)
    lengths = [abs(b[0] - a[0]) + abs(b[1] - a[1]) for a, b in zip(path, path[1:])]
    along = sum(lengths[:segment]) + lengths[segment] * t
    rel = 2 * along / sum(lengths) - 1
    half_h = len(lines) * LINE_H / 2 + 4
    half_w = max(map(len, lines)) * CHAR_W / 2 + 8
    offset = {"above": (0, -half_h), "below": (0, half_h),
              "left": (-half_w, 0), "right": (half_w, 0)}[side]
    return rel, offset


def add_flow(root, flow, route, src_id, src_box, dst_id, dst_box):
    path = route["path"]
    (sx, sy), (tx, ty) = path[0], path[-1]
    lines = textwrap.wrap(flow["label"], route.get("label_wrap", LABEL_WRAP))
    start = "startArrow=open;startSize=10;" if flow.get("bidirectional") else "startArrow=none;"
    style = (
        f"edgeStyle=none;rounded=0;html=1;endArrow=open;endSize=10;{start}"
        "jumpStyle=arc;jumpSize=10;"
        f"strokeColor={STROKE};fontSize=11;{FONT}labelBackgroundColor=none;align=center;"
        f"exitX={(sx - src_box['x']) / src_box['w']:.4f};exitY={(sy - src_box['y']) / src_box['h']:.4f};"
        "exitDx=0;exitDy=0;exitPerimeter=0;"
        f"entryX={(tx - dst_box['x']) / dst_box['w']:.4f};entryY={(ty - dst_box['y']) / dst_box['h']:.4f};"
        "entryDx=0;entryDy=0;entryPerimeter=0;"
    )
    c, g = cell(root, f"flow-{flow['id']}", "<br>".join(lines), style, vertex=False)
    c.set("source", src_id)
    c.set("target", dst_id)
    rel, (ox, oy) = label_geometry(path, route, lines)
    g.set("relative", "1")
    g.set("x", f"{rel:.4f}")
    if len(path) > 2:
        pts = ET.SubElement(g, "Array", {"as": "points"})
        for x, y in path[1:-1]:
            ET.SubElement(pts, "mxPoint", {"x": str(x), "y": str(y)})
    ET.SubElement(g, "mxPoint", {"x": f"{ox:.1f}", "y": f"{oy:.1f}", "as": "offset"})


def check_balance(spec, parent):
    """Each parent flow must be fully covered by child flows between the same external entity
    and some process, with every data element carried exactly once."""
    entity_ids = {e["id"] for e in parent["external_entities"]}
    children = {}
    errors = []
    for f in spec["data_flows"]:
        external = f["from"] in entity_ids or f["to"] in entity_ids
        if external and "parent" not in f:
            errors.append(f'{f["id"]} touches an external entity but names no parent flow')
        if "parent" in f:
            children.setdefault(f["parent"], []).append(f)

    for pf in parent["data_flows"]:
        kids = children.pop(pf["id"], [])
        if not kids:
            errors.append(f'context flow {pf["id"]} is missing from this diagram')
            continue
        side = "from" if pf["from"] in entity_ids else "to"
        for k in kids:
            if k[side] != pf[side]:
                errors.append(f'{k["id"]} should connect {pf[side]} like its parent {pf["id"]}')
        expected = sorted(d["name"] for d in pf["data"])
        carried = sorted(n for k in kids for n in k["data"])
        if carried != expected:
            errors.append(f'{pf["id"]} data mismatch: context has {expected}, children carry {carried}')
    for pid in children:
        errors.append(f'parent flow {pid} does not exist in the context diagram')

    if errors:
        raise SystemExit("Balancing check failed:\n  " + "\n  ".join(errors))
    print(f'  balanced against parent: {len(parent["data_flows"])} context flows covered')


def build(spec, spec_dir):
    nodes, routes = spec["layout"]["nodes"], spec["layout"]["flows"]
    processes = spec.get("processes") or [spec["system"]]
    stores = spec.get("data_stores", [])
    entities = spec.get("external_entities")
    if "parent_diagram" in spec:
        parent = json.loads((spec_dir / spec["parent_diagram"]).read_text(encoding="utf-8"))
        entities = entities or parent["external_entities"]
        check_balance(spec, parent)

    mxfile = ET.Element("mxfile", {"host": "build_drawio.py"})
    diagram = ET.SubElement(mxfile, "diagram", {"id": "dfd", "name": spec["diagram"]})
    model = ET.SubElement(diagram, "mxGraphModel", {
        "grid": "1", "gridSize": "10", "guides": "1", "page": "0", "background": "#FFFFFF"})
    root = ET.SubElement(model, "root")
    ET.SubElement(root, "mxCell", {"id": "0"})
    ET.SubElement(root, "mxCell", {"id": "1", "parent": "0"})

    ids = {}
    for p in processes:
        ids[p["id"]] = f"proc-{p['id']}"
        add_process(root, ids[p["id"]], p, nodes[p["id"]])
    for s in stores:
        ids[s["id"]] = f"store-{s['id']}"
        add_store(root, ids[s["id"]], s, nodes[s["id"]])
    for e in entities:
        ids[e["id"]] = f"ent-{e['id']}"
        add_entity(root, ids[e["id"]], e, nodes[e["id"]])
    for f in spec["data_flows"]:
        add_flow(root, f, routes[f["id"]], ids[f["from"]], nodes[f["from"]], ids[f["to"]], nodes[f["to"]])

    ET.indent(mxfile)
    return ET.tostring(mxfile, encoding="unicode")


def main():
    here = Path(__file__).parent
    specs = [Path(a) for a in sys.argv[1:]] or sorted(here.glob("*-dfd.json"))
    for spec_path in specs:
        print(f"{spec_path.name}")
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        out_path = spec_path.with_suffix(".drawio")
        out_path.write_text(build(spec, spec_path.parent), encoding="utf-8")
        print(f"  wrote {out_path.name}")


if __name__ == "__main__":
    main()
