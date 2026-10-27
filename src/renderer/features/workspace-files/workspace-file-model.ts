import {
  EXTENSION_TO_FILE_FORMAT,
  getFiletypeFromFileName,
  type SupportedLanguages,
} from "@pierre/diffs";
import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  type WorkspaceFileContentKind,
} from "../../../shared/types";

export { WORKSPACE_FILE_PREVIEW_MAX_BYTES };
export const WORKSPACE_TEXT_EDITABLE_MAX_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_TEXT_LOAD_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_FILE_CONTENT_SAMPLE_BYTES = 4096;

/** A rich preview that replaces the source view. */
export type WorkspaceFilePreviewKind = "image" | "pdf" | "audio" | "video" | "markdown";

/** Whether a file opens in its rich preview, may toggle to it, or only has a source view. */
export type WorkspaceFileRichViewMode = "always" | "toggle" | "none";

export type WorkspaceFileUnsupportedType =
  | "archive"
  | "audio"
  | "binary"
  | "image"
  | "video"
  | "excel-spreadsheet"
  | "keynote-deck"
  | "numbers-spreadsheet"
  | "opendocument-presentation"
  | "opendocument-spreadsheet"
  | "opendocument-text"
  | "pages-document"
  | "powerpoint-deck"
  | "rich-text-document"
  | "word-document";

const DOCUMENT_UNSUPPORTED_TYPES = new Map<string, WorkspaceFileUnsupportedType>([
  ["doc", "word-document"],
  ["docx", "word-document"],
  ["key", "keynote-deck"],
  ["numbers", "numbers-spreadsheet"],
  ["odp", "opendocument-presentation"],
  ["ods", "opendocument-spreadsheet"],
  ["odt", "opendocument-text"],
  ["pages", "pages-document"],
  ["ppt", "powerpoint-deck"],
  ["pptx", "powerpoint-deck"],
  ["rtf", "rich-text-document"],
  ["xls", "excel-spreadsheet"],
  ["xlsm", "excel-spreadsheet"],
  ["xlsx", "excel-spreadsheet"],
]);
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4a",
  "oga",
  "ogg",
  "opus",
  "wav",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "ogv", "webm"]);
/** Image formats the renderer cannot decode. */
const UNRENDERABLE_IMAGE_EXTENSIONS = new Set(["tif", "tiff"]);
/** Images that open in the image preview; SVG may toggle between its source and the image. */
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);
const MARKDOWN_EXTENSIONS = new Set(["markdown", "md", "mdown", "mdx", "mkd"]);

export interface WorkspaceFilePreviewInput {
  readonly path: string;
  readonly contentKind: WorkspaceFileContentKind | undefined;
}

export function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || path;
}

