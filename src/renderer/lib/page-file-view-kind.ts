/** How a Page File presents in its tab, decided by recorded MIME type and then by name. */
export type PageFileViewKind =
  | "html"
  | "markdown"
  | "svg"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "text"
  | "unsupported";

/** Text, Markdown and source views read at most this much; larger Files can still be saved. */
export const PAGE_FILE_TEXT_PREVIEW_MAX_BYTES = 2 * 1_048_576;

const extension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const IMAGE_MIME_SUBTYPES = new Set([
  "png",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "x-icon",
  "vnd.microsoft.icon",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "oga", "ogg", "flac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "rb",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "sh",
  "zsh",
  "sql",
  "css",
  "scss",
  "diff",
  "patch",
  "ini",
  "env",
]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
  "application/yaml",
  "application/toml",
  "application/sql",
]);

export function resolvePageFileViewKind(file: {
  readonly name: string;
  readonly mimeType: string;
}): PageFileViewKind {
  const mime = file.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const ext = extension(file.name);
  if (mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (mime === "image/svg+xml" || ext === "svg") return "svg";
  if (mime === "text/markdown" || ext === "md" || ext === "markdown" || ext === "mdx")
    return "markdown";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  const imageSubtype = mime.startsWith("image/") ? mime.slice("image/".length) : null;
  if (imageSubtype === null ? IMAGE_EXTENSIONS.has(ext) : IMAGE_MIME_SUBTYPES.has(imageSubtype))
    return "image";
  if (mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return "video";
  if (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    TEXT_EXTENSIONS.has(ext)
  )
    return "text";
  return "unsupported";
}

/** Kinds that render as something richer and can also show their source text. */
export const pageFileHasSourceView = (kind: PageFileViewKind): boolean =>
  kind === "html" || kind === "markdown" || kind === "svg";

/** Kinds whose content is read as text in at least one view. */
export const pageFileReadsText = (kind: PageFileViewKind): boolean =>
  kind === "text" || pageFileHasSourceView(kind);
