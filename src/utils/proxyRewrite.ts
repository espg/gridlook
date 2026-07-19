/**
 * Rewrites s3:// dataset URIs to the gridlook-jupyter proxy path when the app
 * is served by the jupyter server extension. Standalone serving (dev server,
 * static hosting) leaves inputs untouched.
 */

const S3_URI_RE = /^s3:\/\/([^/]+)\/?(.*)$/;

/**
 * Base URL of the served app: the current location without hash/query,
 * truncated to its containing directory.
 */
export function appBaseFromHref(href: string): string {
  const url = new URL(href);
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  }
  return url.toString();
}

/**
 * Pure rewrite rule: s3://bucket/prefix -> <appBase>s3/bucket/prefix.
 * Returns null for anything that is not an s3:// URI.
 */
export function rewriteS3Uri(input: string, appBase: string): string | null {
  const m = S3_URI_RE.exec(input.trim());
  if (!m) {
    return null;
  }
  const [, bucket, key] = m;
  return new URL(`s3/${bucket}/${key}`, appBase).toString();
}

let probe: Promise<boolean> | null = null;

/** Test seam: forget the cached health probe result. */
export function resetExtensionProbe(): void {
  probe = null;
}

/**
 * True when the app is served by gridlook-jupyter, detected once by probing
 * the extension's health endpoint relative to the app base. The body check
 * guards against SPA-fallback hosts that answer 200 to any path.
 */
export function isExtensionServed(appBase: string): Promise<boolean> {
  probe ??= fetch(new URL("api/health", appBase).toString(), {
    credentials: "same-origin",
  })
    .then(async (r) => {
      if (!r.ok) {
        return false;
      }
      const body: unknown = await r.json();
      return (
        typeof body === "object" &&
        body !== null &&
        (body as { extension?: unknown }).extension === "gridlook-jupyter"
      );
    })
    .catch(() => false);
  return probe;
}

/**
 * Rewrite an s3:// dataset input to the proxy URL when extension-served;
 * otherwise (non-s3 input, or standalone serving) return it unchanged.
 */
export async function maybeRewriteS3Uri(
  input: string,
  appBase: string = appBaseFromHref(window.location.href)
): Promise<string> {
  if (!input.startsWith("s3://")) {
    return input;
  }
  if (!(await isExtensionServed(appBase))) {
    return input;
  }
  return rewriteS3Uri(input, appBase) ?? input;
}
