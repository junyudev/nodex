export type FileLinkOpenerId =
  | "vscode"
  | "vscodeInsiders"
  | "cursor"
  | "bbedit"
  | "sublimeText"
  | "windsurf"
  | "antigravity"
  | "fileManager"
  | "terminal"
  | "iterm2"
  | "ghostty"
  | "warp"
  | "xcode"
  | "androidStudio"
  | "intellij"
  | "goland"
  | "rustrover"
  | "pycharm"
  | "webstorm"
  | "zed"
  | "textmate";

export interface FileLinkOpenerOption {
  id: FileLinkOpenerId;
  label: string;
  icon: string;
}

export interface FileLinkTarget {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export const DEFAULT_FILE_LINK_OPENER_ID: FileLinkOpenerId = "vscode";

export function getFileManagerName(platform: string): string {
  if (/^(darwin|mac)/iu.test(platform)) return "Finder";
  if (/^win/iu.test(platform)) return "File Explorer";
  return "File Manager";
}

export function getFileManagerRevealLabel(platform: string): string {
  const manager = getFileManagerName(platform);
  if (manager === "Finder") return "Reveal in Finder";
  if (manager === "File Explorer") return "Open in Explorer";
  return `Open in ${manager}`;
}

export const FILE_LINK_OPENER_OPTIONS: FileLinkOpenerOption[] = [
  { id: "vscode", label: "VS Code", icon: "vscode.png" },
  { id: "vscodeInsiders", label: "VS Code Insiders", icon: "vscode-insiders.png" },
  { id: "cursor", label: "Cursor", icon: "cursor.png" },
  { id: "bbedit", label: "BBEdit", icon: "bbedit.png" },
  { id: "sublimeText", label: "Sublime Text", icon: "sublime-text.png" },
  { id: "windsurf", label: "Windsurf", icon: "windsurf.png" },
  { id: "antigravity", label: "Antigravity", icon: "antigravity.png" },
  { id: "fileManager", label: "Finder", icon: "finder.png" },
  { id: "terminal", label: "Terminal", icon: "terminal.png" },
  { id: "iterm2", label: "iTerm2", icon: "iterm2.png" },
  { id: "ghostty", label: "Ghostty", icon: "ghostty.png" },
  { id: "warp", label: "Warp", icon: "warp.png" },
  { id: "xcode", label: "Xcode", icon: "xcode.png" },
  { id: "androidStudio", label: "Android Studio", icon: "android-studio.png" },
  { id: "intellij", label: "IntelliJ IDEA", icon: "intellij.png" },
  { id: "goland", label: "GoLand", icon: "goland.png" },
  { id: "rustrover", label: "RustRover", icon: "rustrover.png" },
  { id: "pycharm", label: "PyCharm", icon: "pycharm.png" },
  { id: "webstorm", label: "WebStorm", icon: "webstorm.svg" },
  { id: "zed", label: "Zed", icon: "zed.png" },
  { id: "textmate", label: "TextMate", icon: "textmate.png" },
];

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function isAbsoluteLocalPath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("/")) return true;
  return /^[a-zA-Z]:[\\/]/.test(value);
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

function decodeFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    if (url.host && url.host !== "localhost") return `//${url.host}${path}`;
    return /^\/[a-z]:[\\/]/iu.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

export function normalizeFileLinkOpenerId(value: unknown): FileLinkOpenerId {
  if (typeof value === "string") {
    const normalized = value.trim();
    const lowercased = normalized.toLowerCase();
    const aliasMap: Record<string, FileLinkOpenerId> = {
      finder: "fileManager",
      "android-studio": "androidStudio",
      "intellij-idea": "intellij",
      filemanager: "fileManager",
    };
    const canonical = aliasMap[normalized] ?? aliasMap[lowercased] ?? normalized;
    const match = FILE_LINK_OPENER_OPTIONS.find(
      (option) => option.id === canonical || option.id.toLowerCase() === lowercased,
    );
    if (match) return match.id;
  }

  return DEFAULT_FILE_LINK_OPENER_ID;
}

/** One location grammar for native paths, URI paths and relative Markdown references. */
export function parseFileReferenceLocation(value: string): FileLinkTarget {
  const hash = /#(L\d+(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?)$/iu.exec(value);
  if (hash)
    return {
      path: value.slice(0, hash.index),
      ...parseLineColumnFragment(hash[1]!.replace("–", "-")),
    };
  const suffix = /:(\d+)(?::(\d+))?(?:[-–](\d+)(?::(\d+))?)?$/u.exec(value);
  if (!suffix || !parsePositiveInteger(suffix[1])) return { path: value };
  return {
    path: value.slice(0, suffix.index),
    line: parsePositiveInteger(suffix[1]),
    ...(parsePositiveInteger(suffix[2]) ? { column: parsePositiveInteger(suffix[2]) } : {}),
    ...(parsePositiveInteger(suffix[3]) ? { endLine: parsePositiveInteger(suffix[3]) } : {}),
    ...(parsePositiveInteger(suffix[4]) ? { endColumn: parsePositiveInteger(suffix[4]) } : {}),
  };
}

export function parseLocalFileLinkHref(href: string): FileLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file:")) {
    try {
      const url = new URL(trimmed);
      const location = parseFileReferenceLocation(url.pathname);
      url.pathname = location.path;
      const path = decodeFileUrlPath(url.toString());
      if (!path || !isAbsoluteLocalPath(path)) return null;
      return { ...location, path, ...parseLineColumnFragment(url.hash.slice(1)) };
    } catch {
      return null;
    }
  }
  const reference = parseFileReferenceLocation(trimmed);
  const target = reference.line ? reference : { path: reference.path.split("#")[0]! };
  if (!isAbsoluteLocalPath(target.path)) return null;
  try {
    return { ...target, path: decodeURIComponent(target.path) };
  } catch {
    return null;
  }
}

export function formatFileLinkLocation(target: FileLinkTarget): string {
  const lineSuffix = target.line ? `:${target.line}` : "";
  const columnSuffix = target.line && target.column ? `:${target.column}` : "";
  const endLineSuffix = target.endLine
    ? `-${target.endLine}${target.endColumn ? `:${target.endColumn}` : ""}`
    : "";
  return `${target.path}${lineSuffix}${columnSuffix}${endLineSuffix}`;
}

export function buildFileUrl(target: FileLinkTarget): string {
  const encodedPath = target.path
    .replace(/\\/gu, "/")
    .split("/")
    .map((part, index) =>
      index === 0 && /^[a-z]:$/iu.test(part) ? part : encodeURIComponent(part),
    )
    .join("/");
  const fragment = target.line
    ? `#L${target.line}${target.column ? `C${target.column}` : ""}${target.endLine ? `-L${target.endLine}${target.endColumn ? `C${target.endColumn}` : ""}` : ""}`
    : "";
  if (/^[a-zA-Z]:[\\/]/.test(target.path)) {
    return `file:///${encodedPath.replace(/\\/g, "/")}${fragment}`;
  }
  if (encodedPath.startsWith("//")) return `file://${encodedPath.slice(2)}${fragment}`;
  return `file://${encodedPath}${fragment}`;
}
