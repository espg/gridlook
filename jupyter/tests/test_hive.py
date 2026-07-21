"""``/gridlook/hive/`` virtual-store views against moczarr's committed SERC fixture.

The fixture (``tests/data/serc_hive`` in the moczarr repo) is zagg-written and
morton-only (post englacial/zagg#314), so every ``cell_ids`` assertion here
exercises moczarr's NESTED fabrication — the load-bearing 6d piece. The suite
needs moczarr importable from a repo checkout (e.g. ``uv pip install -e
/path/to/moczarr``) so the fixture is reachable next to the package; a
plain-``[test]`` environment skips it wholesale.
"""

import json
import os
from pathlib import Path

import pytest
from tornado.httpclient import HTTPClientError

moczarr = pytest.importorskip("moczarr", reason="hive tests need gridlook-jupyter[hive]")
np = pytest.importorskip("numpy")


def _moczarr_testdata() -> Path:
    env = os.environ.get("GRIDLOOK_MOCZARR_TESTDATA")
    if env:
        return Path(env)
    # src layout: src/moczarr/__init__.py -> parents[2] is the repo root.
    return Path(moczarr.__file__).resolve().parents[2] / "tests" / "data"


TESTDATA = _moczarr_testdata()
SERC = TESTDATA / "serc_hive"
#: The stored cell_ids of the last dual-written SERC fixture (pre-zagg#314),
#: whole-store concat order — moczarr's fabrication-parity golden.
GOLDEN = TESTDATA / "serc_cell_ids_golden.npy"
#: An order-6 stamped shard of the fixture (the SERC site itself).
SERC_SHARD = "4331422"

pytestmark = pytest.mark.skipif(
    not (SERC / "morton_hive.json").exists(),
    reason=f"moczarr SERC fixture not found at {SERC} (needs a moczarr repo checkout; "
    "set GRIDLOOK_MOCZARR_TESTDATA to its tests/data)",
)


async def _open(jp_fetch, **params):
    resp = await jp_fetch("gridlook", "hive", "open", params={"store": str(SERC), **params})
    assert resp.code == 200
    return json.loads(resp.body)


async def _fetch_array(jp_fetch, view, name, dtype=None):
    meta = json.loads((await jp_fetch("gridlook", "hive", view, f"{name}/zarr.json")).body)
    # Uncompressed by design: the raw chunk bytes ARE the array.
    assert [c["name"] for c in meta["codecs"]] == ["bytes"]
    if dtype is None:
        dtype = np.dtype(meta["data_type"]).newbyteorder("<")
    chunk = await jp_fetch("gridlook", "hive", view, f"{name}/c/0")
    assert chunk.headers["Content-Type"] == "application/octet-stream"
    return np.frombuffer(chunk.body, dtype=dtype)


async def test_open_returns_view_and_entry_url(jp_fetch):
    out = await _open(jp_fetch)
    assert set(out) >= {"view", "url", "cells", "cell_order", "cached"}
    assert out["url"].endswith(f"/gridlook/hive/{out['view']}")
    assert out["cells"] == len(np.load(GOLDEN))
    assert out["cell_order"] == 8
    assert out["cached"] is False


async def test_reopen_same_selection_reuses_view(jp_fetch):
    first = await _open(jp_fetch)
    again = await _open(jp_fetch)
    assert again["view"] == first["view"]
    assert again["cached"] is True


async def test_zarr_json_carries_healpix_shim_attrs(jp_fetch):
    out = await _open(jp_fetch)
    resp = await jp_fetch("gridlook", "hive", out["view"], "zarr.json")
    assert resp.code == 200
    assert resp.headers["Content-Type"] == "application/json"
    attrs = json.loads(resp.body)["attributes"]
    # Pre-6c compatibility shim: gridlook's detector accepts only
    # dggs.name == "healpix" today; the served block points its existing
    # sparse-HEALPix path at the fabricated NESTED cell_ids.
    assert "zarr_conventions" in attrs
    dggs = attrs["dggs"]
    assert dggs["name"] == "healpix"
    assert dggs["coordinate"] == "cell_ids"
    assert dggs["refinement_level"] == 8
    assert attrs["morton_hive"]["cell_order"] == 8


