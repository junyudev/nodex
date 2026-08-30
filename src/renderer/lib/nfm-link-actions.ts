import {
  parseLocalFileLinkHref,
  type FileLinkOpenerId,
  type FileLinkTarget,
} from "../../shared/file-link-openers";
import { readFileLinkOpener } from "./file-link-opener-settings";
import { openFileLink, type FileLinkOpenPort } from "./file-system-operations";
import { DEFAULT_NFM_AUTOLINK_SETTINGS, shouldAutoLinkValue } from "./nfm-autolink-settings";
import { parsePageDeepLink } from "../../shared/nodex-deeplink";

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
  readonly openPage: (pageId: string) => void | Promise<void>;
}

function hasExplicitProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isLiteralAnchorOrQuery(value: string): boolean {
  return value.startsWith("#") || value.startsWith("?");
}

function splitHash(value: string): { pathPart: string; fragment: string } {
  const hashIndex = value.indexOf("#");
  if (hashIndex < 0) {
    return { pathPart: value, fragment: "" };
  }

  return {
    pathPart: value.slice(0, hashIndex),
    fragment: value.slice(hashIndex + 1),
  };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseLineColumnFragment(
  fragment: string,
): Pick<FileLinkTarget, "line" | "column" | "endLine" | "endColumn"> {
  const match = /^L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i.exec(fragment.trim());
  if (!match) return {};

  const line = parsePositiveInteger(match[1]);
  const column = parsePositiveInteger(match[2]);
  if (!line) return {};

  const endLine = parsePositiveInteger(match[3]);
  const endColumn = parsePositiveInteger(match[4]);
  return {
    line,
    ...(column ? { column } : {}),
    ...(endLine ? { endLine } : {}),
    ...(endColumn ? { endColumn } : {}),
  };
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

  if (windowsBase) {
    return resolvedSegments.join("\\");
  }

  return `/${resolvedSegments.join("/")}`;
}

function resolveWorkspaceFileTarget(
  href: string,
  projectWorkspacePath?: string | null,
): FileLinkTarget | null {
  if (!projectWorkspacePath?.trim()) return null;

  const { pathPart, fragment } = splitHash(href);
  const resolvedPath = resolveRelativePathAgainstWorkspace(projectWorkspacePath, pathPart);
  if (!resolvedPath) return null;

  return {
    path: resolvedPath,
    ...parseLineColumnFragment(fragment),
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

  const pageTarget = parsePageDeepLink(trimmed);
  if (pageTarget) {
    return { kind: "page", href: trimmed, pageId: pageTarget.pageId };
  }

  const localFileTarget = parseLocalFileLinkHref(trimmed);
  if (localFileTarget) {
    return { kind: "local-file", href: trimmed, target: localFileTarget };
  }

  if (isLiteralAnchorOrQuery(trimmed)) {
    return { kind: "literal-anchor", href: trimmed };
  }

  if (shouldAutoLinkValue(trimmed, DEFAULT_NFM_AUTOLINK_SETTINGS)) {
    return {
      kind: "web-url",
      href: trimmed,
      url: buildOpenTimeWebUrl(trimmed),
    };
  }

  if (isLikelyRelativeFileLike(trimmed)) {
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
    open: (url, target, features) => {
      window.open(url, target, features);
    },
  },
  pageNavigation?: NfmPageLinkNavigation,
): Promise<boolean> {
  if (action.kind === "blocked" || action.kind === "unresolved-file-like") {
    return false;
  }

  if (action.kind === "web-url") {
    navigation.open(action.url, "_blank", "noopener,noreferrer");
    return true;
  }

  if (action.kind === "page") {
    if (!pageNavigation) return false;
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
