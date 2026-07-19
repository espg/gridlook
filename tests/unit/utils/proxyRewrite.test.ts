import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appBaseFromHref,
  isExtensionServed,
  maybeRewriteS3Uri,
  resetExtensionProbe,
  rewriteS3Uri,
} from "@/utils/proxyRewrite.ts";

const BASE = "https://hub.example.org/user/me/gridlook/";

function mockHealth(ok: boolean, body?: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: () => Promise.resolve(body ?? {}),
    })
  );
}

beforeEach(() => {
  resetExtensionProbe();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rewriteS3Uri", () => {
  it("rewrites bucket/prefix to the proxy path", () => {
    expect(rewriteS3Uri("s3://my-bucket/some/prefix.zarr", BASE)).toBe(
      `${BASE}s3/my-bucket/some/prefix.zarr`
    );
  });

  it("handles a bare bucket", () => {
    expect(rewriteS3Uri("s3://my-bucket", BASE)).toBe(`${BASE}s3/my-bucket/`);
  });

  it("returns null for non-s3 inputs", () => {
    expect(rewriteS3Uri("https://example.org/x.zarr", BASE)).toBeNull();
    expect(rewriteS3Uri("gs://bucket/key", BASE)).toBeNull();
  });
});

describe("appBaseFromHref", () => {
  it("keeps directory paths, drops hash and query", () => {
    expect(appBaseFromHref(`${BASE}#s3://b/k::catalog=x`)).toBe(BASE);
  });

  it("truncates file paths to their directory", () => {
    expect(appBaseFromHref(`${BASE}index.html#foo`)).toBe(BASE);
  });
});

describe("maybeRewriteS3Uri", () => {
  it("rewrites when served by the extension", async () => {
    mockHealth(true, { extension: "gridlook-jupyter" });
    await expect(maybeRewriteS3Uri("s3://bucket/key.zarr", BASE)).resolves.toBe(
      `${BASE}s3/bucket/key.zarr`
    );
    expect(fetch).toHaveBeenCalledWith(`${BASE}api/health`, {
      credentials: "same-origin",
    });
  });

  it("leaves input untouched when standalone (health 404)", async () => {
    mockHealth(false);
    await expect(maybeRewriteS3Uri("s3://bucket/key.zarr", BASE)).resolves.toBe(
      "s3://bucket/key.zarr"
    );
  });

  it("leaves input untouched when the probe fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(maybeRewriteS3Uri("s3://bucket/key.zarr", BASE)).resolves.toBe(
      "s3://bucket/key.zarr"
    );
  });

  it("is not fooled by SPA-fallback hosts answering 200 with index.html", async () => {
    mockHealth(true, undefined); // json() resolves to {}
    await expect(maybeRewriteS3Uri("s3://bucket/key.zarr", BASE)).resolves.toBe(
      "s3://bucket/key.zarr"
    );
  });

  it("passes non-s3 inputs through without probing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      maybeRewriteS3Uri("https://example.org/x.zarr", BASE)
    ).resolves.toBe("https://example.org/x.zarr");
    expect(spy).not.toHaveBeenCalled();
  });

  it("caches the probe across calls", async () => {
    mockHealth(true, { extension: "gridlook-jupyter" });
    await maybeRewriteS3Uri("s3://a/k", BASE);
    await maybeRewriteS3Uri("s3://b/k", BASE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("isExtensionServed", () => {
  it("rejects a health response missing the extension marker", async () => {
    mockHealth(true, { something: "else" });
    await expect(isExtensionServed(BASE)).resolves.toBe(false);
  });
});
