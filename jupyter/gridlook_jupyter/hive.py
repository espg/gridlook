"""``/gridlook/hive/``: moczarr-backed virtual store — one flat zarr per ``open_hive()`` view.

Phase 6d of the viewer plan (espg/gridlook#1): the hub-side answer to "a hive
store is many leaves, but gridlook expects ONE zarr source". ``GET
/gridlook/hive/open`` runs moczarr's ``open_hive()`` (product/AOI/window
selection, fabricated NESTED ``cell_ids`` — post-englacial/zagg#314 stores are
morton-only, so the fabrication is what makes them renderable at all) and
MATERIALIZES the result into an in-memory zarr v3 store; ``GET
/gridlook/hive/<view-id>/<key>`` then serves that store's objects (metadata and
whole chunks — no Range support needed) to zarrita in the browser.

Materialize-on-open, deliberately: views are AOI-scale and bounded
(``GridlookProxy.hive_max_cells``, 413 beyond), materializing keeps this module
free of zarr chunk/codec arithmetic (xarray writes the store; we serve opaque
objects), and every subsequent request is a cache lookup. A streaming/virtual
encoding — computing zarr objects on demand from the open dataset — is the
future optimization if views ever outgrow memory; the URL contract here would
not change.

moczarr (and its xarray/zarr stack) is an extras-gated dependency
(``gridlook-jupyter[hive]``); everything module-level here imports without it.
"""

import asyncio
import functools
import hashlib
import json
import os
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web
from tornado.ioloop import IOLoop

from .config import GridlookProxy
from .handlers import PlainTextErrorMixin

#: hex digest prefix length for view ids (deterministic per request tuple).
_VIEW_ID_HEX = 16

#: Product names are single path segments under the store root (zagg D19 named
#: product roots): no separators, no leading dot — nothing traversal-shaped.
_PRODUCT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")

#: AOI tokens are morton decimals (mortie spec §2; negative for southern base
#: cells). The terminal-``p`` point form never names an area cover.
_AOI_TOKEN_RE = re.compile(r"-?\d+")

#: Highest HEALPix order whose NESTED ids stay below ``2**53`` and so survive
#: as float64-exact JS Numbers in the browser (mirrors
#: ``moczarr.fabricate.FLOAT64_EXACT_MAX_ORDER``). The frontend does all cell
#: math (``nside = 2**refinement_level``, ``12*nside*nside``) in JS doubles, so
#: anything above this renders wrong at HTTP 200.
_FLOAT64_EXACT_MAX_ORDER = 24


#: Per-event-loop build semaphores, keyed by loop and rebuilt when the
#: configured limit changes. Bounds concurrent ``build_view`` offloads so a
#: burst of opens can't hold N×(dataset + store) transiently on top of the
#: resident cache; over-limit opens wait on ``acquire`` (they queue, no 503).
#: Keyed by loop (not a bare module global) so it stays sound across the fresh
#: event loop each test — and each real server process — runs under.
_BUILD_SEMAPHORES: dict[asyncio.AbstractEventLoop, tuple[int, asyncio.Semaphore]] = {}


def _build_semaphore(limit: int) -> asyncio.Semaphore:
    """The build semaphore for the running loop, sized to *limit* (min 1)."""
    loop = asyncio.get_running_loop()
    limit = max(1, limit)
    cached = _BUILD_SEMAPHORES.get(loop)
    if cached is None or cached[0] != limit:
        sem = asyncio.Semaphore(limit)
        _BUILD_SEMAPHORES[loop] = (limit, sem)
        return sem
    return cached[1]


class ViewTooLargeError(Exception):
    """Raised when an open would materialize more cells than ``hive_max_cells``."""

    def __init__(self, cells: int):
        self.cells = cells


class ViewNotFloat64ExactError(Exception):
    """Raised when a view's fabricated NESTED ids exceed the float64-exact range.

    The browser holds cell ids as float64 Numbers, so an AREA store above
    ``_FLOAT64_EXACT_MAX_ORDER`` (order 24) would render silently wrong — reject
    at open rather than serve it. POINT-kind words clip to order 24 in
    fabrication and are fine (see :func:`_served_refinement_level`).
    """

    def __init__(self, order: int):
        self.order = order


@dataclass
class HiveView:
    """One materialized view: an in-memory zarr store plus its provenance."""

    store: Any  # zarr.storage.MemoryStore
    cells: int
    cell_order: int
    store_url: str
    product: str | None
    window: str | None
    aoi: tuple[str, ...] | None = field(default=None)


