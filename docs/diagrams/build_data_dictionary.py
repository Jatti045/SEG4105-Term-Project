"""Generate the data dictionary (Markdown) from erd.json.

Usage: python build_data_dictionary.py [erd.json] [out.md]
Defaults to erd.json -> ../data-dictionary.md. Checks that every type is
defined in TYPES and that every foreign key points to an existing attribute.
"""

import json
import sys
from pathlib import Path

TYPES = {
    "int": "Whole number. Single-column `*_id` primary keys are assigned automatically.",
    "string": "Text (UTF-8).",
    "date": "Calendar date, `YYYY-MM-DD`.",
    "datetime": "Timestamp in UTC, ISO 8601, e.g. `2026-11-27T14:04:58Z`.",
    "bool": "`true` or `false`.",
}


def check(spec):
    attrs = {f"{e['name']}.{a['name']}" for e in spec["entities"] for a in e["attributes"]}
    errors = []
    for e in spec["entities"]:
        for a in e["attributes"]:
            if a["type"] not in TYPES:
                errors.append(f"{e['name']}.{a['name']}: unknown type {a['type']}")
            if a.get("fk") and a["fk"] not in attrs:
                errors.append(f"{e['name']}.{a['name']}: foreign key {a['fk']} does not exist")
    if errors:
        raise SystemExit("Data dictionary check failed:\n  " + "\n  ".join(errors))


def render(spec):
    entities = sorted(spec["entities"], key=lambda e: e["store"])  # stable: keeps JSON order within a store
    out = [
        "# Data Dictionary",
        "",
        f"Smart Inventory Fridge · {spec['version']}. Generated from "
        "[diagrams/erd.json](diagrams/erd.json) by `diagrams/build_data_dictionary.py`. "
        "Edit the JSON file, not this page.",
        "",
        "Each entity belongs to one Level-0 data store, so its tables can be traced back to the data flow diagram.",
        "",
        "## Entities",
        "",
        "| Entity | Data store | Description |",
        "|---|---|---|",
    ]
    out += [f"| [{e['name']}](#{e['name'].lower()}) | {e['store']} | {e['description']} |" for e in entities]

    out += ["", "## Data types", "", "| Type | Format |", "|---|---|"]
    out += [f"| `{t}` | {d} |" for t, d in TYPES.items()]
    out += ["", "**Key:** PK = primary key, FK = foreign key. **Required:** No means the value can be empty."]

    for e in entities:
        out += ["", f"## {e['name']}", "", f"**Data store:** {e['store']}  ", e["description"], "",
                "| Attribute | Type | Key | Required | References | Description |",
                "|---|---|---|---|---|---|"]
        for a in e["attributes"]:
            key = ", ".join(k for k, on in (("PK", a.get("pk")), ("FK", a.get("fk"))) if on)
            ref = f"{a['fk']}" if a.get("fk") else ""
            req = "No" if a.get("nullable") else "Yes"
            out.append(f"| `{a['name']}` | `{a['type']}` | {key} | {req} | {ref} | {a['description']} |")

    out += ["", "## Relationships", "", "| ID | Relationship | Multiplicity |", "|---|---|---|"]
    for r in spec["relationships"]:
        out.append(f"| {r['id']} | {r['from']} *{r['name']}* {r['to']} | "
                   f"{r['from']} {r['from_mult']} — {r['to_mult']} {r['to']} |")
    return "\n".join(out) + "\n"


def main():
    here = Path(__file__).parent
    spec_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "erd.json"
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else here.parent / "data-dictionary.md"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    check(spec)
    out_path.write_text(render(spec), encoding="utf-8")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
