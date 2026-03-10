export interface ClipboardTarget {
  write?: (data: ClipboardItem[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

type ClipboardItemCtor = typeof ClipboardItem;

interface ResolveImageCopyUrlOptions {
  resolveFileUrl?: (source: string) => Promise<string>;
  baseHref?: string;
}

interface CopyImageToClipboardOptions extends ResolveImageCopyUrlOptions {
  source: string;
  fetchImpl?: typeof fetch;
  clipboard?: ClipboardTarget;
  clipboardItemCtor?: ClipboardItemCtor;
}

function getClipboardItemCtor(
  clipboardItemCtor?: ClipboardItemCtor,
): ClipboardItemCtor | null {
  if (clipboardItemCtor) return clipboardItemCtor;
  if (typeof ClipboardItem === "undefined") return null;
  return ClipboardItem;
}

function supportsClipboardMimeType(
  clipboardItemCtor: ClipboardItemCtor,
  mimeType: string,
): boolean {
  const supports = (
    clipboardItemCtor as ClipboardItemCtor & {
      supports?: (type: string) => boolean;
    }
  ).supports;

  if (typeof supports !== "function") return true;
  return supports(mimeType);
}

function toAbsoluteUrl(url: string, baseHref: string): string {
  try {
    return new URL(url, baseHref).toString();
  } catch {
    return url;
  }
}

export async function resolveImageCopyUrl(
  source: string,
  options: ResolveImageCopyUrlOptions = {},
): Promise<string> {
  const rawSource = source.trim();
  if (!rawSource) {
    throw new Error("Image source is missing");
  }

  const resolved = options.resolveFileUrl
    ? await options.resolveFileUrl(rawSource)
    : rawSource;

  const normalized = resolved.trim();
  if (!normalized) {
    throw new Error("Resolved image source is missing");
  }

  const baseHref = options.baseHref ??
    (typeof window !== "undefined" ? window.location.href : "http://localhost");

  return toAbsoluteUrl(normalized, baseHref);
}

export async function copyImageToClipboard(
  options: CopyImageToClipboardOptions,
): Promise<"image" | "url"> {
  const resolvedUrl = await resolveImageCopyUrl(options.source, {
    resolveFileUrl: options.resolveFileUrl,
    baseHref: options.baseHref,
  });

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(resolvedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image for copy (${response.status})`);
  }

  const blob = await response.blob();
  const clipboard =
    options.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!clipboard) {
    throw new Error("Clipboard API is unavailable");
  }

  const clipboardItemCtor = getClipboardItemCtor(options.clipboardItemCtor);
  const mimeType = blob.type;

  if (
    clipboardItemCtor &&
    typeof clipboard.write === "function" &&
    mimeType.startsWith("image/") &&
    supportsClipboardMimeType(clipboardItemCtor, mimeType)
  ) {
    const item = new clipboardItemCtor({ [mimeType]: blob });
    await clipboard.write([item]);
    return "image";
  }

  if (typeof clipboard.writeText === "function") {
    await clipboard.writeText(resolvedUrl);
    return "url";
  }

  throw new Error("Clipboard write is unavailable");
}
