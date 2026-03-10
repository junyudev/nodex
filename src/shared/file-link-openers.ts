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
}

export const DEFAULT_FILE_LINK_OPENER_ID: FileLinkOpenerId = "vscode";

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

function parseLineColumnFragment(fragment: string): Pick<FileLinkTarget, "line" | "column"> {
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(fragment.trim());
  if (!match) return {};

  const line = parsePositiveInteger(match[1]);
  const column = parsePositiveInteger(match[2]);
  if (!line) return {};

  return column ? { line, column } : { line };
}

function decodeFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    return decodeURIComponent(url.pathname);
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
    const match = FILE_LINK_OPENER_OPTIONS.find((option) =>
      option.id === canonical || option.id.toLowerCase() === lowercased);
    if (match) return match.id;
  }

  return DEFAULT_FILE_LINK_OPENER_ID;
}

export function parseLocalFileLinkHref(href: string): FileLinkTarget | null {
  if (typeof href !== "string") return null;

  const trimmed = href.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file://")) {
    const path = decodeFileUrlPath(trimmed);
    if (!path || !isAbsoluteLocalPath(path)) return null;

    const fragment = (() => {
      try {
        return new URL(trimmed).hash.replace(/^#/, "");
      } catch {
        return "";
      }
    })();

    return {
      path,
      ...parseLineColumnFragment(fragment),
    };
  }

  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";

  if (!isAbsoluteLocalPath(rawPath)) return null;

  return {
    path: rawPath,
    ...parseLineColumnFragment(fragment),
  };
}

export function formatFileLinkLocation(target: FileLinkTarget): string {
  const lineSuffix = target.line ? `:${target.line}` : "";
  const columnSuffix = target.line && target.column ? `:${target.column}` : "";
  return `${target.path}${lineSuffix}${columnSuffix}`;
}

export function buildFileUrl(target: FileLinkTarget): string {
  const encodedPath = encodeURI(target.path);
  const fragment = target.line
    ? `#L${target.line}${target.column ? `C${target.column}` : ""}`
    : "";
  if (/^[a-zA-Z]:[\\/]/.test(target.path)) {
    return `file:///${encodedPath.replace(/\\/g, "/")}${fragment}`;
  }
  return `file://${encodedPath}${fragment}`;
}
