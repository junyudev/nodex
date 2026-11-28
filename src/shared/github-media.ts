import type { GitHubUnavailable } from "./github-thread";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const canonicalPath = new RegExp(`^/user-attachments/assets/(${uuid})$`, "iu");
const legacyPath = new RegExp(`^/[a-z0-9-]+/[\\w.-]+/assets/\\d+/(${uuid})$`, "iu");
const cdnPath = new RegExp(`^/\\d+/\\d+-(${uuid})\\.[a-z0-9]+$`, "iu");

export const GITHUB_ATTACHMENT_MAX_URL_LENGTH = 4_096;

export type GitHubMediaKind = "image" | "video";
export type GitHubMediaResult =
  | { readonly status: "ready"; readonly kind: GitHubMediaKind; readonly url: string }
  | GitHubUnavailable;

const imageMimeTypes = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
]);
const videoMimeTypes = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/ogg",
  "video/x-m4v",
]);

export function gitHubMediaKind(mimeType: string): GitHubMediaKind | null {
  if (imageMimeTypes.has(mimeType)) return "image";
  if (videoMimeTypes.has(mimeType)) return "video";
  return null;
}

function attachmentUrl(value: string): URL | null {
  if (value.length > GITHUB_ATTACHMENT_MAX_URL_LENGTH || !/^https:\/\//iu.test(value)) return null;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.port || url.hash) return null;
  return url;
}

/** A CDN URL must match the attachment GitHub was asked to sign. */
export function parseGitHubAttachmentCdnUrl(value: string) {
  const url = attachmentUrl(value);
  if (!url) return null;
  const id = cdnPath.exec(url.pathname)?.[1]?.toLowerCase();
  if (!id) return null;
  const token = url.searchParams.get("jwt");
  if (url.host === "private-user-images.githubusercontent.com" && token) return { url, id, token };
  if (url.host === "user-images.githubusercontent.com" && !url.search)
    return { url, id, token: null };
  return null;
}

/** Signed source text is reduced to its stable GitHub link before rendering or IPC. */
export function parseGitHubAttachment(value: string) {
  const url = attachmentUrl(value);
  if (!url) return null;
  const cdn = parseGitHubAttachmentCdnUrl(value);
  const id =
    cdn?.id ??
    (url.host === "github.com" && !url.search
      ? (canonicalPath.exec(url.pathname) ?? legacyPath.exec(url.pathname))?.[1]?.toLowerCase()
      : undefined);
  return id ? { id, url: `https://github.com/user-attachments/assets/${id}` } : null;
}
