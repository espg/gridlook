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
| `/gridlook/hive/open`         | open (or LRU-refresh) a **morton-hive virtual-store view** via moczarr — see below                                                      |
| `/gridlook/hive/<view>/<key>` | serve one zarr object (metadata / whole chunk) of an open view                                                                          |

## Configuration

Allowlist-only auth: **the proxy is disabled until you configure buckets.** Requests for
non-allowlisted buckets get a 403 naming the bucket; with an empty allowlist every proxy request
gets a 403 saying the proxy is disabled.

Via traitlets (`jupyter_server_config.py`, or `--GridlookProxy.…` on the command line):

```python
c.GridlookProxy.allowed_buckets = ["my-zagg-outputs"]
c.GridlookProxy.region = "us-west-2"          # optional; ambient AWS config otherwise
c.GridlookProxy.static_dir = "/path/to/dist"  # optional; dev override for the SPA files

# /gridlook/hive/ knobs (phase 6d; defaults shown)
c.GridlookProxy.hive_max_views = 8            # LRU bound on materialized views
c.GridlookProxy.hive_max_cells = 500_000      # per-view cell bound; 413 beyond
c.GridlookProxy.hive_max_concurrent_builds = 2  # concurrent materializations; over-limit opens queue
c.GridlookProxy.local_hive_store_roots = []   # allowed roots for local-path stores (dev only)
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

## Morton-hive virtual store (`/gridlook/hive/`)

Phase 6d of the viewer plan: a zagg **morton-hive** store is many leaf zarrs, but gridlook
expects one zarr source — and post-englacial/zagg#314 stores are **morton-only**, so gridlook's
existing HEALPix path (which consumes NESTED `cell_ids`) cannot read a leaf directly. The hive
endpoint closes both gaps hub-side with [moczarr](https://github.com/espg/moczarr):
`open_hive()` selects a product/AOI/window, **fabricates the exact NESTED `cell_ids`
coordinate**, and the extension serves the result as **one flat zarr v3 store** the browser's
unmodified zarrita reads.

```
GET /gridlook/hive/open?store=<url>[&product=<name>][&aoi=<decimal,csv>][&window=<label>]
  -> {"view": "<id>", "url": ".../gridlook/hive/<id>", "cells": N, "cell_order": K, "cached": false}
GET /gridlook/hive/<view>/<zarr-key>      # zarr.json documents and whole chunks
```

- `store` — hive store root: `s3://bucket/prefix` (bucket must be allowlisted, same posture as
  the S3 proxy) or a local path whose realpath is contained in one of
  `GridlookProxy.local_hive_store_roots` (empty by default — local stores disabled; dev/tests).
- `product` — named product root under a multi-product store (zagg D19).
- `aoi` — comma-separated morton decimals (mixed orders fine); omit for the whole store.
- `window` — window label on a time-windowed (`morton-hive/2`) store.

Views are **materialized on open** into an in-memory zarr store and held in a per-server LRU
cache: `GridlookProxy.hive_max_views` (default 8) bounds the cache, and
`GridlookProxy.hive_max_cells` (default 500 000) bounds a single view — an over-size selection
gets a 413 telling you to narrow the AOI. Re-opening the same selection refreshes the existing
view; evicted view URLs 404 until re-opened. Materialize-on-open keeps the serve path free of
zarr chunk/codec arithmetic; a streaming/virtual encoding is the future optimization if views
outgrow memory.

The served attrs carry a **pre-6c compatibility shim**: gridlook's grid detector currently
accepts only `dggs.name == "healpix"`, so the view advertises the healpix-shaped block with
`coordinate: "cell_ids"` + `refinement_level` — the fabricated NESTED ids are plain HEALPix
NESTED indices, exactly what the existing sparse-HEALPix render path consumes. When phase 6c
teaches the detector the morton convention entry, the shim goes away.

### CryoCloud MVP recipe: render a hive store

```bash
# 1. install the extension wheel plus the hive extra (moczarr; git source until PyPI)
pip install gridlook_jupyter-<version>-py3-none-any.whl "gridlook-jupyter[hive]"
# 2. allowlist the bucket holding the store (or use env GRIDLOOK_ALLOWED_BUCKETS)
#    e.g. in jupyter_server_config.py: c.GridlookProxy.allowed_buckets = ["my-zagg-outputs"]
#    ...then restart your server so the extension picks it up.
```

3. Open a view (in a notebook, `requests.get(...)`, or just a browser tab):
   `https://<hub>/user/<you>/gridlook/hive/open?store=s3://my-zagg-outputs/store-root&aoi=4331422`
4. Copy the returned `url`, open the app at `https://<hub>/user/<you>/gridlook/`, and paste the
   view URL as the dataset source. The view renders through the existing HEALPix path.

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

The hive tests run against moczarr's committed SERC fixture and need moczarr importable from a
**repo checkout** (so the fixture sits next to the package): `uv pip install -e
/path/to/moczarr` (or set `GRIDLOOK_MOCZARR_TESTDATA` to a checkout's `tests/data`). Without
moczarr the hive suite skips.
