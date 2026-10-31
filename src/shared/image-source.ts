import { isAbsoluteAppFilesystemPath } from "./app-protocol";
import { parseAssetSource } from "./assets";
import { parseFileSource } from "./file-resources";

/**
 * What an image's source names, before anything reads it: a Library File, a managed asset in
 * this Profile's cache, an image carried in the source itself, a file on disk, a web image, or a
 * path relative to where the content is read.
 */
export type ImageSource =
  | { readonly kind: "file"; readonly fileId: string }
  | { readonly kind: "asset" }
  | { readonly kind: "data" }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "web" }
  | { readonly kind: "relative"; readonly path: string }
  | { readonly kind: "unsupported" };

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u;

/**
 * The file an image source names on disk: an absolute path or a `file:` URL, whose host names a
 * network share, as `file://server/share/a.png` names `//server/share/a.png`.
 */
export function parseLocalImagePath(rawSource: string): string | null {
  const source = rawSource.trim();
  if (!source || source.startsWith("//")) return null;
  if (source.startsWith("/")) return source;
  if (WINDOWS_PATH.test(source)) return source.replace(/\\/gu, "/");
  if (!/^file:/iu.test(source)) return null;
  try {
    const url = new URL(source);
    const path = decodeURIComponent(url.pathname);
    if (url.host && url.host !== "localhost") return `//${url.host}${path}`;
    return isAbsoluteAppFilesystemPath(path) ? path : null;
  } catch {
    return null;
  }
}

export function classifyImageSource(rawSource: string): ImageSource {
  const source = rawSource.trim();
  const fileId = parseFileSource(source);
  if (fileId) return { kind: "file", fileId };
  if (parseAssetSource(source)) return { kind: "asset" };
  if (/^data:image\//iu.test(source)) return { kind: "data" };
  const path = parseLocalImagePath(source);
  if (path) return { kind: "path", path };
  if (/^https?:\/\//iu.test(source)) return { kind: "web" };
  if (!source || source.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(source))
    return { kind: "unsupported" };
  return { kind: "relative", path: source };
}

/**
 * A relative image path read from the folder `base`, as a message's relative links are read from
 * its working folder; null without a base or for a path that climbs above the filesystem root.
 */
export function resolveRelativeImagePath(relative: string, base: string | null | undefined) {
  if (!base) return null;
  const root = parseLocalImagePath(base);
  if (!root) return null;
  let decoded = relative.split(/[?#]/u, 1)[0] ?? "";
  try {
    decoded = decodeURI(decoded);
  } catch {
    return null;
  }
  const [head = "", ...rest] = root.replace(/\/+$/u, "").split("/");
  const segments = rest.filter(Boolean);
  for (const segment of decoded.replace(/\\/gu, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  const path = [head, ...segments].join("/") || "/";
  return root.startsWith("//") ? `/${path}` : path;
}
