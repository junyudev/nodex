export interface CodexWebSearchCompletionView {
  webSearch?: {
    completed: boolean;
  } | null;
}

/**
 * Reads the semantic completion bit projected from app-server lifecycle state.
 * Web-search protocol items do not carry a canonical top-level status.
 */
export function isCodexWebSearchActivityInProgress(item: CodexWebSearchCompletionView): boolean {
  return item.webSearch?.completed === false;
}
