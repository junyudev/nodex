import type {
  FuzzyFileSearchSessionStartParams,
  ServerNotification,
} from "@nodex/codex-app-server-protocol";

/** Search roots are paths on this execution Host, never paths resolved by the renderer's OS. */
export interface FileSearchScope {
  readonly hostId: string;
  readonly roots: readonly string[];
}

export type FileSearchStartInput = FuzzyFileSearchSessionStartParams &
  Pick<FileSearchScope, "hostId">;
export type FileSearchEvent = Extract<
  ServerNotification,
  { method: "fuzzyFileSearch/sessionUpdated" | "fuzzyFileSearch/sessionCompleted" }
>;

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
