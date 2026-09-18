"""``/gridlook/hive/catalog``: one gridlook catalog entry per MATERIALIZED pyramid order.

gridlook#10 phase 1. The SPA's existing catalog switcher (``static/catalog.json``
shape: ``{"type": "gridlook_catalog", "datasets": [{url, title, tag,
description}]}``) IS the order picker: each entry points at the per-order hive
view of one store selection (:mod:`.hive`, ``cell_order=``). The orders come
from the store's manifest through :func:`moczarr.read_ladder` — declared
levels probed for stamped artifacts — never a hardcoded list, and an order
declared but not materialized never becomes an entry. Views are reserved,
not built: each level materializes on the first object request for its URL.

The probe is the expensive half of a listing. moczarr answers "materialized?"
from the artifacts' own stamps, so it costs one ``zarr.json`` GET per
candidate leaf for the leaf tier (the admitted columns' ``groups`` maps, plus
a windowed store's source leaves) and one per overview node — thousands of
GETs on a CA-scale store, at moczarr's own inner concurrency. So the probe
runs under the same semaphore that bounds view materialization
(``GridlookProxy.hive_max_concurrent_builds``) and the resulting ``Ladder``
is memoized per ``(root, window)`` for :data:`_LADDER_TTL` seconds — a
store's ladder is stable for the life of a page, and ``refresh=1`` bypasses
the memo for the sweep that just landed.

Entries carry two extra keys the SPA ignores today and phase 2 reads:
``cell_order`` and ``resolution_km`` (``mortie.order2res`` at that order), so
a camera → order mapping is derived from the catalog, never hardcoded.
"""

import functools
import json
import time
from collections import OrderedDict
from typing import Any

from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web
from tornado.ioloop import IOLoop

from .config import GridlookProxy
from .handlers import PlainTextErrorMixin
from .hive import HiveViewCache, ViewSpec, _authorize_store_root, _build_semaphore, _parse_aoi

#: How long a probed ``Ladder`` stays good. Long enough that panning and tab
#: reloads pay for one probe; short enough that a sweep landing mid-session
#: shows up without a restart (``refresh=1`` skips the wait entirely).
_LADDER_TTL = 300.0
#: Bound on memoized ladders (one per store selection in play; tiny).
_LADDER_CACHE_MAX = 32
#: ``(root, window) -> (monotonic stamp, Ladder)``. ``root`` already carries the
#: product (``_authorize_store_root`` appends it), so the key is the whole
#: selection the probe depends on — ``aoi=`` subsets a view, not the ladder.
_LADDER_CACHE: OrderedDict[tuple[str, str | None], tuple[float, Any]] = OrderedDict()


def _read_ladder(root: str, *, window: str | None, region: str | None, anonymous: bool):
    """``moczarr.read_ladder`` with the proxy's store posture (synchronous: S3 GETs)."""
    from moczarr import read_ladder

    kwargs = {}
    if region:
        kwargs["region"] = region
    if anonymous:
        kwargs["anonymous"] = True
    return read_ladder(root, window=window, probe=True, **kwargs)


async def _ladder(proxy: GridlookProxy, root: str, *, window: str | None, refresh: bool):
    """The store's probed ladder, bounded by the build semaphore and memoized.

    Only successes are memoized, and only for :data:`_LADDER_TTL` seconds.
    """
    key = (root, window)

    def memo():
        hit = None if refresh else _LADDER_CACHE.get(key)
        if hit is not None and time.monotonic() - hit[0] < _LADDER_TTL:
            _LADDER_CACHE.move_to_end(key)
            return hit[1]
        return None

    cached = memo()
    if cached is not None:
        return cached
    read = functools.partial(
        _read_ladder,
        root,
        window=window,
        region=proxy.region or None,
        anonymous=proxy.anonymous,
    )
    async with _build_semaphore(proxy.hive_max_concurrent_builds):
        # Re-check inside the gate: a burst of tabs that queued behind one
        # probe reads its result instead of re-probing the same store.
        cached = memo()
        if cached is not None:
            return cached
        ladder = await IOLoop.current().run_in_executor(None, read)
    _LADDER_CACHE[key] = (time.monotonic(), ladder)
    _LADDER_CACHE.move_to_end(key)
    while len(_LADDER_CACHE) > _LADDER_CACHE_MAX:
        _LADDER_CACHE.popitem(last=False)
    return ladder


