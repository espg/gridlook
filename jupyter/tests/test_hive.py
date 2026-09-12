"""``/gridlook/hive/`` virtual-store views against moczarr's committed SERC fixture.

The fixture (``tests/data/serc_hive`` in the moczarr repo) is zagg-written and
morton-only (post englacial/zagg#314). Views are served NATIVE (issue #8):
the packed-u64 ``morton`` coordinate and the store's own morton ``dggs``
block pass through unmodified, and the browser decodes the words itself — the
assertions here pin that nothing rewrites them. The suite needs the SERC
fixture reachable next to a moczarr repo checkout, or via
``GRIDLOOK_MOCZARR_TESTDATA=<moczarr>/tests/data``; a plain-``[test]``
environment skips it wholesale.
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


@pytest.fixture
def hive_config():
    """Configure TESTDATA as the allowed local root so the fixture is openable."""
    return {"local_hive_store_roots": [str(TESTDATA)]}


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


async def test_zarr_json_serves_native_morton_attrs(jp_fetch):
    out = await _open(jp_fetch)
    resp = await jp_fetch("gridlook", "hive", out["view"], "zarr.json")
    assert resp.code == 200
    assert resp.headers["Content-Type"] == "application/json"
    attrs = json.loads(resp.body)["attributes"]
    # Native serve (issue #8): the store's own morton convention block passes
    # through unmodified — gridlook's detector and Healpix path read it
    # directly and decode the packed words browser-side.
    dggs = attrs["dggs"]
    assert dggs["name"] == "morton"
    assert dggs["coordinate"] == "morton"
    assert attrs["morton_hive"]["cell_order"] == 8
    # The retired shim's artifacts must not reappear.
    assert "_gridlook_source_dggs" not in attrs


async def test_zarr_conventions_envelope_preserved(jp_fetch):
    out = await _open(jp_fetch)
    resp = await jp_fetch("gridlook", "hive", out["view"], "zarr.json")
    attrs = json.loads(resp.body)["attributes"]
    names = [e.get("name") for e in attrs["zarr_conventions"]]
    # Both the generic dggs registry entry and the morton-dggs convention
    # entry survive: the served envelope is the stored one.
    assert names.count("dggs") == 1
    assert names.count("morton-dggs") == 1


#: Golden point/area order-29 packed words (moczarr test_convention, suffix bands
#: §1) — a point word (suffix 48/61) clips to order 24 in fabrication.
POINT_NORTH_WORD = 4733760060091642301  # suffix 61
POINT_SOUTH_WORD = 13712984013617909360  # suffix 48


class TestFloat64ExactGuard:
    """Views the browser's word decode cannot hold as float64 are rejected at open."""

    def test_area_store_within_ceiling_passes(self):
        from gridlook_jupyter.hive import _check_float64_exact

        # Non-point words (low suffix bands) at order 8: decode sits at 8.
        words = np.array([8, 4108, 12], dtype=np.uint64)
        _check_float64_exact(words, cell_order=8)

    def test_point_store_clips_to_float64_ceiling(self):
        from moczarr.convention import is_point_word

        from gridlook_jupyter.hive import _check_float64_exact

        words = np.array([POINT_NORTH_WORD, POINT_SOUTH_WORD], dtype=np.uint64)
        assert bool(np.asarray(is_point_word(words)).all())
        # Manifest says order 29 (points are order-29 encoded), but the
        # browser decode clips every point word to order 24: renderable.
        _check_float64_exact(words, cell_order=29)

    def test_area_above_float64_ceiling_rejected(self):
        from gridlook_jupyter.hive import ViewNotFloat64ExactError, _check_float64_exact

        words = np.array([25], dtype=np.uint64)  # non-point (suffix 25)
        with pytest.raises(ViewNotFloat64ExactError):
            _check_float64_exact(words, cell_order=25)

    def test_mixed_store_above_ceiling_rejected(self):
        from gridlook_jupyter.hive import ViewNotFloat64ExactError, _check_float64_exact

        # A point word plus a deep AREA word: the areas do not clip, so the
        # point clip cannot rescue a cell_order-29 store.
        words = np.array([POINT_NORTH_WORD, 29], dtype=np.uint64)
        with pytest.raises(ViewNotFloat64ExactError):
            _check_float64_exact(words, cell_order=29)

    def test_empty_view_is_not_this_guards_business(self):
        from gridlook_jupyter.hive import _check_float64_exact

        # No words, nothing to decode: emptiness is ViewEmptyError's call in
        # build_view, and it must not depend on the manifest's cell_order.
        for cell_order in (8, 29):
            _check_float64_exact(np.array([], dtype=np.uint64), cell_order=cell_order)


async def test_empty_selection_422(jp_fetch):
    # An AOI naming coverage the store does not have: moczarr warns and hands
    # back a schema-correct 0-cell dataset. Nothing can render that — the
    # browser's decode rejects an empty morton coordinate — so the open is a
    # 422 naming the selection to widen, on both sides of the wire.
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", "open", params={"store": str(SERC), "aoi": "1"})
    assert e.value.code == 422
    assert "0 cells" in str(e.value.response.body)


