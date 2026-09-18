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

With ``cell_order=`` the open runs moczarr's ``open_level()`` instead, serving
ONE stamped pyramid level of the store (espg/gridlook#10's zoom-driven order
selection reads a level per zoom); every view drops the variables the renderer
cannot cast (:func:`renderable_variables`) and is written with consolidated
metadata, which is the only way the SPA enumerates a store's variables.

Materialize-on-demand, deliberately: views are AOI-scale and bounded
(``GridlookProxy.hive_max_cells``, 413 beyond) and materializing keeps this
module free of zarr chunk/codec arithmetic (xarray writes the store; we serve
opaque objects). A view is built on the first request that needs its bytes —
``/hive/open`` builds eagerly, a catalog entry (:mod:`.catalog`) only reserves
its recipe and the first object request builds it — and a view id's recipe
outlives its materialization, so an evicted URL rebuilds transparently instead
of dying. A streaming/virtual encoding — computing zarr objects on demand from
the open dataset — is the future optimization if views ever outgrow memory; the
URL contract here would not change.

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
#: word decode throws on deeper AREA stores; rejecting at open (see
#: :func:`_check_renderable`) keeps that a clean 422 instead of a mid-render
#: error.
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

    The browser holds decoded cell ids as float64 Numbers, so an AREA view
    whose words decode above ``_FLOAT64_EXACT_MAX_ORDER`` (order 24) cannot
    render — reject at open rather than serve it. The order is read off the
    served WORDS (:func:`_word_orders`), not off the manifest, so a store that
    under-declares ``cell_order`` is caught too.
    """

    def __init__(self, order: int, declared: int):
        self.order = order
        self.declared = declared


class ViewPointKindError(Exception):
    """Raised when a view carries POINT-kind words (spec §4 suffix band 48..63).

    A point word clips to order 24 in the browser's viewer cast, i.e. nside
    ``2**24`` and ~0.4 m cells: the sparse healpix texture is sized to the
    bounding box of the in-face cells, so a degree-wide point selection asks
    for ~1e11 texels, and the 29 → 24 clip can collapse distinct observations
    onto one cell. ``Healpix.vue`` refuses such a coordinate for exactly these
    reasons; this is the same refusal one hop earlier.
    """

    def __init__(self, points: int, cells: int):
        self.points = points
        self.cells = cells


class ViewMixedOrderError(Exception):
    """Raised when a view's AREA words do not all decode to one HEALPix order.

    A healpix grid renders a single nside, so the browser's ``decodeMortonCells``
    rejects a mixed-order coordinate outright (``mixed morton orders in one
    coordinate``). Same verdict here, one hop earlier.
    """

    def __init__(self, low: int, high: int):
        self.low = low
        self.high = high


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
    #: Pyramid level (a manifest ``cell_orders`` entry) when the view is a ladder
    #: rung opened via ``moczarr.open_level`` rather than the native leaf cells.
    level: int | None = field(default=None)


@dataclass(frozen=True)
class ViewSpec:
    """Everything ``build_view`` needs — a view id's recipe, kept after eviction."""

    root: str
    store_url: str
    product: str | None
    window: str | None
    aoi: tuple[str, ...] | None
    level: int | None


#: Bound on remembered view recipes (a few hundred bytes each): least-recently-used
#: beyond it — recipes are refreshed by *use* (``reserve``, and every ``get``/
#: ``ensure`` hit), so a recipe never expires out from under a served view.
_MAX_SPECS = 1024


