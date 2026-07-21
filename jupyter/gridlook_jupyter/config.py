"""Traitlets config surface for the gridlook extension."""

import os
from pathlib import Path

from traitlets import Int, List, Unicode, default
from traitlets.config import Configurable

#: Bounded per-process cache of bucket -> store (buckets come from the allowlist,
#: so this stays tiny; the bound is belt-and-braces).
_MAX_CACHED_STORES = 64


def default_store_factory(bucket: str, region: str | None):
    """Build an obstore store for *bucket* using the ambient AWS credential chain."""
    from obstore.store import S3Store

    kwargs = {"region": region} if region else {}
    return S3Store(bucket, **kwargs)


class GridlookProxy(Configurable):
    """Config for the gridlook S3 proxy (jupyter_server_config / CLI / env)."""

    allowed_buckets = List(
        Unicode(),
        help=(
            "Buckets the proxy may read from. Empty (the default) disables the "
            "proxy entirely. Env fallback: GRIDLOOK_ALLOWED_BUCKETS (comma-separated), "
            "used only when this trait is not configured."
        ),
    ).tag(config=True)

    region = Unicode(
        "",
        help=(
            "AWS region for the S3 stores. Empty defers to the ambient AWS "
            "configuration. Env fallback: GRIDLOOK_S3_REGION."
        ),
    ).tag(config=True)

    static_dir = Unicode(
        "",
        help=(
            "Directory holding the built gridlook SPA. Defaults to the static/ "
            "directory packaged in the wheel; point it at a repo dist/ for development."
        ),
    ).tag(config=True)

    local_hive_store_roots = List(
        Unicode(),
        help=(
            "Root directories under which /gridlook/hive/open may open local "
            "filesystem hive stores (development/tests). Empty (the default) "
            "disables local stores entirely; a requested path is accepted only "
            "when its realpath is contained in one of these (also realpath'd) "
            "roots, so 'dev' can't become whole-filesystem reach. s3:// stores "
            "are always gated by allowed_buckets instead. Env fallback: "
            "GRIDLOOK_LOCAL_HIVE_STORE_ROOTS (comma-separated)."
        ),
    ).tag(config=True)

    hive_max_views = Int(
        8,
        help=(
            "Maximum materialized hive views held per server process; opening "
            "beyond it evicts the least-recently-used view (its /gridlook/hive/ "
            "URLs then 404 until re-opened)."
        ),
    ).tag(config=True)

    hive_max_cells = Int(
        500_000,
        help=(
            "Maximum cells a single hive view may materialize; /gridlook/hive/open "
            "returns 413 beyond it. Views are held in memory (~100 B/cell at "
            "typical zagg variable counts), so hive_max_views * hive_max_cells "
            "bounds the RESIDENT cache footprint."
        ),
    ).tag(config=True)

    hive_max_concurrent_builds = Int(
        2,
        help=(
            "Maximum hive views materialized concurrently. Each in-flight open "
            "holds its xarray dataset plus a MemoryStore copy transiently, ON TOP "
            "of the resident cache, so a burst of opens can exceed the resident "
            "bound; this caps that transient peak. Over-limit opens QUEUE (they "
            "wait, they are not rejected)."
        ),
    ).tag(config=True)

    @default("local_hive_store_roots")
    def _default_local_hive_store_roots(self):
        env = os.environ.get("GRIDLOOK_LOCAL_HIVE_STORE_ROOTS", "")
        return [r.strip() for r in env.split(",") if r.strip()]

    @default("allowed_buckets")
    def _default_allowed_buckets(self):
        env = os.environ.get("GRIDLOOK_ALLOWED_BUCKETS", "")
        return [b.strip() for b in env.split(",") if b.strip()]

    @default("region")
    def _default_region(self):
        return os.environ.get("GRIDLOOK_S3_REGION", "")

    @default("static_dir")
    def _default_static_dir(self):
        return str(Path(__file__).parent / "static")

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Seam for tests: swap in e.g. an obstore LocalStore factory so the
        # proxy can be exercised without real S3. Plain attribute, not a trait.
        self.store_factory = default_store_factory
        self._stores: dict[str, object] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.allowed_buckets)

    def get_store(self, bucket: str):
        """Return (building if needed) the store for an allowlisted bucket."""
        if bucket not in self._stores:
            if len(self._stores) >= _MAX_CACHED_STORES:
                self._stores.clear()
            self._stores[bucket] = self.store_factory(bucket, self.region or None)
        return self._stores[bucket]
