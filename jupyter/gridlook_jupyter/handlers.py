"""Tornado handlers: health endpoint and the streaming S3 byte-range proxy."""

import json
import mimetypes
import re

import obstore
from jupyter_server.base.handlers import JupyterHandler
from obstore.exceptions import BaseError, NotFoundError
from tornado import web

from . import __version__
from .config import GridlookProxy

#: Single-range "bytes=" header; multi-range is not supported (RFC 9110 permits
#: ignoring the Range header, in which case the full object is served with 200).
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

_STREAM_CHUNK = 256 * 1024


def parse_range_header(header: str):
    """Map a single-range ``Range`` header to obstore get options, or None to ignore it."""
    m = _RANGE_RE.match(header.strip())
    if m is None:
        return None
    start, end = m.groups()
    if start and end:
        if int(end) < int(start):
            return None
        return (int(start), int(end) + 1)  # inclusive -> exclusive
    if start:
        return {"offset": int(start)}
    if end:
        return {"suffix": int(end)}
    return None


def _content_type(key: str, attributes=None) -> str:
    """Pass through the object's content-type when the store reports one, else guess."""
    try:
        for k, v in dict(attributes or {}).items():
            if str(k).lower().replace("_", "-") == "content-type":
                return str(v)
    except (TypeError, ValueError):
        pass
    guess, _ = mimetypes.guess_type(key)
    return guess or "application/octet-stream"


class HealthHandler(JupyterHandler):
    """Tiny probe endpoint; the SPA uses it to detect extension-served context."""

    @web.authenticated
    async def get(self):
        proxy: GridlookProxy = self.settings["gridlook_proxy"]
        self.set_header("Content-Type", "application/json")
        self.finish(
            json.dumps(
                {
                    "extension": "gridlook-jupyter",
                    "version": __version__,
                    "proxy_enabled": proxy.enabled,
                }
            )
        )


class S3ProxyHandler(JupyterHandler):
    """Streaming byte-range proxy: GET/HEAD only, no LIST, hub-side credentials only."""

    SUPPORTED_METHODS = ("GET", "HEAD")

    def write_error(self, status_code, **kwargs):
        exc = kwargs.get("exc_info", (None, None, None))[1]
        message = ""
        if isinstance(exc, web.HTTPError) and exc.log_message:
            message = exc.log_message
        self.set_header("Content-Type", "text/plain; charset=utf-8")
        self.finish(message or f"error {status_code}")

    def _store_for(self, bucket: str):
        proxy: GridlookProxy = self.settings["gridlook_proxy"]
        if not proxy.enabled:
            raise web.HTTPError(
                403,
                "gridlook S3 proxy is disabled: no allowed buckets are configured. "
                "Set GridlookProxy.allowed_buckets (or GRIDLOOK_ALLOWED_BUCKETS).",
            )
        if bucket not in proxy.allowed_buckets:
            raise web.HTTPError(
                403,
                f"bucket '{bucket}' is not in the gridlook proxy allowlist "
                f"(GridlookProxy.allowed_buckets)",
            )
        return proxy.get_store(bucket)

    @web.authenticated
    async def get(self, bucket, key):
        store = self._store_for(bucket)
        range_header = self.request.headers.get("Range")
        rng = parse_range_header(range_header) if range_header else None
        options = {"range": rng} if rng is not None else {}
        try:
            result = await obstore.get_async(store, key, options=options)
        except (NotFoundError, FileNotFoundError) as e:
            raise web.HTTPError(404, f"no such object: s3://{bucket}/{key}") from e
        except ValueError as e:
            # obstore's path parser rejects malformed keys (``..``, empty segments)
            # before any I/O; that is a bad client request, not a server fault.
            raise web.HTTPError(400, f"invalid key: {key}") from e
        except (BaseError, OSError) as e:
            # Includes out-of-bounds ranges; obstore surfaces them as generic errors.
            raise web.HTTPError(502, f"S3 error for s3://{bucket}/{key}: {e}") from e

        size = result.meta["size"]
        start, end = result.range
        self.set_header("Accept-Ranges", "bytes")
        self.set_header("Content-Type", _content_type(key, result.attributes))
        self.set_header("Content-Length", str(end - start))
        etag = result.meta.get("e_tag")
        if etag:
            self.set_header("Etag", etag)
        if rng is not None:
            self.set_status(206)
            self.set_header("Content-Range", f"bytes {start}-{end - 1}/{size}")
        # Stream chunk-by-chunk; never buffer whole objects.
        async for chunk in result.stream(min_chunk_size=_STREAM_CHUNK):
            self.write(bytes(chunk))
            await self.flush()

    @web.authenticated
    async def head(self, bucket, key):
        store = self._store_for(bucket)
        try:
            meta = await obstore.head_async(store, key)
        except (NotFoundError, FileNotFoundError) as e:
            raise web.HTTPError(404, f"no such object: s3://{bucket}/{key}") from e
        except ValueError as e:
            raise web.HTTPError(400, f"invalid key: {key}") from e
        except (BaseError, OSError) as e:
            raise web.HTTPError(502, f"S3 error for s3://{bucket}/{key}: {e}") from e
        self.set_header("Accept-Ranges", "bytes")
        self.set_header("Content-Type", _content_type(key))
        self.set_header("Content-Length", str(meta["size"]))
        etag = meta.get("e_tag")
        if etag:
            self.set_header("Etag", etag)