async def test_cell_ids_match_moczarr_fabrication_golden(jp_fetch):
    out = await _open(jp_fetch)
    ids = await _fetch_array(jp_fetch, out["view"], "cell_ids", "<u8")
    # NESTED values byte-equal the golden (the last dual-written store's
    # stored cell_ids): fabricate-at-serve loses nothing.
    assert np.array_equal(ids, np.load(GOLDEN).astype(np.uint64))


async def test_data_variable_chunk_served(jp_fetch):
    out = await _open(jp_fetch)
    counts = await _fetch_array(jp_fetch, out["view"], "count")
    assert len(counts) == out["cells"]


async def test_aoi_subsets_to_one_shard(jp_fetch):
    out = await _open(jp_fetch, aoi=SERC_SHARD)
    assert out["cells"] == 16  # 4^(cell_order 8 - shard_order 6)
    words = await _fetch_array(jp_fetch, out["view"], "morton", "<u8")
    ids = await _fetch_array(jp_fetch, out["view"], "cell_ids", "<u8")
    from moczarr.fabricate import fabricate_cell_ids

    assert np.array_equal(ids, fabricate_cell_ids(words.astype(np.uint64)))
    golden = set(np.load(GOLDEN).astype(np.uint64).tolist())
    assert set(ids.tolist()) < golden


async def test_bad_aoi_400(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await _open(jp_fetch, aoi="4331422,nope")
    assert e.value.code == 400
    assert b"morton decimal" in e.value.response.body


async def test_window_on_unwindowed_store_400(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await _open(jp_fetch, window="2019")
    assert e.value.code == 400


async def test_missing_store_param_400(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", "open")
    assert e.value.code == 400
    assert b"store=" in e.value.response.body


async def test_non_allowlisted_bucket_403(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", "open", params={"store": "s3://sneaky-bucket/hive-root"})
    assert e.value.code == 403
    assert b"sneaky-bucket" in e.value.response.body
    assert b"allowlist" in e.value.response.body


async def test_unknown_view_404(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", "0123456789abcdef", "zarr.json")
    assert e.value.code == 404
    assert b"/gridlook/hive/open" in e.value.response.body


async def test_missing_object_404(jp_fetch):
    out = await _open(jp_fetch)
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", out["view"], "nope/zarr.json")
    assert e.value.code == 404


class TestLocalStoresDisabled:
    @pytest.fixture
    def hive_config(self):
        return {"allow_local_hive_stores": False}

    async def test_local_path_403(self, jp_fetch):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "hive", "open", params={"store": str(SERC)})
        assert e.value.code == 403
        assert b"allow_local_hive_stores" in e.value.response.body


class TestLruEviction:
    @pytest.fixture
    def hive_config(self):
        return {"allow_local_hive_stores": True, "hive_max_views": 2}

    async def test_third_view_evicts_least_recent(self, jp_fetch):
        a = await _open(jp_fetch, aoi="4331421")
        b = await _open(jp_fetch, aoi="4331422")
        await _open(jp_fetch, aoi="4331421")  # refresh a: b is now LRU
        c = await _open(jp_fetch, aoi="4331424")
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "hive", b["view"], "zarr.json")
        assert e.value.code == 404
        assert b"evicted" in e.value.response.body
        for alive in (a, c):
            resp = await jp_fetch("gridlook", "hive", alive["view"], "zarr.json")
            assert resp.code == 200


class TestOversizeView:
    @pytest.fixture
    def hive_config(self):
        return {"allow_local_hive_stores": True, "hive_max_cells": 10}

    async def test_whole_store_413(self, jp_fetch):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "hive", "open", params={"store": str(SERC)})
        assert e.value.code == 413
        assert b"hive_max_cells" in e.value.response.body
        assert b"aoi=" in e.value.response.body
