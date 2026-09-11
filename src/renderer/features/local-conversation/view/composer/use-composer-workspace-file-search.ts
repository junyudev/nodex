import { useEffect, useRef, useState } from "react";
import type { ComposerFileSearchMatch } from "../../../../../shared/composer-file-search";
import {
  createComposerFileSearchSession,
  type ComposerFileSearchController,
} from "../../composer-file-search-operations";
import { projectComposerFileSearchResults } from "../../composer-file-search-results";

const EMPTY_MATCHES: readonly ComposerFileSearchMatch[] = [];

/** The menu owns a native search session; streamed results belong to its roots and live query. */
export function useComposerWorkspaceFileSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly workspaceRoot: string | null;
}) {
  const query = input.query.trim();
  const workspaceRoot = input.workspaceRoot?.trim() ?? "";
  const enabled = input.enabled && Boolean(workspaceRoot);
  const session = useRef<ComposerFileSearchController | null>(null);
  const [batch, setBatch] = useState<{
    query: string;
    workspaceRoot: string;
    matches: readonly ComposerFileSearchMatch[];
    completed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setBatch(null);
    const controller = createComposerFileSearchSession({
      roots: [workspaceRoot],
      onEvent: (event) => {
        if (!active) return;
        if (event.method === "fuzzyFileSearch/sessionUpdated") {
          setBatch({
            query: event.params.query,
            workspaceRoot,
            matches: projectComposerFileSearchResults(event.params.files, event.params.query),
            completed: false,
          });
          return;
        }
        setBatch((previous) => previous && { ...previous, completed: true });
      },
    });
    session.current = controller;
    return () => {
      active = false;
      session.current = null;
      void controller
        .stop()
        .catch((error: unknown) => console.warn("Could not stop composer file search", error));
    };
  }, [enabled, workspaceRoot]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void session.current?.update(query).catch(() => {
      if (!cancelled) setBatch({ query, workspaceRoot, matches: EMPTY_MATCHES, completed: true });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, query, workspaceRoot]);

  if (!enabled || !query) return { matches: EMPTY_MATCHES, loading: false };
  if (batch?.query !== query || batch.workspaceRoot !== workspaceRoot)
    return { matches: EMPTY_MATCHES, loading: true };
  return { matches: batch.matches, loading: !batch.completed };
}