class HiveViewCache:
    """LRU-bounded ``view-id -> HiveView`` map, one per server process.

    View ids are deterministic over the request tuple, so re-opening the same
    selection refreshes (LRU-bumps) the existing view instead of duplicating
    it; serving a view's objects bumps it too, so actively rendered views
    survive. Views are re-materialized only after eviction.
    """

    def __init__(self, proxy: GridlookProxy):
        self._proxy = proxy
        self._views: OrderedDict[str, HiveView] = OrderedDict()

    @staticmethod
    def view_id(
        store_url: str, product: str | None, window: str | None, aoi: tuple[str, ...] | None
    ) -> str:
        # Canonicalize so selections that name the SAME data collapse to one id
        # (one materialization, one LRU slot): strip the store's trailing slash
        # (build_view rstrips it for the data path anyway), normalize empty
        # params to absent, and sort+dedupe the aoi tokens (order and repeats
        # don't change the cover).
        aoi_canon = sorted({int(t) for t in aoi}) if aoi else None
        payload = json.dumps(
            [store_url.rstrip("/"), product or None, window or None, aoi_canon],
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()[:_VIEW_ID_HEX]

    def get(self, view_id: str) -> HiveView | None:
        view = self._views.get(view_id)
        if view is not None:
            self._views.move_to_end(view_id)
        return view

    def put(self, view_id: str, view: HiveView) -> None:
        self._views[view_id] = view
        self._views.move_to_end(view_id)
        while len(self._views) > max(1, self._proxy.hive_max_views):
            self._views.popitem(last=False)


#: The zarr-conventions envelope entry for the dggs convention, added only when
#: a store somehow lacks one (gridlook's detector keys on the envelope's presence).
_DGGS_CONVENTION_ENTRY = {
    "schema_url": "https://raw.githubusercontent.com/zarr-conventions/dggs/refs/tags/v1/schema.json",
    "spec_url": "https://github.com/zarr-conventions/dggs/blob/v1/README.md",
    "uuid": "7b255807-140c-42ca-97f6-7a1cfecdbc38",
    "name": "dggs",
    "description": "Discrete Global Grid Systems convention for zarr",
}


def _served_refinement_level(cell_ids, morton_words, cell_order: int) -> int:
    """The HEALPix order the *served* NESTED ids actually sit at.

    ``cell_order`` (the manifest's) is the order of the stored WORDS, not
    always the order of the fabricated ids: ``fabricate_cell_ids`` clips
    POINT-kind words (spec §1/§4) to :data:`_FLOAT64_EXACT_MAX_ORDER`, so a
    point store's served ids sit at 24 even though its manifest declares order
    29. Deriving ``refinement_level`` from the served ids (not the manifest)
    makes point stores render at the right scale instead of at a mismatched
    ``nside = 2**29``. AREA words never clip — an area store above order 24
    would serve ids the browser cannot hold as float64 (``2**53``), so we
    reject it (:class:`ViewNotFloat64ExactError`) rather than render it wrong.
    """
    import numpy as np
    from moczarr.convention import is_point_word

    words = np.asarray(morton_words, dtype=np.uint64).ravel()
    is_point = bool(np.asarray(is_point_word(words)).any()) if words.size else False
    order = _FLOAT64_EXACT_MAX_ORDER if is_point else int(cell_order)
    ids = np.asarray(cell_ids, dtype=np.uint64).ravel()
    max_id = int(ids.max()) if ids.size else 0
    # Honest float64 guard on the served bytes: an area store above order 24, or
    # a mixed store whose real order-29 areas ride past the point clip, trips this.
    if order > _FLOAT64_EXACT_MAX_ORDER or max_id >= 12 * 4**_FLOAT64_EXACT_MAX_ORDER:
        raise ViewNotFloat64ExactError(int(cell_order))
    return order


def _shim_dggs_attrs(ds, refinement_level: int) -> None:
    """Rewrite the served ``dggs`` attrs to the healpix-shaped block gridlook reads TODAY.

    PRE-6C COMPATIBILITY SHIM. A morton-only hive's stored convention block is
    ``{name: "morton", coordinate: "morton"}`` (mortie spec §5); gridlook's
    ``gridTypeDetector.ts`` currently rejects any ``dggs.name != "healpix"``,
    and ``Healpix.vue`` reads ``refinement_level`` (→ nside) plus
    ``coordinate`` (→ the cell-id coordinate). The fabricated NESTED
    ``cell_ids`` ARE plain HEALPix NESTED indices at ``refinement_level``, so
    advertising ``{name: "healpix", coordinate: "cell_ids"}`` feeds the
    existing sparse limited-area HEALPix path bit-for-bit what it already
    consumes — no frontend change needed. ``refinement_level`` is the order the
    served ids actually sit at (:func:`_served_refinement_level`), NOT the raw
    manifest ``cell_order`` (which is the point-store trap). Phase 6c teaches
    the detector the morton convention entry natively; when it lands, this shim
    can serve the stored block unmodified.
    """
    dggs = dict(ds.attrs.get("dggs") or {})
    dggs.update(
        {"name": "healpix", "refinement_level": int(refinement_level), "coordinate": "cell_ids"}
    )
    dggs.setdefault("spatial_dimension", "cells")
    ds.attrs["dggs"] = dggs
    ds.attrs.setdefault("zarr_conventions", [_DGGS_CONVENTION_ENTRY])


def build_view(
    root: str,
    *,
    store_url: str,
    product: str | None,
    aoi: tuple[str, ...] | None,
    window: str | None,
    max_cells: int,
) -> HiveView:
    """Open a hive selection and materialize it as an in-memory zarr store.

    Synchronous and potentially slow (S3 GETs, concat) — the handler runs it
    on the executor, off the event loop.
    """
    import zarr
    from moczarr import open_hive

    ds = open_hive(
        root,
        aoi=list(aoi) if aoi else None,
        window=window,
        # Load-bearing: post-zagg#314 stores carry only the packed-u64 morton
        # coordinate; "auto" fabricates the exact NESTED cell_ids view the
        # browser-side HEALPix path consumes (and keeps stored bytes on any
        # remaining dual-written store).
        fabricate_cell_ids="auto",
    )
    dim = ds["morton"].dims[0] if "morton" in ds.coords else "cells"
    cells = int(ds.sizes.get(dim, 0))
    if cells > max_cells:
        raise ViewTooLargeError(cells)
    cell_order = int(ds.attrs["morton_hive"]["cell_order"])
    # Derive from the SERVED ids (point words clip to order 24), and reject
    # area stores whose ids the browser can't hold as float64 — the warning
    # moczarr emits for those is swallowed on the executor thread.
    refinement_level = _served_refinement_level(
        ds["cell_ids"].values, ds["morton"].values, cell_order
    )
    _shim_dggs_attrs(ds, refinement_level)
    mem = zarr.storage.MemoryStore()
    # No compression: objects are served whole over hub-local HTTP, views are
    # session-scoped, and codec-free chunks keep the served bytes trivially
    # predictable (the tests compare them raw).
    encoding = {name: {"compressors": None} for name in list(ds.data_vars) + list(ds.coords)}
    ds.to_zarr(mem, mode="w", consolidated=False, zarr_format=3, encoding=encoding)
    return HiveView(
        store=mem,
        cells=cells,
        cell_order=int(ds.attrs["morton_hive"]["cell_order"]),
        store_url=store_url,
        product=product,
        window=window,
        aoi=aoi,
    )


def _parse_aoi(raw: str | None) -> tuple[str, ...] | None:
    if raw is None:
        return None
    tokens = tuple(t.strip() for t in raw.split(",") if t.strip())
    if not tokens:
        raise web.HTTPError(400, "aoi= is empty — expected comma-separated morton decimals")
    for token in tokens:
        if not _AOI_TOKEN_RE.fullmatch(token):
            raise web.HTTPError(400, f"aoi token {token!r} is not a morton decimal")
    return tokens


def _authorize_store_root(proxy: GridlookProxy, store_url: str, product: str | None) -> str:
    """Allowlist gate (same posture as the S3 proxy) and product-root resolution."""
    if product is not None and not _PRODUCT_RE.fullmatch(product):
        raise web.HTTPError(400, f"invalid product name: {product!r}")
    if store_url.startswith("s3://"):
        bucket = store_url[len("s3://") :].split("/", 1)[0]
        if not bucket:
            raise web.HTTPError(400, f"invalid store URL: {store_url!r}")
        if not proxy.enabled:
            raise web.HTTPError(
                403,
                "gridlook hive endpoint is disabled for S3: no allowed buckets are "
                "configured. Set GridlookProxy.allowed_buckets (or GRIDLOOK_ALLOWED_BUCKETS).",
            )
        if bucket not in proxy.allowed_buckets:
            raise web.HTTPError(
                403,
                f"bucket '{bucket}' is not in the gridlook proxy allowlist "
                f"(GridlookProxy.allowed_buckets)",
            )
    elif "://" in store_url:
        raise web.HTTPError(
            403, f"unsupported store scheme in {store_url!r}: use s3://… or a local path"
        )
    elif not _local_path_allowed(proxy, store_url):
        # Uniform body regardless of whether the path exists / is a file /
        # is a directory: an authenticated user must not learn the on-box
        # filesystem layout by probing store= (existence/type oracle).
        raise web.HTTPError(
            403,
            "local-path hive store is not within an allowed root — set "
            "GridlookProxy.local_hive_store_roots (development only)",
        )
    root = store_url.rstrip("/")
    return f"{root}/{product}" if product else root


def _local_path_allowed(proxy: GridlookProxy, store_url: str) -> bool:
    """Whether *store_url* resolves inside one of the configured local roots.

    Containment is checked on ``realpath`` (symlinks resolved) so a path that
    is textually under a root but links outside it is rejected. Empty roots
    (the default) disable local stores entirely.
    """
    roots = proxy.local_hive_store_roots
    if not roots:
        return False
    real = os.path.realpath(store_url)
    for root in roots:
        rroot = os.path.realpath(root)
        if real == rroot or real.startswith(rroot + os.sep):
            return True
    return False


class HiveOpenHandler(PlainTextErrorMixin, JupyterHandler):
    """``GET /gridlook/hive/open?store=…[&product=…][&aoi=…][&window=…]``.

    Creates (or LRU-refreshes) a view and returns its id plus the entry URL to
    paste into gridlook as a zarr dataset source.
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

        view_id = cache.view_id(store_url, product, window, aoi)
        view = cache.get(view_id)
        cached = view is not None
        if view is None:
            build = functools.partial(
                build_view,
                root,
                store_url=store_url,
                product=product,
                aoi=aoi,
                window=window,
                max_cells=proxy.hive_max_cells,
            )
            try:
                # Cap concurrent materializations (each holds ds + store copy
                # transiently); over-limit opens queue on acquire.
                async with _build_semaphore(proxy.hive_max_concurrent_builds):
                    view = await IOLoop.current().run_in_executor(None, build)
            except ViewTooLargeError as e:
                raise web.HTTPError(
                    413,
                    f"hive view would materialize {e.cells} cells, over the "
                    f"{proxy.hive_max_cells}-cell limit — narrow the aoi= or window= "
                    f"selection (or raise GridlookProxy.hive_max_cells)",
                ) from e
            except ViewNotFloat64ExactError as e:
                raise web.HTTPError(
                    422,
                    f"hive store cell_order {e.order} exceeds order "
                    f"{_FLOAT64_EXACT_MAX_ORDER}: its NESTED cell_ids are above the "
                    f"float64-exact integer range (2**53) that the browser holds cell "
                    f"ids in, so it cannot be rendered (point-kind stores clip to order "
                    f"{_FLOAT64_EXACT_MAX_ORDER} and are fine; area stores do not)",
                ) from e
            except FileNotFoundError as e:
                raise web.HTTPError(404, f"no hive store at {store_url!r}: {e}") from e
            except ValueError as e:
                # moczarr's NoCoverageError (nothing committed anywhere) is a
                # ValueError subclass: the store exists but has nothing to
                # serve — 404, not a bad request.
                status = 404 if type(e).__name__ == "NoCoverageError" else 400
                raise web.HTTPError(status, f"cannot open {store_url!r}: {e}") from e
            cache.put(view_id, view)

        self.set_header("Content-Type", "application/json")
        self.finish(
            json.dumps(
                {
                    "view": view_id,
                    "url": url_path_join(self.base_url, "gridlook", "hive", view_id),
                    "cells": view.cells,
                    "cell_order": view.cell_order,
                    "cached": cached,
                }
            )
        )


class HiveViewHandler(PlainTextErrorMixin, JupyterHandler):
    """``GET /gridlook/hive/<view-id>/<key>``: serve one zarr object of a view.

    Objects are metadata documents and whole (small) chunks — no Range
    support, mirroring how zarrita fetches them.
    """

    @web.authenticated
    async def get(self, view_id: str, key: str):
        cache: HiveViewCache = self.settings["gridlook_hive_views"]
        view = cache.get(view_id)
        if view is None:
            raise web.HTTPError(
                404,
                f"no hive view '{view_id}' (never opened, or evicted from the LRU "
                f"cache) — (re)open it via /gridlook/hive/open",
            )
        from zarr.core.buffer import default_buffer_prototype

        buf = await view.store.get(key, prototype=default_buffer_prototype())
        if buf is None:
            raise web.HTTPError(404, f"no object '{key}' in hive view '{view_id}'")
        data = buf.to_bytes()
        self.set_header(
            "Content-Type",
            "application/json" if key.endswith(".json") else "application/octet-stream",
        )
        self.set_header("Content-Length", str(len(data)))
        # View URLs die on eviction; keep intermediaries from pinning stale objects.
        self.set_header("Cache-Control", "no-store")
        self.finish(data)
