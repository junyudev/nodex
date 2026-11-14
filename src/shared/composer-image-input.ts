export const COMPOSER_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/x-png",
] as const;

export const COMPOSER_IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(COMPOSER_IMAGE_MIME_TYPES);
const SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(COMPOSER_IMAGE_FILE_EXTENSIONS);
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeComposerImageFilenameCandidate(value: string): string {
  const decoded = safeDecodeURIComponent(value.trim());
  const withoutFileScheme = decoded.replace(/^file:\/\//iu, "");
  const segments = withoutFileScheme.split(/[\\/]/u);
  return segments.at(-1)?.trim() ?? "";
}

export function isSupportedComposerImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

/** Use paste provenance while the browser's generic bitmap name is still distinguishable. */
export function clipboardImageName(name: string): string {
  return !name.trim() || /^image\.[a-z0-9]+$/iu.test(name.trim()) ? "Pasted image" : name;
}

export function resolveComposerImageMimeType(input: {
  readonly filename: string;
  readonly mimeType?: string | null;
}): string | null {
  const mimeType = input.mimeType?.trim().toLowerCase() ?? "";
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return mimeType;

  const filename = normalizeComposerImageFilenameCandidate(input.filename);
  const separator = filename.lastIndexOf(".");
  const extension = separator < 0 ? "" : filename.slice(separator + 1).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension)
    ? (IMAGE_MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

export function isSupportedComposerImageMetadata(input: {
  readonly filename: string;
  readonly mimeType?: string | null;
  readonly size?: number | null;
}): boolean {
  if (input.size === 0) return false;
  return resolveComposerImageMimeType(input) !== null;
}
