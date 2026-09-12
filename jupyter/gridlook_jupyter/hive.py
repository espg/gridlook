"""``/gridlook/hive/``: moczarr-backed virtual store — one flat zarr per ``open_hive()`` view.

Phase 6d of the viewer plan (espg/gridlook#1): the hub-side answer to "a hive
store is many leaves, but gridlook expects ONE zarr source". ``GET
/gridlook/hive/open`` runs moczarr's ``open_hive()`` (product/AOI/window
selection) and MATERIALIZES the result into an in-memory zarr v3 store; ``GET
/gridlook/hive/<view-id>/<key>`` then serves that store's objects (metadata and
whole chunks — no Range support needed) to zarrita in the browser.

Views are served NATIVE (issue #8, phase 6 v2): the packed-u64 ``morton``
coordinate and the store's own morton ``dggs`` convention block pass through
unmodified, and the browser decodes words to NESTED cells itself. The pre-6c
compatibility shim that fabricated a ``cell_ids`` coordinate and rewrote the
served ``dggs`` attrs to claim ``name: "healpix"`` is retired; the committed
parity evidence (``tests/data/shim_parity_serc.json`` +
``tests/unit/lib/morton/shimParity.test.ts``) pins that the native decode
reproduces exactly the render inputs the shim used to serve.

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
#: as float64-exact JS Numbers in the browser (mirrors the frontend codec's
#: ``FLOAT64_EXACT_MAX_ORDER``, mortie spec §4 viewer cast). The browser's
#: word decode throws on deeper AREA stores; rejecting at open keeps that a
#: clean 422 instead of a mid-render error.
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


class ViewEmptyError(Exception):
    """Raised when a selection covers no cells at all.

    moczarr answers an AOI that intersects nothing with a schema-correct
    0-cell dataset (a warning, not an exception), but a 0-cell view has
    nothing to render: the browser's word decode rejects an empty morton
    coordinate outright (``morton coordinate is empty``, ``src/lib/morton/
    cells.ts``). Both sides refuse it; refusing here first turns a blank globe
    into a 422 that names the selection to widen.
    """

    def __init__(self, aoi: tuple[str, ...] | None, window: str | None):
        self.aoi = aoi
        self.window = window


class ViewNotFloat64ExactError(Exception):
    """Raised when a view's NESTED decode would exceed the float64-exact range.

    The browser holds decoded cell ids as float64 Numbers, so an AREA store
    above ``_FLOAT64_EXACT_MAX_ORDER`` (order 24) cannot render — reject at
    open rather than serve it. POINT-kind words clip to order 24 in the
    browser's decode and are fine (see :func:`_check_float64_exact`).
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


def _check_float64_exact(morton_words, cell_order: int) -> None:
    """Reject a view whose NESTED decode the browser cannot hold as float64.

    The browser decodes the served words itself (mortie spec §4 viewer cast):
    POINT-kind words clip to :data:`_FLOAT64_EXACT_MAX_ORDER`, so a pure point
    store renders at order 24 whatever its manifest declares; AREA words never
    clip, so an area store above order 24 — or a mixed store whose real
    order-29 areas would ride past the point clip — cannot be rendered.
    Rejecting here keeps that a clean 422 at open instead of a browser-side
    decode error at render time.
    """
    import numpy as np
    from moczarr.convention import is_point_word

    words = np.asarray(morton_words, dtype=np.uint64).ravel()
    if not words.size:
        # Nothing to decode; emptiness is :class:`ViewEmptyError`'s business
        # (raised in build_view), not this guard's. numpy's ``all()`` is
        # vacuously True on an empty array, and forcing it to False here used
        # to 422 an empty selection over an order-29 store while the same
        # empty selection over an order-8 store served a 200.
        return
    all_point = bool(np.asarray(is_point_word(words)).all())
    order = _FLOAT64_EXACT_MAX_ORDER if all_point else int(cell_order)
    if order > _FLOAT64_EXACT_MAX_ORDER:
        raise ViewNotFloat64ExactError(int(cell_order))


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
        # Native serve (issue #8): the browser decodes the packed-u64 morton
        # coordinate itself — no fabricated NESTED cell_ids view.
        fabricate_cell_ids=False,
    )
    dim = ds["morton"].dims[0] if "morton" in ds.coords else "cells"
    cells = int(ds.sizes.get(dim, 0))
    if cells == 0:
        # An AOI/window that intersects no coverage: moczarr warns and returns
        # a schema-correct empty dataset, but nothing downstream can render it.
        raise ViewEmptyError(aoi, window)
    if cells > max_cells:
        raise ViewTooLargeError(cells)
    cell_order = int(ds.attrs["morton_hive"]["cell_order"])
    _check_float64_exact(ds["morton"].values, cell_order)
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
            except ViewEmptyError as e:
                parts = [f"aoi={','.join(e.aoi)}"] if e.aoi else []
                if e.window:
                    parts.append(f"window={e.window}")
                selection = ", ".join(parts) or "the whole store"
                raise web.HTTPError(
                    422,
                    f"hive selection covers 0 cells ({selection}): there is nothing "
                    f"to render, and the browser rejects an empty morton coordinate "
                    f"— widen or drop the aoi=/window= selection",
                ) from e
            except ViewNotFloat64ExactError as e:
                raise web.HTTPError(
                    422,
                    f"hive store cell_order {e.order} exceeds order "
                    f"{_FLOAT64_EXACT_MAX_ORDER}: its NESTED decode is above the "
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
