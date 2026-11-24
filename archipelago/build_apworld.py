#!/usr/bin/env python3
"""Package archipelago/serioussam_tfe into dist/serioussam_tfe.apworld."""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "serioussam_tfe"
OUT = ROOT / "dist" / "serioussam_tfe.apworld"

MANIFEST = {
    "game": "Serious Sam TFE",
    "minimum_ap_version": "0.6.9",
    "world_version": "0.1.0",
    "authors": ["Serious Sam web port"],
    # APContainer packaging scheme (worlds/Files.py container_version).
    "version": 7,
    "compatible_version": 7,
}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    entries = [p for p in SRC.rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    if not (SRC / "data" / "tfe.toml") in entries:
        raise SystemExit("data/tfe.toml missing from source tree")
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("serioussam_tfe/archipelago.json", json.dumps(MANIFEST, indent=2))
        for p in sorted(entries):
            z.write(p, f"serioussam_tfe/{p.relative_to(SRC)}")
    print(f"wrote {OUT} ({len(entries) + 1} entries)")


if __name__ == "__main__":
    main()
