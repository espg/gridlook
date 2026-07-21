"""Traitlets config surface for the gridlook extension."""

import os
from pathlib import Path

from traitlets import Bool, Int, List, Unicode, default
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

    allow_local_hive_stores = Bool(
        False,
        help=(
            "Allow /gridlook/hive/open to open hive stores from local filesystem "
            "paths (development/tests). s3:// stores are always gated by "
            "allowed_buckets. Env fallback: GRIDLOOK_ALLOW_LOCAL_HIVE_STORES=1."
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
            "bounds the cache footprint."
        ),
    ).tag(config=True)

    @default("allow_local_hive_stores")
    def _default_allow_local_hive_stores(self):
        return os.environ.get("GRIDLOOK_ALLOW_LOCAL_HIVE_STORES", "").strip().lower() in (
            "1",
            "true",
            "yes",
        )

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
