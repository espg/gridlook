#!/usr/bin/env python3
"""Generate tests/data/shim_parity_serc.json (issue #8 phase 6 v2 parity evidence).

Captures what the RETIRING ``_shim_dggs_attrs`` path in
``jupyter/gridlook_jupyter/hive.py`` actually served for one SERC shard — the
fabricated NESTED ``cell_ids``, the shim's ``dggs`` block
(``refinement_level``/``coordinate``), and the stored morton words — so a
committed test can prove the native path (browser-side word decode,
``decodeMortonCells``) feeds the healpix render path the SAME (order, cell)
inputs the shim did. The render path is a pure function of
``(cells, nside, data)`` and the served data bytes are untouched by either
path, so id/order equality plus a data-texture spot check IS render parity.

Run against the hive module WITH the shim still present (this script is the
frozen record of its output). Requires the jupyter test env
(``gridlook-jupyter[hive]`` + moczarr's SERC fixture next to a moczarr
checkout, or GRIDLOOK_MOCZARR_TESTDATA):

    jupyter/.venv/bin/python scripts/generate_shim_parity_fixture.py
"""

import json
import os
import sys

import numpy as np
import zarr

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "jupyter"))
from gridlook_jupyter.hive import build_view  # noqa: E402

SERC = os.environ.get(
    "GRIDLOOK_MOCZARR_TESTDATA",
    "/Users/espg/software/moczarr/tests/data",
)
STORE = os.path.join(SERC, "serc_hive")
SHARD = "4331422"
OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "data", "shim_parity_serc.json")


def main() -> None:
    view = build_view(
        STORE,
        store_url=STORE,
        product=None,
        aoi=(SHARD,),
        window=None,
        max_cells=10_000,
    )
    group = zarr.open(view.store, mode="r")
    attrs = dict(group.attrs)
    dggs = attrs["dggs"]
    words = np.asarray(group["morton"][:], dtype=np.uint64)
    cell_ids = np.asarray(group["cell_ids"][:], dtype=np.uint64)
    counts = np.asarray(group["count"][:])
    fixture = {
        "comment": (
            "Frozen output of the retired _shim_dggs_attrs path for SERC shard "
            f"{SHARD} (moczarr serc_hive fixture): the shim-served dggs block and "
            "fabricated NESTED cell_ids beside the stored morton words. Generated "
            "by scripts/generate_shim_parity_fixture.py against the pre-retirement "
            "hive.py; the native path must reproduce (refinement_level, cell_ids) "
            "from the words alone (espg/gridlook#8)."
        ),
        "shard": SHARD,
        "shim_dggs": {
            "name": dggs["name"],
            "coordinate": dggs["coordinate"],
            "refinement_level": int(dggs["refinement_level"]),
        },
        "morton_words": [str(int(w)) for w in words],
        "shim_cell_ids": [int(c) for c in cell_ids],
        "count": [None if not np.isfinite(v) else float(v) for v in counts],
    }
    with open(os.path.abspath(OUT), "w") as f:
        json.dump(fixture, f, indent=1)
        f.write("\n")
    print(f"wrote {os.path.abspath(OUT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