class HiveViewCache:
    """LRU-bounded ``view-id -> HiveView`` map, one per server process.

    View ids are deterministic over the request tuple, so re-opening the same
    selection refreshes (LRU-bumps) the existing view instead of duplicating
    it; serving a view's objects bumps it too, so actively rendered views
    survive. Views are re-materialized only after eviction.

    A view's *recipe* (:class:`ViewSpec`) is remembered separately from its
    materialization: ``reserve`` records one without building anything, and
    ``ensure`` materializes on first demand — how the per-order catalog lists
    every level without opening them, and how an evicted view's URL keeps
    working (it rebuilds on the next object request). Concurrent demands for
    one id coalesce on a single build.
    """

    def __init__(self, proxy: GridlookProxy):
        self._proxy = proxy
        self._views: OrderedDict[str, HiveView] = OrderedDict()
        self._specs: OrderedDict[str, ViewSpec] = OrderedDict()
        self._building: dict[str, asyncio.Future] = {}

    @staticmethod
    def view_id(
        store_url: str,
        product: str | None,
        window: str | None,
        aoi: tuple[str, ...] | None,
        level: int | None = None,
    ) -> str:
        # Canonicalize so selections that name the SAME data collapse to one id
        # (one materialization, one LRU slot): strip the store's trailing slash
        # (build_view rstrips it for the data path anyway), normalize empty
        # params to absent, and sort+dedupe the aoi tokens (order and repeats
        # don't change the cover).
        aoi_canon = sorted({int(t) for t in aoi}) if aoi else None
        payload = json.dumps(
            [store_url.rstrip("/"), product or None, window or None, aoi_canon, level],
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()[:_VIEW_ID_HEX]

    def get(self, view_id: str) -> HiveView | None:
        view = self._views.get(view_id)
        if view is not None:
            self._views.move_to_end(view_id)
            self._touch_spec(view_id)
        return view

    def _touch_spec(self, view_id: str) -> None:
        """Refresh a recipe's LRU position: serving a view keeps it rebuildable.

        Without this the recipe table ages on *reserve* alone, so a hot view's
        recipe could be evicted while the view is still resident — and its URL
        would then 404 forever the moment the view itself fell out of
        ``_views``, which is exactly what reserve/ensure exists to prevent.
        """
        if view_id in self._specs:
            self._specs.move_to_end(view_id)

    def put(self, view_id: str, view: HiveView) -> None:
        self._views[view_id] = view
        self._views.move_to_end(view_id)
        while len(self._views) > max(1, self._proxy.hive_max_views):
            self._views.popitem(last=False)

    def reserve(self, spec: ViewSpec) -> str:
        """Record *spec* under its id without materializing; return the id."""
        view_id = self.view_id(spec.store_url, spec.product, spec.window, spec.aoi, spec.level)
        self._specs[view_id] = spec
        self._specs.move_to_end(view_id)
        while len(self._specs) > _MAX_SPECS:
            self._specs.popitem(last=False)
        return view_id

    def spec(self, view_id: str) -> ViewSpec | None:
        return self._specs.get(view_id)

    async def ensure(self, view_id: str) -> tuple[HiveView, bool]:
        """The materialized view for a reserved id, building it on first demand.

        Returns ``(view, cached)``. Raises ``KeyError`` for an id never
        reserved; build failures surface as the ``web.HTTPError`` the open
        route would have raised, to every coalesced waiter alike. Cancellation
        is per-task: a cancelled waiter leaves the shared build (and the other
        waiters) untouched, and a cancelled builder hands its waiters a 503.
        """
        view = self.get(view_id)
        if view is not None:
            return view, True
        pending = self._building.get(view_id)
        if pending is not None:
            # shield: awaiting a bare future makes the WAITER's cancellation
            # cancel the future itself (Task.cancel cancels what it awaits),
            # which would break the build for the builder and every other
            # waiter. Shielded, a cancelled waiter takes only itself down.
            return await asyncio.shield(pending), False  # in flight, not yet a cache hit
        spec = self._specs.get(view_id)
        if spec is None:
            raise KeyError(view_id)
        self._touch_spec(view_id)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._building[view_id] = fut
        try:
            view = await _materialize(self._proxy, spec)
        except asyncio.CancelledError:
            # The BUILDER was cancelled (shutdown, a timeout wrapper). Publishing
            # CancelledError would read as each waiter's own cancellation and
            # kill them silently; hand them a retryable 503 and let our own
            # cancellation propagate.
            self._publish(fut, web.HTTPError(503, "the hive view build was cancelled — retry"))
            raise
        except BaseException as e:
            self._publish(fut, e)
            raise
        else:
            self.put(view_id, view)
            if not fut.done():
                fut.set_result(view)
            return view, False
        finally:
            self._building.pop(view_id, None)

    @staticmethod
    def _publish(fut: asyncio.Future, error: BaseException) -> None:
        """Hand *error* to the coalesced waiters, if the future is still open."""
        if fut.done():
            return
        fut.set_exception(error)
        fut.exception()  # retrieved: no "never retrieved" noise when nobody waits


def _word_orders(words):
    """Per-word HEALPix order from the 6-bit suffix (mortie spec §1 table).

    Suffix ``0..=27`` is the order itself; ``28..=47`` is the order-28/29 area
    preorder (``(suffix - 28) % 5 == 0`` is the order-28 parent, its four
    children are order 29); ``48..=63`` is the order-29 point band. Pure bit
    arithmetic, mirroring ``orderOf`` in ``src/lib/morton/word.ts`` — the two
    sides must read the suffix table identically, and a test cross-checks this
    against ``mortie.orders_of`` over all 64 suffix values.
    """
    import numpy as np

    suffix = (np.asarray(words, dtype=np.uint64) & np.uint64(0x3F)).astype(np.int64)
    tail = np.where((suffix - 28) % 5 == 0, 28, 29)
    return np.where(suffix <= 27, suffix, np.where(suffix < 48, tail, 29))


def _check_renderable(morton_words, cell_order: int) -> None:
    """Reject a view the browser's word decode and render path cannot handle.

    Everything here is read off the served WORDS, never off the manifest — a
    store that under-declares ``cell_order`` must not sail through. Three
    refusals, each mirroring one the browser makes (and each its own 422, since
    they tell the caller different things):

    * POINT-kind words (spec §4) — :class:`ViewPointKindError`; they clip to
      order 24, i.e. nside ``2**24``, which no healpix texture can rasterize.
      This also covers a mixed point/area view at ANY order, which decodes to
      two orders browser-side.
    * AREA words at more than one order — :class:`ViewMixedOrderError`; a
      healpix grid renders a single nside.
    * AREA words above :data:`_FLOAT64_EXACT_MAX_ORDER` —
      :class:`ViewNotFloat64ExactError`; their NESTED ids exceed ``2**53``.

    Emptiness is not this guard's business (see :class:`ViewEmptyError`).
    """
    import numpy as np
    from moczarr.convention import is_point_word

    words = np.asarray(morton_words, dtype=np.uint64).ravel()
    if not words.size:
        # Nothing to decode. numpy's ``all()`` is vacuously True on an empty
        # array, and forcing it to False here used to 422 an empty selection
        # over an order-29 store while the same empty selection over an
        # order-8 store served a 200.
        return
    points = np.asarray(is_point_word(words))
    if points.any():
        raise ViewPointKindError(int(points.sum()), int(words.size))
    orders = _word_orders(words)
    low, high = int(orders.min()), int(orders.max())
    if low != high:
        raise ViewMixedOrderError(low, high)
    if high > _FLOAT64_EXACT_MAX_ORDER:
        raise ViewNotFloat64ExactError(high, int(cell_order))


def renderable_variables(ds) -> list[str]:
    """The data variables of *ds* the SPA can render, in dataset order.

    The SPA renders a variable by casting it to Float32
    (``castDataVarToFloat32``, ``Float32Array.from(rawData)``), so a view
    serves floats of any width plus integers of at most 32 bits.
    ``Float32Array.from`` handles a ``Float64Array`` fine; what it throws on is
    the BigInt-backed arrays zarrita hands back for int64/uint64 ("Cannot
    convert a BigInt value to a number") — the packed ``composition`` word and
    any int64. Ragged t-digests are bytes the browser never reads (and at CA
    scale the bulk of a level — they turned a whole-store open into a GB-scale
    crawl); bool, datetime64 and strings are dropped with them, as zarrita
    gives those non-numeric element types. The ``morton`` coordinate is not a
    data variable and is kept by the caller — the browser decodes it itself.
    """
    return [
        v
        for v in ds.data_vars
        if ds[v].dtype.kind == "f" or (ds[v].dtype.kind in "iu" and ds[v].dtype.itemsize <= 4)
    ]


def build_view(
    root: str,
    *,
    store_url: str,
    product: str | None,
    aoi: tuple[str, ...] | None,
    window: str | None,
    max_cells: int,
    level: int | None = None,
    region: str | None = None,
    anonymous: bool = False,
) -> HiveView:
    """Open a hive selection and materialize it as an in-memory zarr store.

    Synchronous and potentially slow (S3 GETs, concat) — the handler runs it
    on the executor, off the event loop. ``region``/``anonymous`` are the
    proxy's S3 posture, forwarded to moczarr's store construction so a public
    bucket needs no ``AWS_*`` environment (a local path ignores both).
    """
    import zarr
    from moczarr import open_hive

    store_kwargs: dict[str, Any] = {}
    if region:
        store_kwargs["region"] = region
    if anonymous:
        store_kwargs["anonymous"] = True
    if level is None:
        ds = open_hive(
            root,
            aoi=list(aoi) if aoi else None,
            window=window,
            # Native serve (issue #8): the browser decodes the packed-u64 morton
            # coordinate itself — no fabricated NESTED cell_ids view.
            fabricate_cell_ids=False,
            **store_kwargs,
        )
    else:
        from moczarr import open_level

        # A pyramid rung (zagg-pyramid/2 ladder or /1 overview): resolution is
        # the reader-facing axis, moczarr dispatches the artifact kind.
        # chunks=None keeps xarray's own lazy arrays (cubed/dask-free).
        ds = open_level(
            root,
            int(level),
            aoi=list(aoi) if aoi else None,
            window=window,
            fabricate_cell_ids=False,
            xr_kwargs={"chunks": None},
            **store_kwargs,
        )
        if ds is None:
            raise ValueError(f"level {level} has no stamped artifact in this store")
    ds = ds[renderable_variables(ds)]
    if not ds.data_vars:
        raise ValueError("no renderable (float, or <=32-bit integer) variable in this selection")
    dim = ds["morton"].dims[0] if "morton" in ds.coords else "cells"
    cells = int(ds.sizes.get(dim, 0))
    if cells == 0:
        # An AOI/window that intersects no coverage: moczarr warns and returns
        # a schema-correct empty dataset, but nothing downstream can render it.
        raise ViewEmptyError(aoi, window)
    if cells > max_cells:
        raise ViewTooLargeError(cells)
    # A level carries its own order in the zagg_level record; a source open has
    # no level record and the hive block carries it.
    order = (ds.attrs.get("zagg_level") or {}).get("cell_order")
    if order is None:
        order = ds.attrs["morton_hive"]["cell_order"]
    cell_order = int(order)
    _check_renderable(ds["morton"].values, cell_order)
    mem = zarr.storage.MemoryStore()
    # No compression: objects are served whole over hub-local HTTP, views are
    # session-scoped, and codec-free chunks keep the served bytes trivially
    # predictable (the tests compare them raw).
    encoding = {name: {"compressors": None} for name in list(ds.data_vars) + list(ds.coords)}
    # Consolidated: the SPA enumerates a store's variables ONLY through
    # consolidated metadata (zarrita withConsolidatedMetadata, v2 .zmetadata or
    # the v3 zarr.json block) — an unconsolidated v3 view is unlistable to it.
    ds.to_zarr(mem, mode="w", consolidated=True, zarr_format=3, encoding=encoding)
    return HiveView(
        store=mem,
        cells=cells,
        cell_order=cell_order,
        store_url=store_url,
        product=product,
        window=window,
        aoi=aoi,
        level=level,
    )


async def _materialize(proxy: GridlookProxy, spec: ViewSpec) -> HiveView:
    """Run ``build_view`` for *spec* off the loop, mapping failures to HTTP errors."""
    build = functools.partial(
        build_view,
        spec.root,
        store_url=spec.store_url,
        product=spec.product,
        aoi=spec.aoi,
        window=spec.window,
        max_cells=proxy.hive_max_cells,
        level=spec.level,
        region=proxy.region or None,
        anonymous=proxy.anonymous,
    )
    try:
        # Cap concurrent materializations (each holds ds + store copy
        # transiently); over-limit opens queue on acquire.
        async with _build_semaphore(proxy.hive_max_concurrent_builds):
            return await IOLoop.current().run_in_executor(None, build)
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
    except ViewPointKindError as e:
        raise web.HTTPError(
            422,
            f"hive view holds {e.points} POINT-kind words (of {e.cells} cells): "
            f"point observations clip to order {_FLOAT64_EXACT_MAX_ORDER} "
            f"(~0.4 m cells) in the browser's decode, which the healpix render "
            f"path cannot rasterize — open an aggregated (AREA) product or "
            f"pyramid level instead",
        ) from e
    except ViewMixedOrderError as e:
        raise web.HTTPError(
            422,
            f"hive view mixes morton orders ({e.low} and {e.high}): a healpix "
            f"grid renders a single order/nside, so the browser's decode rejects "
            f"it — narrow the aoi= to one order, or open one pyramid level",
        ) from e
    except ViewNotFloat64ExactError as e:
        raise web.HTTPError(
            422,
            f"hive view's words decode to order {e.order} (manifest cell_order "
            f"{e.declared}), above order {_FLOAT64_EXACT_MAX_ORDER}: those NESTED "
            f"ids are past the float64-exact integer range (2**53) the browser "
            f"holds cell ids in, so the view cannot be rendered — open a coarser "
            f"pyramid level",
        ) from e
    except FileNotFoundError as e:
        raise web.HTTPError(404, f"no hive store at {spec.store_url!r}: {e}") from e
    except ValueError as e:
        # moczarr's NoCoverageError (nothing committed anywhere) is a
        # ValueError subclass: the store exists but has nothing to
        # serve — 404, not a bad request.
        status = 404 if type(e).__name__ == "NoCoverageError" else 400
        raise web.HTTPError(status, f"cannot open {spec.store_url!r}: {e}") from e


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
    """``GET /gridlook/hive/open?store=…[&product=…][&aoi=…][&window=…][&cell_order=…]``.

    Creates (or LRU-refreshes) a view and returns its id plus the entry URL to
    paste into gridlook as a zarr dataset source. Without ``cell_order`` the
    view is the leaf selection; with it the view is that stamped pyramid level
    of the store (``open_level()``), whose own ``dggs`` block declares the
    level's order. Either way the view serves only
    ``renderable_variables(ds)`` plus the ``morton`` coordinate.
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
        raw_level = self.get_query_argument("cell_order", None) or None
        level = None
        if raw_level is not None:
            # ASCII-strict: isdigit() accepts "²" (int() then raises, 500) and
            # isdecimal() accepts "٣", which int() silently aliases to 3.
            if not re.fullmatch(r"[0-9]+", raw_level) or int(raw_level) > 29:
                raise web.HTTPError(400, f"cell_order {raw_level!r} is not a pyramid level")
            level = int(raw_level)
        root = _authorize_store_root(proxy, store_url, product)
        try:
            import moczarr  # noqa: F401
        except ImportError as e:
            raise web.HTTPError(
                500,
                "the /gridlook/hive/ endpoints need moczarr — install gridlook-jupyter[hive]",
            ) from e

        view_id = cache.reserve(
            ViewSpec(
                root=root,
                store_url=store_url,
                product=product,
                window=window,
                aoi=aoi,
                level=level,
            )
        )
        view, cached = await cache.ensure(view_id)

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
        try:
            # Reserved-but-unbuilt (a catalog entry) or evicted: materialize
            # on first demand; concurrent object requests share one build.
            view, _ = await cache.ensure(view_id)
        except KeyError:
            raise web.HTTPError(
                404,
                f"no hive view '{view_id}' (never opened) — open it via "
                f"/gridlook/hive/open or list it via /gridlook/hive/catalog",
            ) from None
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
        # A view id hashes the RECIPE, not the bytes: the same URL legitimately
        # serves different objects once the underlying store is re-swept (or a
        # rebuild picks up a level that has since landed), so intermediaries
        # must not pin them. Eviction costs a re-materialization, never a 404.
        self.set_header("Cache-Control", "no-store")
        self.finish(data)
