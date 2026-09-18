import json

import pytest
from tornado.httpclient import HTTPClientError


async def test_health(jp_fetch, proxy):
    resp = await jp_fetch("gridlook", "api", "health")
    assert resp.code == 200
    body = json.loads(resp.body)
    assert body["extension"] == "gridlook-jupyter"
    assert body["proxy_enabled"] is True


async def test_static_index_served(jp_fetch, proxy):
    resp = await jp_fetch("gridlook/")
    assert resp.code == 200
    assert b"gridlook test index" in resp.body


async def test_spa_csp_has_no_sandbox(jp_fetch, proxy, static_root):
    # AuthenticatedFileHandler's `sandbox allow-scripts` gives the document an
    # opaque origin (same-origin fetches fail CORS, IndexedDB is denied); the
    # SPA is served under jupyter's ordinary policy instead.
    (static_root / "app.js").write_text("console.log('gridlook');")
    for path in (("gridlook/",), ("gridlook", "index.html"), ("gridlook", "app.js")):
        resp = await jp_fetch(*path)
        assert resp.code == 200
        csp = resp.headers.get("Content-Security-Policy", "")
        assert "sandbox" not in csp
        assert "frame-ancestors" in csp  # the ordinary jupyter policy still applies


async def test_static_asset_served(jp_fetch, proxy, static_root):
    (static_root / "app.js").write_text("console.log('gridlook');")
    resp = await jp_fetch("gridlook", "app.js")
    assert resp.code == 200
    assert b"console.log" in resp.body


async def test_bare_route_redirects_to_slash(jp_fetch, jp_base_url, proxy):
    # follow_redirects=False: the follow would need DNS, which sandboxed
    # environments may block; the Location assertion is what matters.
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", follow_redirects=False)
    assert e.value.code == 301
    assert e.value.response.headers["Location"] == f"{jp_base_url}gridlook/"


class TestEnvFallback:
    def test_allowlist_from_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_ALLOWED_BUCKETS", "bucket-a, bucket-b")
        proxy = GridlookProxy()
        assert proxy.allowed_buckets == ["bucket-a", "bucket-b"]
        assert proxy.enabled

    def test_region_from_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_S3_REGION", "us-west-2")
        assert GridlookProxy().region == "us-west-2"

    @pytest.mark.parametrize(
        "raw,expected", [("1", True), ("true", True), ("YES", True), ("0", False), ("", False)]
    )
    def test_anonymous_from_env(self, monkeypatch, raw, expected):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_ANONYMOUS", raw)
        assert GridlookProxy().anonymous is expected

    def test_anonymous_trait_wins_over_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_ANONYMOUS", "1")
        assert GridlookProxy(anonymous=False).anonymous is False

    def test_traitlet_wins_over_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_ALLOWED_BUCKETS", "env-bucket")
        proxy = GridlookProxy(allowed_buckets=["cfg-bucket"])
        assert proxy.allowed_buckets == ["cfg-bucket"]

    def test_empty_by_default(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.delenv("GRIDLOOK_ALLOWED_BUCKETS", raising=False)
        proxy = GridlookProxy()
        assert proxy.allowed_buckets == []
        assert not proxy.enabled


@pytest.mark.parametrize(
    "header,expected",
    [
        ("bytes=10-19", (10, 20)),
        ("bytes=95-", {"offset": 95}),
        ("bytes=-5", {"suffix": 5}),
        ("bytes=0-0", (0, 1)),
        ("bytes=20-10", None),
        ("bytes=1-2,5-6", None),
        ("chars=1-2", None),
        ("bytes=", None),
    ],
)
def test_parse_range_header(header, expected):
    from gridlook_jupyter.handlers import parse_range_header

    assert parse_range_header(header) == expected
