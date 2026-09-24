"""``/gridlook/hive/catalog``: one entry per MATERIALIZED pyramid order (gridlook#10 phase 1)."""

import asyncio
import json
import time

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


@pytest.fixture(autouse=True)
def clear_ladder_memo():
    """The ladder memo is module-level and outlives a test server."""
    from gridlook_jupyter.catalog import _LADDER_CACHE

    _LADDER_CACHE.clear()
    yield
    _LADDER_CACHE.clear()


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
    ids = await _fetch_array(jp_fetch, view, "morton", data_type="uint64")
    assert len(ids) == 16
    # The open route names the same view for the same level, now cached.
    out = await _open(jp_fetch, store=OVERVIEW, cell_order="4")
    assert out["view"] == view
    assert out["cached"] is True
    assert out["cells"] == 16


#: Objects a freshly listed entry is asked for all at once by one page load.
BURST_KEYS = ["zarr.json", "count/zarr.json", "morton/zarr.json", "count/c/0"]


def _held_build(monkeypatch, *, fail=False, hold=0.3):
    """Monkeypatch ``build_view`` to hold its executor slot, and count calls.

    The hold is what makes a coalescing assertion mean anything: the fixture
    builds fast enough that ``builds == 1`` also holds for a purely serial
    build-then-cache-hit, so the burst has to still be in flight when the
    coalescing state is read.
    """
    from gridlook_jupyter import hive

    builds = []
    real = hive.build_view

    def counting(*args, **kwargs):
        builds.append(1)
        time.sleep(hold)
        if fail:
            raise ValueError("synthetic build failure")
        return real(*args, **kwargs)

    monkeypatch.setattr(hive, "build_view", counting)
    return builds


async def test_concurrent_object_requests_share_one_build(jp_fetch, jp_serverapp, monkeypatch):
    builds = _held_build(monkeypatch)
    cache = jp_serverapp.web_app.settings["gridlook_hive_views"]
    doc = await _catalog(jp_fetch)
    view = _view_id(doc["datasets"][0])
    tasks = [asyncio.ensure_future(jp_fetch("gridlook", "hive", view, k)) for k in BURST_KEYS]
    await asyncio.sleep(0.05)  # inside the held build: every request is waiting on it
    assert not any(t.done() for t in tasks)
    assert list(cache._building) == [view]  # one build, not four
    resps = await asyncio.gather(*tasks)
    assert [r.code for r in resps] == [200] * len(BURST_KEYS)
    assert len(builds) == 1
    assert cache._building == {}


async def test_failing_build_surfaces_to_every_waiter(jp_fetch, jp_serverapp, monkeypatch):
    builds = _held_build(monkeypatch, fail=True)
    cache = jp_serverapp.web_app.settings["gridlook_hive_views"]
    doc = await _catalog(jp_fetch)
    view = _view_id(doc["datasets"][0])
    tasks = [asyncio.ensure_future(jp_fetch("gridlook", "hive", view, k)) for k in BURST_KEYS]
    await asyncio.sleep(0.05)
    assert list(cache._building) == [view]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    # ensure()'s contract: the error the open route would have raised reaches
    # the coalesced waiters too, not just the task that ran the build.
    assert [getattr(r, "code", None) for r in results] == [400] * len(BURST_KEYS)
    assert all(b"synthetic build failure" in r.response.body for r in results)
    assert len(builds) == 1
    assert cache._building == {}  # clean: the next request retries the build
    monkeypatch.undo()
    resp = await jp_fetch("gridlook", "hive", view, "zarr.json")
    assert resp.code == 200


async def test_aoi_scopes_every_entry(jp_fetch):
    doc = await _catalog(jp_fetch, aoi=SERC_SHARD)
    view = _view_id(doc["datasets"][0])
    ids = await _fetch_array(jp_fetch, view, "morton", data_type="uint64")
    assert len(ids) == 16  # 4^(8-6), the one shard


async def _entry_url(jp_fetch, forwarded):
    resp = await jp_fetch(
        "gridlook",
        "hive",
        "catalog",
        params={"store": str(SERC)},
        headers={"X-Forwarded-Proto": forwarded},
    )
    return json.loads(resp.body)["datasets"][0]["url"]


async def test_forwarded_proto_ignored_unless_trusted(jp_fetch, jp_serverapp):
    assert not jp_serverapp.trust_xheaders
    assert (await _entry_url(jp_fetch, "https")).startswith("http://")


class TestTrustedXheaders:
    @pytest.fixture
    def jp_server_config(self, jp_server_config):
        return {
            **jp_server_config,
            "ServerApp": {**jp_server_config["ServerApp"], "trust_xheaders": True},
        }

    async def test_forwarded_proto_makes_https_entries(self, jp_fetch):
        assert (await _entry_url(jp_fetch, "https")).startswith("https://")

    @pytest.mark.parametrize("forwarded", ["gopher", "", "https://evil", "ftp"])
    async def test_junk_forwarded_proto_falls_back_to_the_socket_scheme(self, jp_fetch, forwarded):
        assert (await _entry_url(jp_fetch, forwarded)).startswith("http://")


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


class TestLadderProbeMemo:
    """The probe is thousands of GETs on a real store: pay for it once."""

    @staticmethod
    def _counting(monkeypatch):
        from gridlook_jupyter import catalog

        calls = []
        real = catalog._read_ladder

        def counting(root, **kwargs):
            calls.append((root, kwargs.get("window")))
            return real(root, **kwargs)

        monkeypatch.setattr(catalog, "_read_ladder", counting)
        return calls

    async def test_second_listing_reuses_the_probe(self, jp_fetch, monkeypatch):
        calls = self._counting(monkeypatch)
        first = await _catalog(jp_fetch)
        second = await _catalog(jp_fetch)
        assert first == second
        assert len(calls) == 1

    async def test_refresh_reprobes(self, jp_fetch, monkeypatch):
        calls = self._counting(monkeypatch)
        await _catalog(jp_fetch)
        await _catalog(jp_fetch, refresh="1")
        assert len(calls) == 2

    async def test_memo_is_keyed_by_selection(self, jp_fetch, monkeypatch):
        calls = self._counting(monkeypatch)
        await _catalog(jp_fetch)
        await _catalog(jp_fetch, store=OVERVIEW)
        await _catalog(jp_fetch, store=WINDOWED, window="2019")
        assert len(calls) == 3

    async def test_expired_entry_reprobes(self, jp_fetch, monkeypatch):
        from gridlook_jupyter import catalog

        calls = self._counting(monkeypatch)
        monkeypatch.setattr(catalog, "_LADDER_TTL", 0.0)
        await _catalog(jp_fetch)
        await _catalog(jp_fetch)
        assert len(calls) == 2


async def test_valid_but_never_swept_window_404(jp_fetch):
    # window=2031 is a well-formed label the store was never swept for: every
    # declared level probes False. /hive/open answers 404 (NoCoverageError) for
    # the same selection, so the catalog must not answer 200 with zero entries.
    with pytest.raises(HTTPClientError) as e:
        await _catalog(jp_fetch, store=WINDOWED, window="2031")
    assert e.value.code == 404
    body = e.value.response.body
    assert b"window=2031" in body
    assert b"o8" in body  # the declared orders are named
