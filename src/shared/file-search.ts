/** Search roots are paths on this execution Host, never paths resolved by the renderer's OS. */
export interface FileSearchScope {
  readonly hostId: string;
  readonly roots: readonly string[];
}

export interface FileSearchSessionRef {
  readonly sessionId: string;
}

export interface FileSearchStartInput extends FileSearchSessionRef, FileSearchScope {}

export interface FileSearchUpdateInput extends FileSearchSessionRef {
  readonly query: string;
}

/**
 * One ranked match. Results arrive in their final order: higher score first, then path.
 * `indices` are ascending, unique positions in `path` counted in grapheme clusters, the
 * unit the matcher compares, so a highlight never splits a character.
 */
export interface FileSearchResult {
  readonly root: string;
  readonly path: string;
  readonly match_type: "file" | "directory";
  readonly file_name: string;
  readonly score: number;
  readonly indices: readonly number[] | null;
}

/**
 * Why a settled search did not cover every name below its roots. `too-large` means a folder
 * holds more than search can list within its bounds; the others mean a folder could not be
 * listed at all. Matches found elsewhere remain valid either way.
 */
export type FileSearchIncompleteReason = "too-large" | "missing" | "unreadable" | "unavailable";

export interface FileSearchIncomplete {
  readonly reason: FileSearchIncompleteReason;
  /** The first affected root, in session order; absent when search itself could not run. */
  readonly root?: string;
}

/**
 * A search never fails as a whole: it settles with the matches it found and, when it could
 * not search everything, the first reason why.
 */
export type FileSearchEvent =
  | {
      readonly method: "fuzzyFileSearch/sessionUpdated";
      readonly params: FileSearchUpdateInput & { readonly files: readonly FileSearchResult[] };
    }
  | {
      readonly method: "fuzzyFileSearch/sessionCompleted";
      readonly params: FileSearchSessionRef & {
        readonly query?: string;
        readonly incomplete?: FileSearchIncomplete;
      };
    };

export const FILE_SEARCH_EXCLUDED_SEGMENTS = [
  ".git",
  ".hg",
  ".next",
  ".pnpm-store",
  ".svn",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
] as const;

export interface FileSearchTextRange {
  readonly start: number;
  readonly end: number;
}

/** Presentation of one native result; fsPath is its identity across multiple roots. */
export interface FileSearchMatch {
  readonly root: string;
  readonly relativePath: string;
  readonly path: string;
  readonly fsPath: string;
  readonly label: string;
  readonly directoryPath: string;
  readonly kind: "file" | "directory";
  /** The characters the search matched, as UTF-16 ranges in `label` and `directoryPath`. */
  readonly matched?: {
    readonly label: readonly FileSearchTextRange[];
    readonly directory: readonly FileSearchTextRange[];
  };
}
