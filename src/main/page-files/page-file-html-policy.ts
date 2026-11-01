import { PAGE_FILE_HTML_SCHEME } from "../../shared/page-file-html";

export const PAGE_FILE_HTML_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
export const PAGE_FILE_HTML_LIMITS = {
  documentBytes: 5_000_000,
  resourceBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  requests: 2_000,
  concurrency: 8,
} as const;

/** URL decoding happens once here. Core remains the portable-path authority. */
export function decodePageFileHtmlPath(rawPath: string): string | null {
  if (!rawPath.startsWith("/") || rawPath.length > 3_073 || /%2f|%5c/iu.test(rawPath)) return null;
  try {
    const path = decodeURIComponent(rawPath.slice(1));
    const parts = path.split("/");
    if (
      !path ||
      Buffer.byteLength(path) > 1_024 ||
      parts.length > 32 ||
      /[\\\u0000-\u001f\u007f]/u.test(path)
    )
      return null;
    if (
      parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)
    )
      return null;
    return path;
  } catch {
    return null;
  }
}

export const encodePageFileHtmlPath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

export function pageFileHtmlRequestPath(value: string, origin: string): string | null {
  // Inspect the raw path before WHATWG URL normalization can erase dot segments.
  if (!value.startsWith(`${origin}/`)) return null;
  const path = value.slice(origin.length).split(/[?#]/u)[0] ?? "";
  return decodePageFileHtmlPath(path);
}

export function isAllowedPageFileHtmlRequest(value: string, origin: string): boolean {
  if (value.startsWith("data:")) return true;
  if (value.startsWith(`blob:${origin}/`)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === `${PAGE_FILE_HTML_SCHEME}:` &&
      !url.username &&
      !url.password &&
      !url.port &&
      `${url.protocol}//${url.host}` === origin
    );
  } catch {
    return false;
  }
}

export function pageFileHtmlResponse(
  status: number,
  bytes?: Uint8Array,
  mimeType = "text/plain",
  head = false,
): Response {
  return new Response(head || !bytes ? null : new Uint8Array(bytes), {
    status,
    headers: {
      "Content-Type": mimeType,
      "Content-Security-Policy": PAGE_FILE_HTML_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      // Speculative DNS lookups bypass both CSP and the request gate.
      "X-DNS-Prefetch-Control": "off",
      ...(bytes ? { "Content-Length": String(bytes.byteLength) } : {}),
    },
  });
}

export const isHtmlMimeType = (mimeType: string): boolean =>
  mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/html";

/** MIME is recorded metadata. A filename never upgrades bytes into executable HTML. */
export const pageFileHtmlMimeType = (mimeType: string): string => {
  if (isHtmlMimeType(mimeType)) return "text/html; charset=utf-8";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/iu.test(mimeType))
    return "application/octet-stream";
  return mimeType;
};
