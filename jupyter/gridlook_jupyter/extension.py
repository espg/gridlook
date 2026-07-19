"""Wires the gridlook routes into a running jupyter-server."""

import re
from pathlib import Path

from jupyter_server.base.handlers import AuthenticatedFileHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .config import GridlookProxy
from .handlers import HealthHandler, S3ProxyHandler


def load_extension(serverapp):
    proxy = GridlookProxy(parent=serverapp)
    static_dir = proxy.static_dir
    if not (Path(static_dir) / "index.html").exists():
        serverapp.log.warning(
            "gridlook-jupyter: no built SPA at %s — /gridlook/ will 404. "
            "Install from a wheel, or set GridlookProxy.static_dir to a gridlook dist/.",
            static_dir,
        )

    base = url_path_join(serverapp.base_url, "gridlook")
    escaped = re.escape(base)
    handlers = [
        (escaped + r"/api/health", HealthHandler),
        (escaped + r"/s3/([^/]+)/(.+)", S3ProxyHandler),
        # /gridlook/hive/... is RESERVED: phase 6 mounts the moczarr virtual-store
        # endpoint there (an open_hive() AOI served as one flat zarr store).
        # Do not claim that namespace with other routes.
        (escaped + r"$", web.RedirectHandler, {"url": base + "/"}),
        (
            escaped + r"/(.*)",
            AuthenticatedFileHandler,
            {"path": static_dir, "default_filename": "index.html"},
        ),
    ]
    serverapp.web_app.settings["gridlook_proxy"] = proxy
    serverapp.web_app.add_handlers(".*$", handlers)
    serverapp.log.info(
        "gridlook-jupyter loaded: app at %s/, proxy %s",
        base,
        f"enabled for buckets {proxy.allowed_buckets}" if proxy.enabled else "disabled",
    )
