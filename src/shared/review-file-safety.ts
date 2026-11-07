import type { ReviewFileSafety, ReviewSkipReason } from "./types";

export const REVIEW_TEXT_SAMPLE_BYTES = 8_192;
export const REVIEW_RENDERABLE_TEXT_MAX_BYTES = 1024 * 1024;
export const REVIEW_GIT_DIFF_MAX_BYTES = 32 * 1024 * 1024;
export const REVIEW_UNTRACKED_DIFF_CONCURRENCY = 8;

const TEXT_EXTENSIONS = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "diff",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "lock",
  "log",
  "lua",
  "m",
  "md",
  "mdx",
  "patch",
  "php",
  "plist",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const BINARY_EXTENSIONS = new Set([
  "7z",
  "avif",
  "bin",
  "bmp",
  "class",
  "db",
  "dll",
  "dmg",
  "doc",
  "docx",
  "eot",
  "exe",
  "gif",
  "gz",
  "heic",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "otf",
  "pdf",
  "png",
  "sqlite",
  "tar",
  "ttf",
  "wasm",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "zip",
]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function getExtension(filePath: string): string {
  const lastPathSegment = filePath.split(/[\\/]/).at(-1) ?? filePath;
  const dotIndex = lastPathSegment.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === lastPathSegment.length - 1) return "";
  return lastPathSegment.slice(dotIndex + 1).toLowerCase();
}

function inferMimeType(filePath: string): string | null {
  const extension = getExtension(filePath);
  if (!extension) return null;
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "pdf") return "application/pdf";
  if (extension === "wasm") return "application/wasm";
  if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
  if (BINARY_EXTENSIONS.has(extension)) return "application/octet-stream";
  return null;
}

function hasBinaryExtension(filePath: string): boolean {
  const extension = getExtension(filePath);
  return (
    extension.length > 0 && BINARY_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)
  );
}

function resolveSkipReason(input: {
  binary: boolean;
  tooLarge: boolean;
  invalidText: boolean;
  unsupported?: boolean;
}): ReviewSkipReason | null {
  if (input.binary) return "binary";
  if (input.tooLarge) return "tooLarge";
  if (input.invalidText) return "invalidText";
  if (input.unsupported) return "unsupported";
  return null;
}

export function buildReviewFileSafety(input?: {
  binary?: boolean;
  tooLarge?: boolean;
  invalidText?: boolean;
  unsupported?: boolean;
  sizeBytes?: number | null;
  mimeType?: string | null;
  skipReason?: ReviewSkipReason | null;
}): ReviewFileSafety {
  const binary = input?.binary === true;
  const tooLarge = input?.tooLarge === true;
  const invalidText = input?.invalidText === true;
  const skipReason =
    input?.skipReason ??
    resolveSkipReason({
      binary,
      tooLarge,
      invalidText,
      unsupported: input?.unsupported,
    });

  return {
    binary,
    tooLarge,
    invalidText,
    renderable: skipReason === null,
    sizeBytes:
      typeof input?.sizeBytes === "number" && input.sizeBytes >= 0 ? input.sizeBytes : null,
    mimeType: input?.mimeType ?? null,
    skipReason,
  };
}

function looksLikeInvalidText(value: string): boolean {
  if (value.length === 0) return false;

  let inspected = 0;
  let controlCount = 0;
  for (const char of value.slice(0, REVIEW_TEXT_SAMPLE_BYTES)) {
    const code = char.charCodeAt(0);
    inspected += 1;
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCount += 1;
    }
  }

  return inspected > 0 && controlCount / inspected > 0.08;
}

export function classifyReviewTextPayload(input: {
  path: string;
  text: string;
  maxBytes?: number;
  mimeType?: string | null;
}): ReviewFileSafety {
  const sizeBytes = byteLength(input.text);
  const mimeType = input.mimeType ?? inferMimeType(input.path);
  const binary =
    hasBinaryExtension(input.path) ||
    input.text.includes("GIT binary patch") ||
    /^Binary files .+ differ$/m.test(input.text);
  const tooLarge = sizeBytes > (input.maxBytes ?? REVIEW_RENDERABLE_TEXT_MAX_BYTES);
  const invalidText = looksLikeInvalidText(input.text);

  return buildReviewFileSafety({
    binary,
    tooLarge,
    invalidText,
    sizeBytes,
    mimeType,
  });
}

export function classifyReviewFileMetadata(input: {
  path: string;
  sizeBytes?: number | null;
  additions?: number | null;
  deletions?: number | null;
  diffText?: string | null;
  maxBytes?: number;
  mimeType?: string | null;
}): ReviewFileSafety {
  const mimeType = input.mimeType ?? inferMimeType(input.path);
  const binaryFromStats = input.additions === null || input.deletions === null;
  const binary = binaryFromStats || hasBinaryExtension(input.path);
  const sizeBytes =
    typeof input.sizeBytes === "number" && input.sizeBytes >= 0
      ? input.sizeBytes
      : input.diffText
        ? byteLength(input.diffText)
        : null;
  const tooLarge =
    typeof sizeBytes === "number" &&
    sizeBytes > (input.maxBytes ?? REVIEW_RENDERABLE_TEXT_MAX_BYTES);
  const invalidText = input.diffText ? looksLikeInvalidText(input.diffText) : false;

  return buildReviewFileSafety({
    binary,
    tooLarge,
    invalidText,
    sizeBytes,
    mimeType,
  });
}

export function describeReviewFileSafety(safety: ReviewFileSafety): string {
  if (safety.skipReason === "binary") return "Binary file changed";
  if (safety.skipReason === "tooLarge") return "File too large to display";
  if (safety.skipReason === "invalidText") return "File contains unsupported text data";
  if (safety.skipReason === "unsupported") return "File diff is not available";
  return "File diff is available";
}
