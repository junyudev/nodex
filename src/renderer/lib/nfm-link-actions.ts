import { getIntl, type IntlShape } from "@/lib/i18n";
import { SPACE_ACTION_REASON_MESSAGES } from "../../shared/space-connection";
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
import { isRemoteSpace } from "./renderer-space";
import {
  parseNodexDestination,
  type NodexDestination,
  type NodexReferenceGesture,
} from "../../shared/nodex-reference";
import type { NodexReferenceRouter, NodexReferenceSource } from "./nodex-reference-router";

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
  | { kind: "nodex"; href: string; destination: NodexDestination }
  | { kind: "local-file" | "workspace-file"; href: string; target: FileLinkTarget }
  | { kind: "web-url"; href: string; url: string }
  | { kind: "literal-anchor"; href: string }
  | { kind: "unresolved-file-like"; href: string; reason: string }
  | { kind: "blocked"; href: string; reason: string };

export interface NfmLinkNavigation {
  assign: (href: string) => void;
  open: (url: string, target: string, features: string) => void;
}

/** A Nodex link opens through the Workbench reference router, relative to its surface. */
export interface NfmReferenceNavigation {
  readonly router: NodexReferenceRouter | null;
  readonly source: NodexReferenceSource;
  readonly gesture: NodexReferenceGesture;
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

function resolveBlockedReason(
  href: string,
  projectWorkspacePath: string | null | undefined,
  intl: IntlShape,
): string {
  if (hasExplicitProtocol(href)) {
    return intl.formatMessage({
      id: "lib.nfmLinkActions.protocol",
      defaultMessage: "Blocked unsupported link protocol.",
    });
  }
  if (isLikelyRelativeFileLike(href) && !projectWorkspacePath?.trim()) {
    return intl.formatMessage({
      id: "lib.nfmLinkActions.workspace",
      defaultMessage: "Cannot resolve relative file link without project workspace.",
    });
  }
  if (isLikelyRelativeFileLike(href)) {
    return intl.formatMessage({
      id: "lib.nfmLinkActions.relative",
      defaultMessage: "Cannot resolve relative file link.",
    });
  }
  return intl.formatMessage({
    id: "lib.nfmLinkActions.unsafe",
    defaultMessage: "Cannot open this link safely.",
  });
}

export function resolveNfmLinkAction(
  href: string | undefined,
  projectWorkspacePath?: string | null,
  intl: IntlShape = getIntl(),
): NfmResolvedLinkAction | null {
  if (typeof href !== "string") return null;

  const trimmed = href.trim();
  if (!trimmed) return null;

  const destination = parseNodexDestination(trimmed);
  if (destination) return { kind: "nodex", href: trimmed, destination };

  const localFileTarget = parseLocalFileLinkHref(trimmed);
  if (localFileTarget) {
    if (isRemoteSpace())
      return {
        kind: "blocked",
        href: trimmed,
        reason: intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.remoteFilesystem),
      };
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
      return {
        kind: "blocked",
        href: trimmed,
        reason: intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.remoteFilesystem),
      };
    const workspaceTarget = resolveWorkspaceFileTarget(trimmed, projectWorkspacePath);
    if (workspaceTarget) {
      return { kind: "workspace-file", href: trimmed, target: workspaceTarget };
    }

    return {
      kind: "unresolved-file-like",
      href: trimmed,
      reason: resolveBlockedReason(trimmed, projectWorkspacePath, intl),
    };
  }

  if (hasExplicitProtocol(trimmed)) {
    return {
      kind: "blocked",
      href: trimmed,
      reason: resolveBlockedReason(trimmed, projectWorkspacePath, intl),
    };
  }

  return {
    kind: "blocked",
    href: trimmed,
    reason: resolveBlockedReason(trimmed, projectWorkspacePath, intl),
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
  reference?: NfmReferenceNavigation,
  linkRequest?: Omit<LinkOpenRequest, "url" | "initiator"> & {
    readonly openLink?: typeof openLink;
  },
): Promise<boolean> {
  if (action.kind === "blocked" || action.kind === "unresolved-file-like") {
    return false;
  }

  if (action.kind === "nodex") {
    if (!reference?.router) return false;
    const outcome = await reference.router.open(action.destination, {
      source: reference.source,
      gesture: reference.gesture,
    });
    return outcome !== "failed";
  }
  if (action.kind === "web-url") {
    const { openLink: open = openLink, ...request } = linkRequest ?? {};
    return open({
      ...request,
      url: action.url,
      initiator: "markdown_link_click",
      ...(!/^https?:/iu.test(action.url) ? { useExternalBrowser: true } : {}),
    });
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
