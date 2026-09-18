"""``/gridlook/hive/catalog``: one entry per MATERIALIZED pyramid order (gridlook#10 phase 1)."""

import asyncio
import json

import pytest
from test_hive import OVERVIEW, SERC, SERC_SHARD, TESTDATA, _fetch_array, _open
from tornado.httpclient import HTTPClientError

moczarr = pytest.importorskip("moczarr", reason="hive tests need gridlook-jupyter[hive]")
np = pytest.importorskip("numpy")

#: A windowed (morton-hive/2) zagg-pyramid/1 store: node order 4 declared (cell
#: order 6) and swept for window 2019; nothing else materialized.
WINDOWED = TESTDATA / "overview_hive" / "atl06_windows"

pytestmark = pytest.mark.skipif(
    not (OVERVIEW / "morton_hive.json").exists(),
    reason=f"moczarr overview fixture not found at {OVERVIEW}",
)


@pytest.fixture
def hive_config():
    return {"local_hive_store_roots": [str(TESTDATA)]}


async def _catalog(jp_fetch, store=SERC, spelling="catalog", **params):
    resp = await jp_fetch("gridlook", "hive", spelling, params={"store": str(store), **params})
    assert resp.code == 200
    assert resp.headers["Content-Type"].startswith("application/json")
    return json.loads(resp.body)


def _view_id(entry):
    return entry["url"].rsplit("/", 1)[-1]


async def test_catalog_document_shape(jp_fetch, jp_base_url):
    doc = await _catalog(jp_fetch)
    # The SPA's isCatalog() contract: type + datasets[]; title is optional.
    assert doc["type"] == "gridlook_catalog"
    assert doc["title"] == "serc_hive"
    assert len(doc["datasets"]) == 1
    entry = doc["datasets"][0]
    assert set(entry) >= {"url", "title", "tag", "description"}
    assert entry["tag"] == "o8"
    assert entry["cell_order"] == 8
    assert entry["resolution_km"] == pytest.approx(25.467, abs=1e-3)
    assert "source" in entry["description"]
    # Absolute (zarrita's FetchStore refuses a path-only root), under the base_url.
    assert entry["url"].startswith("http://")
    assert f"{jp_base_url}gridlook/hive/" in entry["url"]


async def test_catalog_json_spelling(jp_fetch):
    a = await _catalog(jp_fetch)
    b = await _catalog(jp_fetch, spelling="catalog.json")
    assert a == b


async def test_materialized_orders_finest_first(jp_fetch):
    doc = await _catalog(jp_fetch, store=OVERVIEW)
    from moczarr import read_ladder

    ladder = read_ladder(str(OVERVIEW))
    assert [e["cell_order"] for e in doc["datasets"]] == list(ladder.materialized) == [8, 6, 4]
    assert [e["tag"] for e in doc["datasets"]] == ["o8", "o6", "o4"]
    kms = [e["resolution_km"] for e in doc["datasets"]]
    assert kms == sorted(kms)  # coarser order, larger cells
    assert [e["description"] for e in doc["datasets"]] == [
        "source artifact at node order 6",
        "overview artifact at node order 4",
        "overview artifact at node order 2",
    ]
    assert len({_view_id(e) for e in doc["datasets"]}) == 3


async def test_declared_but_unmaterialized_order_is_not_listed(jp_fetch):
    # Window 2019 was swept at node order 4 only: cell orders 8 (source) and 6.
    doc = await _catalog(jp_fetch, store=WINDOWED, window="2019")
    assert [e["cell_order"] for e in doc["datasets"]] == [8, 6]


