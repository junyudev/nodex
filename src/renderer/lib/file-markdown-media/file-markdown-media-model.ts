import { canonicalWorkbenchFilePath } from "../../../shared/workbench-resource-identity";
import { parseLocalFileLinkHref } from "../../../shared/file-link-openers";

export const FILE_MARKDOWN_IMAGE_MAX_BYTES = 25_000_000;

/** This decoded preview budget is independent of the host's read-response limit. */
export function decodeFileMarkdownImageBytes(
  contentsBase64: string,
  maxBytes = FILE_MARKDOWN_IMAGE_MAX_BYTES,
): Uint8Array<ArrayBuffer> | null {
  if (contentsBase64.length > Math.ceil(maxBytes / 3) * 4) return null;
  try {
    const decoded = atob(contentsBase64);
    if (decoded.length > maxBytes) return null;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface FileMarkdownMediaScope {
  readonly hostId: string;
  readonly sourceFilePath: string;
  readonly revision?: number;
}

export type FileMarkdownImageSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "file"; readonly hostId: string; readonly path: string }
  | { readonly kind: "blocked" };

/** Authored resources never inherit the renderer's filesystem or opaque capabilities. */
export function resolveFileMarkdownImageSource(
  source: string,
  scope: FileMarkdownMediaScope,
): FileMarkdownImageSource {
  const value = source;
  const uri = source.trim();
  if (!uri || /[\0\r\n]/u.test(value)) return { kind: "blocked" };
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml)(?:;[^,]*)?,/iu.test(uri))
    return { kind: "url", url: uri };
  if (/^https?:/iu.test(uri)) {
    try {
      const url = new URL(uri);
      if (url.username || url.password) return { kind: "blocked" };
      return { kind: "url", url: url.href };
    } catch {
      return { kind: "blocked" };
    }
  }
  if (uri.startsWith("//")) return { kind: "blocked" };
  const windowsPath = /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
  if (!windowsPath && /^[a-z][a-z\d+.-]*:/iu.test(uri) && !/^file:/iu.test(uri))
    return { kind: "blocked" };
  try {
    if (/^file:/iu.test(uri)) {
      const fileUrl = new URL(uri);
      if (fileUrl.hostname && fileUrl.hostname !== "localhost") return { kind: "blocked" };
    }
    const path = /^file:/iu.test(uri)
      ? parseLocalFileLinkHref(uri)?.path
      : decodeURIComponent(value.split(/[?#]/u)[0]!);
    if (!path || path.startsWith("/@fs") || path.includes("\0")) return { kind: "blocked" };
    const documentPath = canonicalWorkbenchFilePath(scope.sourceFilePath);
    const parent = documentPath.slice(0, documentPath.lastIndexOf("/")) || "/";
    const directory = /^[a-z]:$/iu.test(parent) ? `${parent}/` : parent;
    return {
      kind: "file",
      hostId: scope.hostId,
      path: canonicalWorkbenchFilePath(
        /^file:/iu.test(uri) ? path.replace(/^\/([a-z]:\/)/iu, "$1") : path,
        directory,
      ),
    };
  } catch {
    return { kind: "blocked" };
  }
}

export interface FileMarkdownImageCandidate {
  readonly source: string;
  readonly descriptor: string;
}

const asciiWhitespace = (value: string) => /[\t\n\f\r ]/u.test(value);

function validDescriptors(descriptors: readonly string[]): boolean {
  let width = false;
  let density = false;
  let height = false;
  for (const descriptor of descriptors) {
    if (/^\d+w$/u.test(descriptor) && Number.parseInt(descriptor, 10) > 0 && !width && !density) {
      width = true;
      continue;
    }
    if (
      /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x$/u.test(descriptor) &&
      Number.isFinite(Number(descriptor.slice(0, -1))) &&
      !width &&
      !density &&
      !height
    ) {
      density = true;
      continue;
    }
    if (/^\d+h$/u.test(descriptor) && Number.parseInt(descriptor, 10) > 0 && !height && !density) {
      height = true;
      continue;
    }
    return false;
  }
  return !height || width;
}

/** HTML's URL/descriptor tokenizer preserves commas inside data images. */
export function parseFileMarkdownImageSrcSet(value: string): FileMarkdownImageCandidate[] {
  const candidates: FileMarkdownImageCandidate[] = [];
  let position = 0;
  while (position < value.length) {
    while (
      position < value.length &&
      (asciiWhitespace(value[position]!) || value[position] === ",")
    )
      position += 1;
    const start = position;
    while (position < value.length && !asciiWhitespace(value[position]!)) position += 1;
    let source = value.slice(start, position);
    if (!source) break;
    const descriptors: string[] = [];
    if (source.endsWith(",")) {
      source = source.replace(/,+$/u, "");
    } else {
      let current = "";
      let inParens = false;
      while (position < value.length) {
        const character = value[position++]!;
        if (character === "," && !inParens) break;
        if (asciiWhitespace(character) && !inParens) {
          if (current) descriptors.push(current);
          current = "";
          continue;
        }
        current += character;
        if (character === "(") inParens = true;
        if (character === ")") inParens = false;
      }
      if (current) descriptors.push(current);
    }
    if (source && validDescriptors(descriptors))
      candidates.push({ source, descriptor: descriptors.join(" ") });
  }
  return candidates;
}

export function fileMarkdownImageMimeType(path: string): string | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
  };
  return extension ? (types[extension] ?? null) : null;
}
