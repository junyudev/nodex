import { REMOTE_FILESYSTEM_REASON } from "../../shared/space-connection";
import { openSpaceLink } from "@/features/spaces/spaces-runtime";
import {
  parseLocalFileLinkHref,
  parseFileReferenceLocation,
  type FileLinkOpenerId,
  type FileLinkTarget,
} from "../../shared/file-link-openers";
import { readFileLinkOpener } from "./file-link-opener-settings";
import { openFileLink, type FileLinkOpenPort } from "./file-system-operations";
import { DEFAULT_NFM_AUTOLINK_SETTINGS, shouldAutoLinkValue } from "./nfm-autolink-settings";
import { openLink } from "./link-opening";
import type { LinkOpenRequest } from "../../shared/link-opening";
import { isExternallyOpenableUrl } from "../../shared/browser-url-policy";
import { rendererSpaceId, isRemoteSpace } from "./renderer-space";
import { parsePageDeepLink, parseSessionDeepLink } from "@/lib/page-deeplink";

const LIKELY_RELATIVE_FILE_SUFFIXES = new Set([
  "avif",
  "bmp",
  "c",
  "cc",
  "cpp",
  "css",
  "csv",
  "doc",
  "docx",
  "gif",
  "go",
  "heic",
  "html",
  "htm",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "pdf",
  "php",
  "png",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

export type NfmResolvedLinkAction =
  | { kind: "space-link"; href: string }
  | { kind: "session"; href: string; sessionId: string }
  | { kind: "page"; href: string; pageId: string }
  | { kind: "local-file" | "workspace-file"; href: string; target: FileLinkTarget }
  | { kind: "web-url"; href: string; url: string }
  | { kind: "literal-anchor"; href: string }
  | { kind: "unresolved-file-like"; href: string; reason: string }
  | { kind: "blocked"; href: string; reason: string };

export interface NfmLinkNavigation {
  assign: (href: string) => void;
  open: (url: string, target: string, features: string) => void;
}

export interface NfmPageLinkNavigation {
  readonly openSession?: (sessionId: string) => void | Promise<void>;
  readonly openPage?: (pageId: string) => void | Promise<void>;
}

function hasExplicitProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isLiteralAnchorOrQuery(value: string): boolean {
  return value.startsWith("#") || value.startsWith("?");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function isLikelyRelativeFileLike(value: string): boolean {
  if (!value || isLiteralAnchorOrQuery(value) || hasExplicitProtocol(value)) {
    return false;
  }

  if (/^(?:\.{1,2}[\\/])/.test(value)) {
    return true;
  }

  if (/[\\/]/.test(value)) {
    return true;
  }

  const firstSegment = value.split(/[?#]/)[0] ?? "";
  const suffix = firstSegment.split(".").pop()?.toLowerCase();
  if (!suffix) return false;
  return LIKELY_RELATIVE_FILE_SUFFIXES.has(suffix);
}

function resolveRelativePathAgainstWorkspace(
  workspacePath: string,
  relativePath: string,
): string | null {
  const trimmedWorkspacePath = workspacePath.trim();
  const trimmedRelativePath = relativePath.trim();
  if (!trimmedWorkspacePath || !trimmedRelativePath) return null;

  const windowsBase = isWindowsAbsolutePath(trimmedWorkspacePath);
  const normalizedBase = trimmedWorkspacePath.replace(/\\/g, "/");
  const normalizedRelative = trimmedRelativePath.replace(/\\/g, "/");

  const baseSegments = normalizedBase.split("/").filter(Boolean);
  const relativeSegments = normalizedRelative.split("/").filter(Boolean);
  if (baseSegments.length === 0) return null;

  const resolvedSegments = [...baseSegments];
  for (const segment of relativeSegments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolvedSegments.length > 1) {
        resolvedSegments.pop();
      }
      continue;
    }
    resolvedSegments.push(segment);
  }

  const directory = /[\\/]$/u.test(trimmedRelativePath);
  if (windowsBase) {
    return resolvedSegments.join("\\") + (directory ? "\\" : "");
  }

  return `/${resolvedSegments.join("/")}${directory ? "/" : ""}`;
}

function resolveWorkspaceFileTarget(
  href: string,
  projectWorkspacePath?: string | null,
): FileLinkTarget | null {
  if (!projectWorkspacePath?.trim()) return null;

  const target = parseFileReferenceLocation(href);
  let path: string;
  try {
    path = decodeURIComponent(target.path);
  } catch {
    return null;
  }
  const resolvedPath = resolveRelativePathAgainstWorkspace(projectWorkspacePath, path);
  if (!resolvedPath) return null;

  return {
    ...target,
    path: resolvedPath,
  };
}

function buildOpenTimeWebUrl(href: string): string {
  if (hasExplicitProtocol(href)) {
    return href;
  }
  return `https://${href}`;
}

function resolveBlockedReason(href: string, projectWorkspacePath?: string | null): string {
  if (hasExplicitProtocol(href)) {
    return "Blocked unsupported link protocol.";
  }
  if (isLikelyRelativeFileLike(href) && !projectWorkspacePath?.trim()) {
    return "Cannot resolve relative file link without project workspace.";
  }
  if (isLikelyRelativeFileLike(href)) {
    return "Cannot resolve relative file link.";
  }
  return "Cannot open this link safely.";
}

export function resolveNfmLinkAction(
  href: string | undefined,
  projectWorkspacePath?: string | null,
): NfmResolvedLinkAction | null {
  if (typeof href !== "string") return null;

  const trimmed = href.trim();
  if (!trimmed) return null;

  const sessionTarget = parseSessionDeepLink(trimmed);
  if (sessionTarget?.spaceId && sessionTarget.spaceId !== rendererSpaceId())
    return { kind: "space-link", href: trimmed };
  if (sessionTarget) return { kind: "session", href: trimmed, sessionId: sessionTarget.sessionId };

  const pageTarget = parsePageDeepLink(trimmed);
  if (pageTarget?.spaceId && pageTarget.spaceId !== rendererSpaceId())
    return { kind: "space-link", href: trimmed };
  if (pageTarget) {
    return { kind: "page", href: trimmed, pageId: pageTarget.pageId };
  }

  const localFileTarget = parseLocalFileLinkHref(trimmed);
  if (localFileTarget) {
    if (isRemoteSpace())
      return { kind: "blocked", href: trimmed, reason: REMOTE_FILESYSTEM_REASON };
    return { kind: "local-file", href: trimmed, target: localFileTarget };
  }

  if (isLiteralAnchorOrQuery(trimmed)) {
    return { kind: "literal-anchor", href: trimmed };
  }

  if (
    isExternallyOpenableUrl(trimmed) ||
    (parseFileReferenceLocation(trimmed).line === undefined &&
      shouldAutoLinkValue(trimmed, DEFAULT_NFM_AUTOLINK_SETTINGS))
  ) {
    return {
      kind: "web-url",
      href: trimmed,
      url: buildOpenTimeWebUrl(trimmed),
    };
  }

  if (
    !isExternallyOpenableUrl(trimmed) &&
    (parseFileReferenceLocation(trimmed).line !== undefined ||
      isLikelyRelativeFileLike(parseFileReferenceLocation(trimmed).path))
  ) {
    if (isRemoteSpace())
      return { kind: "blocked", href: trimmed, reason: REMOTE_FILESYSTEM_REASON };
    const workspaceTarget = resolveWorkspaceFileTarget(trimmed, projectWorkspacePath);
    if (workspaceTarget) {
      return { kind: "workspace-file", href: trimmed, target: workspaceTarget };
    }

    return {
      kind: "unresolved-file-like",
      href: trimmed,
      reason: resolveBlockedReason(trimmed, projectWorkspacePath),
    };
  }

  if (hasExplicitProtocol(trimmed)) {
    return {
      kind: "blocked",
      href: trimmed,
      reason: resolveBlockedReason(trimmed, projectWorkspacePath),
    };
  }

  return {
    kind: "blocked",
    href: trimmed,
    reason: resolveBlockedReason(trimmed, projectWorkspacePath),
  };
}

export function resolveNfmLinkTooltipLabel(
  action: NfmResolvedLinkAction | null,
  showLocalFileTooltip: boolean,
): string | null {
  if (!action) return null;

  if (action.kind === "blocked" || action.kind === "unresolved-file-like") {
    return action.reason;
  }

  if ((action.kind === "local-file" || action.kind === "workspace-file") && showLocalFileTooltip) {
    if (!action.target.line) return action.target.path;
    if (action.target.endLine) {
      const start = action.target.column
        ? `${action.target.line}:${action.target.column}`
        : `${action.target.line}`;
      const end = action.target.endColumn
        ? `${action.target.endLine}:${action.target.endColumn}`
        : `${action.target.endLine}`;
      return `${action.target.path} (lines ${start}-${end})`;
    }
    if (!action.target.column) return `${action.target.path} (line ${action.target.line})`;
    return `${action.target.path} (line ${action.target.line}, column ${action.target.column})`;
  }

  return null;
}

export async function openNfmResolvedLinkAction(
  action: NfmResolvedLinkAction,
  opener: FileLinkOpenerId = readFileLinkOpener(),
  openFile: FileLinkOpenPort = openFileLink,
  navigation: NfmLinkNavigation = {
    assign: (href) => window.location.assign(href),
    open: () => undefined,
  },
  pageNavigation?: NfmPageLinkNavigation,
  linkRequest?: Omit<LinkOpenRequest, "url" | "initiator"> & {
    readonly openLink?: typeof openLink;
  },
): Promise<boolean> {
  if (action.kind === "blocked" || action.kind === "unresolved-file-like") {
    return false;
  }

  if (action.kind === "space-link") return openSpaceLink(action.href);
  if (action.kind === "web-url") {
    const { openLink: open = openLink, ...request } = linkRequest ?? {};
    return open({
      ...request,
      url: action.url,
      initiator: "markdown_link_click",
      ...(!/^https?:/iu.test(action.url) ? { useExternalBrowser: true } : {}),
    });
  }

  if (action.kind === "session") {
    if (!pageNavigation?.openSession) return false;
    await pageNavigation.openSession(action.sessionId);
    return true;
  }

  if (action.kind === "page") {
    if (!pageNavigation?.openPage) return false;
    await pageNavigation.openPage(action.pageId);
    return true;
  }

  if (action.kind === "literal-anchor") {
    navigation.assign(action.href);
    return true;
  }

  try {
    return await openFile(action.target, opener);
  } catch {
    return false;
  }
}