async def test_windowed_store_needs_window_400(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await _catalog(jp_fetch, store=WINDOWED)
    assert e.value.code == 400
    assert b"window=" in e.value.response.body


async def test_entries_are_reserved_not_built(jp_fetch, jp_serverapp):
    cache = jp_serverapp.web_app.settings["gridlook_hive_views"]
    doc = await _catalog(jp_fetch, store=OVERVIEW)
    for entry in doc["datasets"]:
        assert cache.get(_view_id(entry)) is None
        assert cache.spec(_view_id(entry)).level == entry["cell_order"]


async def test_entry_view_builds_on_first_object_request(jp_fetch, jp_serverapp):
    cache = jp_serverapp.web_app.settings["gridlook_hive_views"]
    doc = await _catalog(jp_fetch, store=OVERVIEW)
    o4 = next(e for e in doc["datasets"] if e["cell_order"] == 4)
    view = _view_id(o4)
    meta = json.loads((await jp_fetch("gridlook", "hive", view, "zarr.json")).body)
    assert cache.get(view) is not None
    assert meta["attributes"]["zagg_level"]["cell_order"] == 4
    assert meta["attributes"]["dggs"]["refinement_level"] == 4
    ids = await _fetch_array(jp_fetch, view, "cell_ids", "<u8")
    assert len(ids) == 16
    # The open route names the same view for the same level, now cached.
    out = await _open(jp_fetch, store=OVERVIEW, cell_order="4")
    assert out["view"] == view
    assert out["cached"] is True
    assert out["cells"] == 16


async def test_concurrent_object_requests_share_one_build(jp_fetch, monkeypatch):
    from gridlook_jupyter import hive

    builds = 0
    real = hive.build_view

    def counting(*args, **kwargs):
        nonlocal builds
        builds += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(hive, "build_view", counting)
    doc = await _catalog(jp_fetch)
    view = _view_id(doc["datasets"][0])
    keys = ["zarr.json", "count/zarr.json", "cell_ids/zarr.json", "count/c/0"]
    resps = await asyncio.gather(*(jp_fetch("gridlook", "hive", view, k) for k in keys))
    assert [r.code for r in resps] == [200] * len(keys)
    assert builds == 1


async def test_aoi_scopes_every_entry(jp_fetch):
    doc = await _catalog(jp_fetch, aoi=SERC_SHARD)
    view = _view_id(doc["datasets"][0])
    ids = await _fetch_array(jp_fetch, view, "cell_ids", "<u8")
    assert len(ids) == 16  # 4^(8-6), the one shard


async def test_forwarded_proto_makes_https_entries(jp_fetch):
    resp = await jp_fetch(
        "gridlook",
        "hive",
        "catalog",
        params={"store": str(SERC)},
        headers={"X-Forwarded-Proto": "https"},
    )
    doc = json.loads(resp.body)
    assert doc["datasets"][0]["url"].startswith("https://")


async def test_missing_store_400(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", "catalog")
    assert e.value.code == 400
    assert b"store=" in e.value.response.body


async def test_non_allowlisted_bucket_403(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "hive", "catalog", params={"store": "s3://sneaky/root"})
    assert e.value.code == 403


async def test_bad_aoi_400(jp_fetch):
    with pytest.raises(HTTPClientError) as e:
        await _catalog(jp_fetch, aoi="nope")
    assert e.value.code == 400


class TestCatalogEntries:
    """The pure entry builder: materialized levels only, finest first."""

    def test_skips_unmaterialized_and_unknown(self):
        from moczarr.surfaces import LadderLevel

        from gridlook_jupyter.catalog import catalog_entries

        levels = [
            LadderLevel(8, 6, "source", 25.5, True),
            LadderLevel(7, 6, "column", 51.0, None),  # unprobeable: unknown
            LadderLevel(6, 4, "overview", 102.0, False),  # declared, not swept
            LadderLevel(4, 2, "overview", 407.5, True),
        ]
        entries = catalog_entries(
            levels, origin="https://hub", base_url="/user/x/", reserve=lambda o: f"id{o}"
        )
        assert [e["cell_order"] for e in entries] == [8, 4]
        assert entries[1]["url"] == "https://hub/user/x/gridlook/hive/id4"
        assert entries[0]["title"] == "cell order 8 (25.5 km)"
