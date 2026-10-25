export interface WorkspaceTextSearchRequest {
  readonly requestId: string;
  readonly hostId: string;
  readonly roots: readonly string[];
  readonly query: string;
  readonly fileMask?: string;
  readonly priorityFolders?: readonly string[];
}

export interface WorkspaceTextSearchMatch {
  readonly path: string;
  readonly root: string;
  readonly relativePath: string;
  readonly line: number;
  /** One-based UTF-16 column in the original line. */
  readonly column: number;
  readonly preview: string;
  /** Zero-based UTF-16 offsets in the bounded preview. */
  readonly matchRanges: readonly { readonly start: number; readonly end: number }[];
}

export type WorkspaceTextSearchErrorCode =
  | "invalid-query"
  | "invalid-file-mask"
  | "unsupported-host"
  | "missing-ripgrep"
  | "search-failed";

export type WorkspaceTextSearchEvent = { readonly requestId: string } & (
  | { readonly type: "match"; readonly match: WorkspaceTextSearchMatch }
  | { readonly type: "done"; readonly limited: boolean }
  | {
      readonly type: "error";
      readonly code: WorkspaceTextSearchErrorCode;
      readonly message: string;
    }
);

export function isWorkspaceTextSearchQueryValid(query: string): boolean {
  return query.trim().length > 0 && query.length <= 256 && !/[\r\n\0]/u.test(query);
}

/** Commas inside glob braces/brackets or escaped commas belong to the mask. */
export function parseWorkspaceTextSearchFileMask(
  raw: string,
): { include: string[]; exclude: string[] } | null {
  if (raw.length > 256 || /[\r\n\0]/u.test(raw)) return null;
  const patterns: string[] = [];
  let start = 0;
  let braces = 0;
  let bracket = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === "[") bracket = true;
    else if (character === "]") {
      if (!bracket) return null;
      bracket = false;
    } else if (!bracket && character === "{") braces += 1;
    else if (!bracket && character === "}") braces -= 1;
    else if (!bracket && braces === 0 && character === ",") {
      patterns.push(raw.slice(start, index).trim());
      start = index + 1;
    }
    if (braces < 0) return null;
  }
  if (braces !== 0 || bracket || escaped) return null;
  patterns.push(raw.slice(start).trim());
  return {
    include: patterns.filter((pattern) => pattern.length > 0 && !pattern.startsWith("!")),
    exclude: patterns.filter((pattern) => pattern.startsWith("!")),
  };
}
