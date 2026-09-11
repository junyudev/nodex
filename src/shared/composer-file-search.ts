import type { ServerNotification } from "@nodex/codex-app-server-protocol";

export type ComposerFileSearchEvent = Extract<
  ServerNotification,
  { method: "fuzzyFileSearch/sessionUpdated" | "fuzzyFileSearch/sessionCompleted" }
>;

/** Presentation of a native search result in the composer's current workspace. */
export interface ComposerFileSearchMatch {
  readonly path: string;
  readonly fsPath: string;
  readonly label: string;
  readonly kind: "file" | "directory";
}
