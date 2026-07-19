# gridlook-jupyter

A jupyter-server extension that serves the built [gridlook](../README.md) viewer inside a
JupyterHub/Jupyter environment, plus a **streaming S3 byte-range proxy** so the browser can read
private buckets through the hub's credentials — credentials never reach the browser, and the
buckets never need to be public. Phase 4 of the viewer plan
([espg/gridlook#1](https://github.com/espg/gridlook/issues/1)).

The primary deployment target is [CryoCloud](https://cryointhecloud.com/) (a 2i2c-operated
JupyterHub): the hub role holds the S3 read credentials, and gridlook runs against buckets that
are hub-viewable but not public (e.g. zagg output stores — see englacial/zagg#301 for the
cost-visualization use case).

## Install

```bash
pip install ./jupyter        # from a gridlook checkout — needs node >= 24 on PATH
# or
pip install gridlook_jupyter-<version>-py3-none-any.whl
```

The wheel embeds the built Vite app as package data. **Building the wheel requires node/npm**
(the build hook runs `npm ci && npm run build` at the repo root and copies `dist/` into the
wheel); installing a pre-built wheel does not. The extension auto-enables on install via
`jupyter_server_config.d`.

Editable installs (`pip install -e ./jupyter`) skip the frontend build — point
`GridlookProxy.static_dir` at a locally built `dist/` instead (see below).

## Launch

There is no launcher card yet (that is phase 5). Open the app by URL:

```
<your-server-base>/gridlook/
```

e.g. on a hub: `https://hub.example.org/user/<you>/gridlook/`.

## Routes

| Route                         | What                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/gridlook/`                  | the static gridlook SPA                                                                                                                 |
| `/gridlook/api/health`        | tiny JSON probe (`{"extension": "gridlook-jupyter", ...}`)                                                                              |
| `/gridlook/s3/<bucket>/<key>` | streaming S3 proxy — GET/HEAD only, `Range` pass-through (206), no LIST                                                                 |
| `/gridlook/hive/…`            | **reserved** for the phase-6 moczarr virtual-store endpoint (an `open_hive()` AOI served as one flat zarr store) — not implemented here |

## Configuration

Allowlist-only auth: **the proxy is disabled until you configure buckets.** Requests for
non-allowlisted buckets get a 403 naming the bucket; with an empty allowlist every proxy request
gets a 403 saying the proxy is disabled.

Via traitlets (`jupyter_server_config.py`, or `--GridlookProxy.…` on the command line):

```python
c.GridlookProxy.allowed_buckets = ["my-zagg-outputs"]
c.GridlookProxy.region = "us-west-2"          # optional; ambient AWS config otherwise
c.GridlookProxy.static_dir = "/path/to/dist"  # optional; dev override for the SPA files
```

Or environment variables (used only when the trait is not configured):

```bash
export GRIDLOOK_ALLOWED_BUCKETS="my-zagg-outputs,another-bucket"
export GRIDLOOK_S3_REGION="us-west-2"
```

S3 credentials come from the ambient chain (instance/pod role, `AWS_*` env, shared config) —
the standard hub setup. The proxy streams responses chunk-by-chunk and never buffers whole
objects; there are no presigned URLs, so nothing credential-shaped is ever exposed to the
browser.

## `s3://` inputs in the app

When the SPA is served under `/gridlook/` (it detects this by probing `api/health`), pasting an
`s3://bucket/prefix` dataset URL rewrites it to the proxy path (`…/gridlook/s3/bucket/prefix`)
automatically. Served standalone (dev server, static hosting), `s3://` inputs are left
untouched. Pasting the proxy URL directly always works.

## Development

```bash
cd jupyter
uv venv && uv pip install -e ".[test]" ruff
.venv/bin/pytest tests -v
.venv/bin/ruff check gridlook_jupyter tests hatch_build.py
# run against a dev-built frontend:
npm run build   # at the repo root
jupyter server --GridlookProxy.static_dir="$(pwd)/../dist" --GridlookProxy.allowed_buckets='["my-bucket"]'
```

Tests exercise the proxy against an obstore `LocalStore` via the `GridlookProxy.store_factory`
seam — no real S3 needed.
