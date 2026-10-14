import mimeDatabase from "mime-db/db.json";
import { isAbsoluteAppFilesystemPath, buildAppFilesystemUrl } from "../../../shared/app-protocol";
import { interpretConversationFilePath } from "../markdown/conversation-markdown-targets";

export type ConversationMediaKind = "image" | "audio" | "video";
const mimeSourcePreference: readonly (string | undefined)[] = [
  "nginx",
  "apache",
  undefined,
  "iana",
];
const mimeTypes = new Map<string, string>();
const database: Readonly<
  Record<
    string,
    {
      readonly source?: string;
      readonly extensions?: readonly string[];
      readonly charset?: string;
      readonly compressible?: boolean;
    }
  >
> = mimeDatabase;
for (const [type, entry] of Object.entries(database)) {
  for (const extension of entry.extensions ?? []) {
    const previous = mimeTypes.get(extension);
    if (previous && previous !== "application/octet-stream") {
      const from = mimeSourcePreference.indexOf(database[previous]?.source);
      const to = mimeSourcePreference.indexOf(entry.source);
      if (from > to || (from === to && previous.startsWith("application/"))) continue;
    }
    mimeTypes.set(extension, type);
  }
}

/** MIME lookup consumes the raw locator, before any authored URI interpretation. */
export function conversationMediaMimeType(source: string): string | null {
  const dataType = /^data:([^;,]+)/iu.exec(source);
  if (dataType) return dataType[1] ?? null;
  const path = `x.${source}`.replace(/\/+$/u, "");
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || basename === "..") return null;
  return mimeTypes.get(basename.slice(dot + 1).toLowerCase()) ?? null;
}

/** An HTTP locator remains an image even when its pathname has an audio/video extension. */
export function classifyConversationMedia(source: string): ConversationMediaKind {
  if (!/^data:(?:audio|image|video)\//iu.test(source) && !isAbsoluteAppFilesystemPath(source))
    return "image";
  const mime = conversationMediaMimeType(source);
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("video/")) return "video";
  return "image";
}

export interface ConversationMediaSource {
  readonly imageComposerTarget?: import("@/features/user-attachment-image-editor/model/types").ImageEditComposerTarget;
  readonly hostId: string;
  readonly threadId: string;
  readonly sourceIdentity: string;
  readonly authority: object | null;
  readonly nativeConnection:
    | { readonly sourceEpoch: string; readonly generation: number }
    | undefined;
  readonly isCurrent: () => boolean;
  /** Authority validity is independent of the lifetime of one mounted consumer. */
  readonly isResourceCurrent: () => boolean;
}
export type ConversationMediaTarget =
  | { readonly kind: "blocked" }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "file"; readonly hostId: string; readonly path: string }
  | {
      readonly kind: "stream";
      readonly hostId: "local";
      readonly path: string;
      readonly url: string;
    };

/** Files are admitted only by the mounted source owner; authored app/blob URLs are never capabilities. */
export function resolveConversationMediaTarget(
  source: string,
  scope: ConversationMediaSource | null,
): ConversationMediaTarget {
  if (!source || /[\0\r\n]/u.test(source) || source.startsWith("//")) return { kind: "blocked" };
  if (/^data:(?:audio|image|video)\/[^;,]+(?:;[^,]*)?,/iu.test(source))
    return { kind: "url", url: source };
  if (/^https?:/iu.test(source)) {
    try {
      const url = new URL(source);
      return url.username || url.password ? { kind: "blocked" } : { kind: "url", url: url.href };
    } catch {
      return { kind: "blocked" };
    }
  }
  if (
    !scope?.authority ||
    !scope.nativeConnection ||
    !scope.hostId ||
    !scope.threadId ||
    !scope.isResourceCurrent()
  )
    return { kind: "blocked" };
  try {
    if (/^file:/iu.test(source)) {
      const url = new URL(source);
      if (url.hostname && url.hostname !== "localhost") return { kind: "blocked" };
    }
    const path = interpretConversationFilePath(source);
    if (
      !path ||
      !isAbsoluteAppFilesystemPath(path) ||
      path.includes("\0") ||
      path.startsWith("/@fs")
    )
      return { kind: "blocked" };
    const kind = classifyConversationMedia(source);
    if (kind !== "image" && scope.hostId === "local")
      return { kind: "stream", hostId: "local", path, url: buildAppFilesystemUrl(path) };
    return { kind: "file", hostId: scope.hostId, path };
  } catch {
    return { kind: "blocked" };
  }
}

export function conversationMediaDataUrl(
  contentsBase64: string,
  mimeType: string | undefined,
  path: string,
) {
  return `data:${mimeType ?? conversationMediaMimeType(path) ?? "application/octet-stream"};base64,${contentsBase64}`;
}

export function conversationMediaCachePolicy(kind: ConversationMediaKind) {
  return { staleTime: Number.POSITIVE_INFINITY, gcTime: kind === "image" ? 15_000 : 0 };
}

export function conversationMediaFilename(source: string): string {
  const path = interpretConversationFilePath(source);
  if (path) return path.split(/[\\/]/u).at(-1) || "media";
  try {
    const url = new URL(source);
    if (url.protocol === "data:")
      return `media.${conversationMediaMimeType(source)?.split("/").at(-1)?.replace("svg+xml", "svg") ?? "bin"}`;
    return decodeURIComponent(url.pathname.split("/").at(-1) || "image");
  } catch {
    return "media";
  }
}

export function conversationMediaBadge(source: string): string | null {
  try {
    const url = new URL(source);
    return url.protocol === "https:" && url.hostname === "img.shields.io"
      ? (/^\/badge\/(P[0-9]+)(?:-|$)/u.exec(url.pathname)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}
