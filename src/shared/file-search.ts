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

export interface FileSearchResult {
  readonly root: string;
  readonly path: string;
  readonly match_type: "file" | "directory";
  readonly file_name: string;
  readonly score: number;
  readonly indices: readonly number[] | null;
}

export type FileSearchEvent =
  | {
      readonly method: "fuzzyFileSearch/sessionUpdated";
      readonly params: FileSearchUpdateInput & { readonly files: readonly FileSearchResult[] };
    }
  | {
      readonly method: "fuzzyFileSearch/sessionCompleted";
      readonly params: FileSearchSessionRef & { readonly query?: string };
    }
  | { readonly method: "file-search/sessionFailed"; readonly params: FileSearchUpdateInput };

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

/** Presentation of one native result; fsPath is its identity across multiple roots. */
export interface FileSearchMatch {
  readonly root: string;
  readonly relativePath: string;
  readonly path: string;
  readonly fsPath: string;
  readonly label: string;
  readonly directoryPath: string;
  readonly kind: "file" | "directory";
}