def _public_origin(request) -> str:
    """Scheme + host the browser reached us at, for absolute entry URLs.

    zarrita resolves a store URL with ``new URL(root)``, so entries must be
    absolute. Hub proxies terminate TLS and speak plain HTTP to the server;
    ``X-Forwarded-Proto`` (what JupyterHub's proxy sets) wins over the
    socket's scheme so the entries don't become mixed content. Host is taken
    as received (the proxy forwards it unchanged).
    """
    proto = request.headers.get("X-Forwarded-Proto", request.protocol).split(",")[0].strip()
    return f"{proto}://{request.host}"


def catalog_entries(levels, *, origin: str, base_url: str, reserve) -> list[dict]:
    """One entry per materialized level, finest first; *reserve* maps a level to its id."""
    entries = []
    for level in levels:
        if not level.materialized:
            continue
        view_id = reserve(level.cell_order)
        entries.append(
            {
                "title": f"cell order {level.cell_order} ({level.resolution_km:.3g} km)",
                "url": origin + url_path_join(base_url, "gridlook", "hive", view_id),
                "tag": f"o{level.cell_order}",
                "description": f"{level.artifact} artifact at node order {level.order}",
                "cell_order": int(level.cell_order),
                "resolution_km": float(level.resolution_km),
            }
        )
    return entries


class HiveCatalogHandler(PlainTextErrorMixin, JupyterHandler):
    """``GET /gridlook/hive/catalog[.json]?store=…[&product=…][&window=…][&aoi=…][&refresh=1]``.

    The ``.json`` spelling exists for the SPA's DataInput box, which only
    sniffs a typed URL as a catalog when its path ends in ``.json``; the hash
    form ``#<entry url>::catalog=<this url>`` takes either spelling.
    """

    @web.authenticated
    async def get(self):
        proxy: GridlookProxy = self.settings["gridlook_proxy"]
        cache: HiveViewCache = self.settings["gridlook_hive_views"]
        store_url = self.get_query_argument("store", None)
        if not store_url:
            raise web.HTTPError(
                400, "missing required query parameter: store=<hive store root URL or path>"
            )
        product = self.get_query_argument("product", None) or None
        window = self.get_query_argument("window", None) or None
        aoi = _parse_aoi(self.get_query_argument("aoi", None) or None)
        root = _authorize_store_root(proxy, store_url, product)
        try:
            import moczarr  # noqa: F401
        except ImportError as e:
            raise web.HTTPError(
                500,
                "the /gridlook/hive/ endpoints need moczarr — install gridlook-jupyter[hive]",
            ) from e
        refresh = self.get_query_argument("refresh", None) not in (None, "", "0")
        try:
            ladder = await _ladder(proxy, root, window=window, refresh=refresh)
        except FileNotFoundError as e:
            raise web.HTTPError(404, f"no hive store at {store_url!r}: {e}") from e
        except ValueError as e:
            # A windowed store probed without window=, a bad window label, a
            # manifest declaring one order at two nodes: the request is wrong.
            raise web.HTTPError(400, f"cannot read the ladder of {store_url!r}: {e}") from e

        def reserve(cell_order: int) -> str:
            return cache.reserve(
                ViewSpec(
                    root=root,
                    store_url=store_url,
                    product=product,
                    window=window,
                    aoi=aoi,
                    level=int(cell_order),
                )
            )

        entries = catalog_entries(
            ladder.levels,
            origin=_public_origin(self.request),
            base_url=self.base_url,
            reserve=reserve,
        )
        selection = " ".join(f"{k}={v}" for k, v in (("product", product), ("window", window)) if v)
        title = store_url.rstrip("/").rsplit("/", 1)[-1] + (f" ({selection})" if selection else "")
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"type": "gridlook_catalog", "title": title, "datasets": entries}))
