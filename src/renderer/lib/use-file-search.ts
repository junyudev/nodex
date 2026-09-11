import { useEffect, useRef, useState } from "react";
import type { FileSearchMatch, FileSearchScope } from "../../shared/file-search";
import { compactFileSearchRoots } from "../../shared/file-search-paths";
import { createFileSearchSession, type FileSearchController } from "./file-search-operations";
import { projectFileSearchResults } from "./file-search-results";

const EMPTY_MATCHES: readonly FileSearchMatch[] = [];

/** A mounted search owns one native session. Host/root changes and disposal release its index. */
export function useFileSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly scope: FileSearchScope | null;
}) {
  const query = input.query.trim();
  const hostId = input.scope?.hostId ?? "";
  const rootsKey = compactFileSearchRoots(input.scope?.roots ?? []).join("\0");
  const scopeKey = `${hostId}\0${rootsKey}`;
  const enabled = input.enabled && Boolean(hostId && rootsKey);
  const session = useRef<FileSearchController | null>(null);
  const [batch, setBatch] = useState<{
    query: string;
    scopeKey: string;
    matches: readonly FileSearchMatch[];
    completed: boolean;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const roots = rootsKey.split("\0");
    setBatch(null);
    const controller = createFileSearchSession({
      hostId,
      roots,
      onEvent: (event) => {
        if (!active) return;
        if (event.method === "fuzzyFileSearch/sessionUpdated") {
          setBatch({
            query: event.params.query,
            scopeKey,
            matches: projectFileSearchResults(event.params.files, event.params.query, roots),
            completed: false,
            error: null,
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
        .catch((error: unknown) => console.warn("Could not stop file search", error));
    };
  }, [enabled, hostId, rootsKey, scopeKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void session.current?.update(query).catch((error: unknown) => {
      if (cancelled) return;
      setBatch({
        query,
        scopeKey,
        matches: EMPTY_MATCHES,
        completed: true,
        error: error instanceof Error ? error.message : "Unable to search files",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, query, scopeKey]);

  if (!enabled || !query) return { matches: EMPTY_MATCHES, loading: false, error: null };
  if (batch?.query !== query || batch.scopeKey !== scopeKey)
    return { matches: EMPTY_MATCHES, loading: true, error: null };
  return { matches: batch.matches, loading: !batch.completed, error: batch.error };
}
