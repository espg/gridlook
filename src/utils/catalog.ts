import axios from "axios";

import { withXsrfToken } from "@/utils/xsrfToken.ts";

export type TCatalogEntry = {
  url: string;
  title?: string;
  tag?: string;
  description?: string;
};

export type TCatalog = {
  type: "gridlook_catalog";
  title?: string;
  datasets: TCatalogEntry[];
};

function isCatalog(data: unknown): data is TCatalog {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: unknown }).type === "gridlook_catalog" &&
    "datasets" in data &&
    Array.isArray((data as TCatalog).datasets)
  );
}

function newAbortSignal(timeoutMs: number) {
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), timeoutMs || 0);

  return abortController.signal;
}

export async function fetchCatalog(url: string): Promise<TCatalog | null> {
  try {
    const response = await axios.get(
      withXsrfToken(url, document.cookie, location.href),
      {
        signal: newAbortSignal(5000), //Aborts request after 5 seconds
      }
    );
    const data = response.data;
    if (isCatalog(data)) {
      return data;
    }
  } catch {
    return null;
  }
  return null;
}