class TestViewIdCanonicalization:
    """Selections naming the same data hash to one view id (no LRU thrash)."""

    def test_aoi_order_and_dupes_collapse(self):
        from gridlook_jupyter.hive import HiveViewCache

        base = HiveViewCache.view_id("s3://b/root", None, None, ("4331421", "4331422"))
        reordered = HiveViewCache.view_id("s3://b/root", None, None, ("4331422", "4331421"))
        duped = HiveViewCache.view_id("s3://b/root", None, None, ("4331421", "4331421", "4331422"))
        assert base == reordered == duped

    def test_trailing_slash_collapses(self):
        from gridlook_jupyter.hive import HiveViewCache

        assert HiveViewCache.view_id("s3://b/root", None, None, None) == HiveViewCache.view_id(
            "s3://b/root/", None, None, None
        )

    def test_empty_params_equal_absent(self):
        from gridlook_jupyter.hive import HiveViewCache

        assert HiveViewCache.view_id("s3://b/root", "", "", None) == HiveViewCache.view_id(
            "s3://b/root", None, None, None
        )

    def test_distinct_selections_differ(self):
        from gridlook_jupyter.hive import HiveViewCache

        a = HiveViewCache.view_id("s3://b/root", None, None, ("4331421",))
        b = HiveViewCache.view_id("s3://b/root", None, None, ("4331422",))
        assert a != b


async def test_served_words_decode_to_fabrication_golden(jp_fetch):
    from moczarr.fabricate import fabricate_cell_ids

    out = await _open(jp_fetch)
    words = await _fetch_array(jp_fetch, out["view"], "morton", "<u8")
    # The words the view serves decode to exactly the NESTED ids the last
    # dual-written store carried (and the retired shim used to fabricate):
    # native serving loses nothing.
    ids = fabricate_cell_ids(words.astype(np.uint64))
    assert np.array_equal(ids, np.load(GOLDEN).astype(np.uint64))


async def test_no_fabricated_cell_ids_served(jp_fetch):
    out = await _open(jp_fetch)
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", out["view"], "cell_ids/zarr.json")
    assert e.value.code == 404


async def test_data_variable_chunk_served(jp_fetch):
    out = await _open(jp_fetch)
    counts = await _fetch_array(jp_fetch, out["view"], "count")
    assert len(counts) == out["cells"]


async def test_aoi_subsets_to_one_shard(jp_fetch):
    from moczarr.fabricate import fabricate_cell_ids

    out = await _open(jp_fetch, aoi=SERC_SHARD)
    assert out["cells"] == 16  # 4^(cell_order 8 - shard_order 6)
    words = await _fetch_array(jp_fetch, out["view"], "morton", "<u8")
    ids = fabricate_cell_ids(words.astype(np.uint64))
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
        return {"local_hive_store_roots": []}

    async def test_local_path_403(self, jp_fetch):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "hive", "open", params={"store": str(SERC)})
        assert e.value.code == 403
        assert b"local_hive_store_roots" in e.value.response.body


class TestLocalStoreRootContainment:
    """Only paths inside a configured root open; everything else is a uniform 403."""

    @pytest.fixture
    def hive_config(self):
        # SERC's parent is allowed, but not the filesystem at large.
        return {"local_hive_store_roots": [str(TESTDATA)]}

    @pytest.mark.parametrize(
        "outside",
        [
            "/etc/passwd",  # a file that exists
            "/etc",  # a directory that exists (no manifest)
            "/nonexistent/hive/store",  # a path that does not exist
            str(TESTDATA.parent),  # the parent of the root (just above containment)
        ],
    )
    async def test_outside_root_uniform_403(self, jp_fetch, outside):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "hive", "open", params={"store": outside})
        assert e.value.code == 403
        # No existence/type distinction: identical body for file / dir / missing.
        assert b"not within an allowed root" in e.value.response.body
        assert b"local_hive_store_roots" in e.value.response.body

    async def test_fixture_inside_root_opens(self, jp_fetch):
        out = await _open(jp_fetch)
        assert out["cells"] == len(np.load(GOLDEN))


class TestLruEviction:
    @pytest.fixture
    def hive_config(self):
        return {"local_hive_store_roots": [str(TESTDATA)], "hive_max_views": 2}

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
        return {"local_hive_store_roots": [str(TESTDATA)], "hive_max_cells": 10}

    async def test_whole_store_413(self, jp_fetch):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "hive", "open", params={"store": str(SERC)})
        assert e.value.code == 413
        assert b"hive_max_cells" in e.value.response.body
        assert b"aoi=" in e.value.response.body


class TestConcurrentBuildBound:
    @pytest.fixture
    def hive_config(self):
        # Fewer permitted concurrent builds than the burst below: the extras
        # must queue on the semaphore, not fail.
        return {"local_hive_store_roots": [str(TESTDATA)], "hive_max_concurrent_builds": 2}

    async def test_burst_of_opens_all_succeed(self, jp_fetch):
        import asyncio

        # Four distinct selections (distinct view ids ⇒ four real builds) opened
        # at once; with a bound of 2 the extras wait, and all four still 200.
        aois = ["4331421", "4331422", "4331424", "4331421,4331422"]
        outs = await asyncio.gather(*(_open(jp_fetch, aoi=a) for a in aois))
        assert len({o["view"] for o in outs}) == 4
        for o in outs:
            assert o["cells"] > 0
