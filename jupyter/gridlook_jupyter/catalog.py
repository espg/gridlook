"""``/gridlook/hive/catalog``: one gridlook catalog entry per MATERIALIZED pyramid order.

gridlook#10 phase 1. The SPA's existing catalog switcher (``static/catalog.json``
shape: ``{"type": "gridlook_catalog", "datasets": [{url, title, tag,
description}]}``) IS the order picker: each entry points at the per-order hive
view of one store selection (:mod:`.hive`, ``cell_order=``). The orders come
from the store's manifest through :func:`moczarr.read_ladder` — declared
levels probed for stamped artifacts — never a hardcoded list, and an order
declared but not materialized never becomes an entry. Views are reserved,
not built: listing costs one manifest read plus the ladder probe, and each
level materializes on the first object request for its URL.

Entries carry two extra keys the SPA ignores today and phase 2 reads:
``cell_order`` and ``resolution_km`` (``mortie.order2res`` at that order), so
a camera → order mapping is derived from the catalog, never hardcoded.
"""

import functools
import json

from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web
from tornado.ioloop import IOLoop

from .config import GridlookProxy
from .handlers import PlainTextErrorMixin
from .hive import HiveViewCache, ViewSpec, _authorize_store_root, _parse_aoi


def _read_ladder(root: str, *, window: str | None, region: str | None, anonymous: bool):
    """``moczarr.read_ladder`` with the proxy's store posture (synchronous: S3 GETs)."""
    from moczarr import read_ladder

    kwargs = {}
    if region:
        kwargs["region"] = region
    if anonymous:
        kwargs["anonymous"] = True
    return read_ladder(root, window=window, probe=True, **kwargs)


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
    """``GET /gridlook/hive/catalog[.json]?store=…[&product=…][&window=…][&aoi=…]``.

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
        read = functools.partial(
            _read_ladder,
            root,
            window=window,
            region=proxy.region or None,
            anonymous=proxy.anonymous,
        )
        try:
            ladder = await IOLoop.current().run_in_executor(None, read)
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