export function isWorkspacePathInsideRoot(workspaceRoot: string, targetPath: string): boolean {
  const normalizedRoot = normalizeWorkspacePath(workspaceRoot);
  const normalizedTarget = normalizeWorkspacePath(targetPath);
  const windowsPath = /^[A-Za-z]:\//.test(normalizedRoot);
  const comparableRoot = windowsPath ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableTarget = windowsPath ? normalizedTarget.toLowerCase() : normalizedTarget;
  return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}/`);
}

export function resolveWorkspaceTreeFilePath(workspaceRoot: string, relativePath: string): string {
  const separator = workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const child = relativePath.replace(/^[\\/]+/, "").replace(/[\\/]/g, separator);
  return child ? `${root}${separator}${child}` : root;
}

export function getWorkspaceRelativePath(workspaceRoot: string, targetPath: string): string | null {
  if (!isWorkspacePathInsideRoot(workspaceRoot, targetPath)) return null;
  const normalizedRoot = normalizeWorkspacePath(workspaceRoot);
  const normalizedTarget = normalizeWorkspacePath(targetPath);
  return normalizedTarget.slice(normalizedRoot.length).replace(/^\/+/, "");
}

export function getWorkspaceFileName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const parts = normalized.split("/");
  return parts.at(-1) || normalized;
}

export function getWorkspaceFileExtension(path: string): string {
  const name = getWorkspaceFileName(path);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex).toLowerCase() : "";
}

/** The lowercase extension without its dot. */
function extensionOf(path: string): string | null {
  return getWorkspaceFileExtension(path).slice(1) || null;
}

export function getWorkspaceFileDomTabId(
  hostId: string | undefined,
  path: string | undefined,
): string | undefined {
  if (!path) return undefined;
  return `file:${hostId || "local"}:${path}`;
}

export function resolveWorkspaceSourceLanguage(path: string): SupportedLanguages | null {
  const name = getWorkspaceFileName(path);
  if (EXTENSION_TO_FILE_FORMAT[name] !== undefined) {
    return getFiletypeFromFileName(name);
  }

  const compoundExtension = name.match(/\.([^.]+\.[^.]+)$/)?.[1];
  if (compoundExtension && EXTENSION_TO_FILE_FORMAT[compoundExtension] !== undefined) {
    return getFiletypeFromFileName(name);
  }

  const extension = name.match(/\.([^.]+)$/)?.[1] ?? "";
  return EXTENSION_TO_FILE_FORMAT[extension] === undefined ? null : getFiletypeFromFileName(name);
}

function isUnrenderableImage(path: string, contentKind: WorkspaceFileContentKind | undefined) {
  // A copy suffix such as `scan.tiff (2)` keeps the format.
  const extension = extensionOf(path)?.replace(/ \(\d+\)$/u, "");
  return (
    (contentKind === undefined || contentKind === "image") &&
    extension !== undefined &&
    UNRENDERABLE_IMAGE_EXTENSIONS.has(extension)
  );
}

function isAudioPath(path: string) {
  const extension = extensionOf(path);
  return extension !== null && AUDIO_EXTENSIONS.has(extension);
}

function isVideoPath(path: string) {
  const extension = extensionOf(path);
  return extension !== null && VIDEO_EXTENSIONS.has(extension);
}

function imageRichViewMode(path: string): WorkspaceFileRichViewMode {
  const extension = extensionOf(path);
  if (extension === null) return "none";
  if (extension === "svg") return "toggle";
  return IMAGE_EXTENSIONS.has(extension) ? "always" : "none";
}

function isMarkdownPath(path: string) {
  const extension = extensionOf(path);
  return extension !== null && MARKDOWN_EXTENSIONS.has(extension);
}

function isPdfPath(path: string) {
  return extensionOf(path) === "pdf";
}

/**
 * The rich preview a file opens in. Sniffed content decides first; the extension only refines
 * text or unknown content and the playable audio/video containers.
 */
export function resolveWorkspaceFilePreviewKind({
  path,
  contentKind,
}: WorkspaceFilePreviewInput): WorkspaceFilePreviewKind | null {
  const unrenderableImage = isUnrenderableImage(path, contentKind);
  if (contentKind === "image" && !unrenderableImage) return "image";
  if (contentKind === "pdf") return "pdf";
  if ((contentKind === undefined || contentKind === "audio") && isAudioPath(path)) return "audio";
  if ((contentKind === undefined || contentKind === "video") && isVideoPath(path)) return "video";
  if (contentKind !== undefined && contentKind !== "text") return null;
  if (contentKind === undefined && !unrenderableImage && imageRichViewMode(path) !== "none") {
    return "image";
  }
  if (isMarkdownPath(path)) return "markdown";
  if (contentKind === undefined && isPdfPath(path)) return "pdf";
  return null;
}

export function resolveWorkspaceFileRichViewMode({
  path,
  contentKind,
}: WorkspaceFilePreviewInput): WorkspaceFileRichViewMode {
  const unrenderableImage = isUnrenderableImage(path, contentKind);
  if (
    (contentKind === "image" && !unrenderableImage) ||
    contentKind === "pdf" ||
    (contentKind === "audio" && isAudioPath(path)) ||
    (contentKind === "video" && isVideoPath(path))
  ) {
    return "always";
  }
  if (contentKind !== undefined && contentKind !== "text") return "none";
  const imageMode = imageRichViewMode(path);
  if (contentKind === undefined && !unrenderableImage && imageMode === "always") return "always";
  if ((contentKind === undefined && imageMode === "toggle") || isMarkdownPath(path)) {
    return "toggle";
  }
  return contentKind === undefined && isPdfPath(path) ? "always" : "none";
}

/** Why a file has neither a rich preview nor a source view, or `null` when it has one. */
export function resolveWorkspaceFileUnsupportedType({
  path,
  contentKind,
}: WorkspaceFilePreviewInput): WorkspaceFileUnsupportedType | null {
  if (isUnrenderableImage(path, contentKind)) return "image";
  if (
    contentKind === "image" ||
    contentKind === "pdf" ||
    (contentKind === "audio" && isAudioPath(path)) ||
    (contentKind === "video" && isVideoPath(path))
  ) {
    return null;
  }
  const extension = extensionOf(path);
  const documentType =
    extension === null ? null : (DOCUMENT_UNSUPPORTED_TYPES.get(extension) ?? null);
  if (
    documentType !== null &&
    (contentKind === undefined ||
      contentKind === "archive" ||
      contentKind === "binary" ||
      (contentKind === "text" && extension === "rtf"))
  ) {
    return documentType;
  }
  if (contentKind === undefined || contentKind === "text") return null;
  return contentKind;
}

export function isWorkspaceFileTooLargeToPreview(sizeBytes: number | null): boolean {
  return sizeBytes !== null && sizeBytes > WORKSPACE_FILE_PREVIEW_MAX_BYTES;
}

/** Byte counts in the viewer's preview-limit copy: `512 B`, `3.4 KB`, `300.0 MB`. */
export function formatWorkspaceFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
