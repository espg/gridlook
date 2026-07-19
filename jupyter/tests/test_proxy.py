import pytest
from tornado.httpclient import HTTPClientError

ALLOWED_BUCKET = "test-bucket"  # matches conftest.ALLOWED_BUCKET

PAYLOAD = bytes(range(256)) * 4  # 1024 bytes, position-identifiable


@pytest.fixture
def seeded(proxy, put_object):
    put_object(ALLOWED_BUCKET, "data/chunk.bin", PAYLOAD)
    return proxy


async def test_full_get(jp_fetch, seeded):
    resp = await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin")
    assert resp.code == 200
    assert resp.body == PAYLOAD
    assert resp.headers["Accept-Ranges"] == "bytes"
    assert resp.headers["Content-Type"] == "application/octet-stream"


async def test_range_get_exact_slice(jp_fetch, seeded):
    resp = await jp_fetch(
        "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=10-19"}
    )
    assert resp.code == 206
    assert resp.body == PAYLOAD[10:20]
    assert resp.headers["Content-Range"] == f"bytes 10-19/{len(PAYLOAD)}"
    assert resp.headers["Content-Length"] == "10"


async def test_open_ended_range(jp_fetch, seeded):
    resp = await jp_fetch(
        "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=1000-"}
    )
    assert resp.code == 206
    assert resp.body == PAYLOAD[1000:]
    assert resp.headers["Content-Range"] == f"bytes 1000-1023/{len(PAYLOAD)}"


async def test_suffix_range(jp_fetch, seeded):
    resp = await jp_fetch(
        "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=-16"}
    )
    assert resp.code == 206
    assert resp.body == PAYLOAD[-16:]


async def test_head(jp_fetch, seeded):
    resp = await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", method="HEAD")
    assert resp.code == 200
    assert resp.headers["Content-Length"] == str(len(PAYLOAD))
    assert resp.headers["Accept-Ranges"] == "bytes"
    assert resp.body == b""


async def test_content_type_guess(jp_fetch, seeded, put_object):
    put_object(ALLOWED_BUCKET, "meta/zarr.json", b'{"zarr_format": 3}')
    resp = await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "meta/zarr.json")
    assert resp.headers["Content-Type"] == "application/json"


async def test_missing_key_404(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "nope/missing.bin")
    assert e.value.code == 404
    assert b"no such object" in e.value.response.body


async def test_non_allowlisted_bucket_403(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", "sneaky-bucket", "any/key")
    assert e.value.code == 403
    assert b"sneaky-bucket" in e.value.response.body
    assert b"allowlist" in e.value.response.body


async def test_head_non_allowlisted_403(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", "sneaky-bucket", "any/key", method="HEAD")
    assert e.value.code == 403


class TestDisabledProxy:
    @pytest.fixture
    def allowed_buckets(self):
        return []

    async def test_empty_allowlist_disables_proxy(self, jp_fetch, proxy):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "any/key")
        assert e.value.code == 403
        assert b"disabled" in e.value.response.body
        assert b"GRIDLOOK_ALLOWED_BUCKETS" in e.value.response.body

    async def test_health_reports_disabled(self, jp_fetch, proxy):
        import json

        resp = await jp_fetch("gridlook", "api", "health")
        assert json.loads(resp.body)["proxy_enabled"] is False
