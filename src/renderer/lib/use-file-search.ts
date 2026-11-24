import { useEffect, useRef, useState } from "react";
import type {
  FileSearchIncomplete,
  FileSearchMatch,
  FileSearchScope,
} from "../../shared/file-search";
import { compactFileSearchRoots } from "../../shared/file-search-paths";
import { createFileSearchSession, type FileSearchController } from "./file-search-operations";
import { projectFileSearchResults } from "./file-search-results";

const EMPTY_MATCHES: readonly FileSearchMatch[] = [];
const UNAVAILABLE: FileSearchIncomplete = { reason: "unavailable" };

export interface FileSearchState {
  readonly matches: readonly FileSearchMatch[];
  readonly loading: boolean;
  /** Why the settled search did not cover every file; its matches remain usable. */
  readonly incomplete: FileSearchIncomplete | null;
  /** Searches the current query again after search could not run. */
  readonly retry: (() => void) | null;
}

interface Batch {
  readonly query: string;
  readonly scopeKey: string;
  readonly matches: readonly FileSearchMatch[];
  readonly completed: boolean;
  readonly incomplete: FileSearchIncomplete | null;
}

/** Settling never discards matches already shown for the same query. */
function settle(
  previous: Batch | null,
  next: Pick<Batch, "query" | "scopeKey" | "incomplete">,
): Batch {
  const same = previous?.query === next.query && previous.scopeKey === next.scopeKey;
  return { ...next, matches: same ? previous.matches : EMPTY_MATCHES, completed: true };
}

/** Sends one query; a rejection means search could not run it. */
function sendQuery(
  controller: FileSearchController | null,
  query: string,
  onUnavailable: () => void,
): void {
  void controller?.update(query).catch((error: unknown) => {
    console.warn("Could not search files", error);
    onUnavailable();
  });
}

/** A mounted search owns one session. Host/root changes and disposal release it. */
export function useFileSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly scope: FileSearchScope | null;
}): FileSearchState {
  const query = input.query.trim();
  const hostId = input.scope?.hostId ?? "";
  const rootsKey = compactFileSearchRoots(input.scope?.roots ?? []).join("\0");
  const scopeKey = `${hostId}\0${rootsKey}`;
  const enabled = input.enabled && Boolean(hostId && rootsKey);
  const session = useRef<FileSearchController | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);

  const [sessionIdentity, setSessionIdentity] = useState({ enabled, scopeKey });
  if (sessionIdentity.enabled !== enabled || sessionIdentity.scopeKey !== scopeKey) {
    setSessionIdentity({ enabled, scopeKey });
    if (enabled) setBatch(null);
  }

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const roots = rootsKey.split("\0");
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
            incomplete: null,
          });
          return;
        }
        const { query: settledQuery, incomplete = null } = event.params;
        setBatch((previous) =>
          settledQuery === undefined
            ? previous && { ...previous, completed: true, incomplete }
            : settle(previous, { query: settledQuery, scopeKey, incomplete }),
        );
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
    sendQuery(session.current, query, () => {
      if (cancelled) return;
      setBatch((previous) => settle(previous, { query, scopeKey, incomplete: UNAVAILABLE }));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, query, scopeKey]);

  if (!enabled || !query)
    return { matches: EMPTY_MATCHES, loading: false, incomplete: null, retry: null };
  if (batch?.query !== query || batch.scopeKey !== scopeKey)
    return { matches: EMPTY_MATCHES, loading: true, incomplete: null, retry: null };
  const incomplete = batch.completed ? batch.incomplete : null;
  return {
    matches: batch.matches,
    loading: !batch.completed,
    incomplete,
    retry:
      incomplete?.reason === "unavailable"
        ? () => {
            setBatch((previous) => previous && { ...previous, completed: false, incomplete: null });
            // A newer query or scope may have answered by the time a retry is refused.
            sendQuery(session.current, query, () =>
              setBatch((previous) =>
                previous?.query === query && previous.scopeKey === scopeKey
                  ? settle(previous, { query, scopeKey, incomplete: UNAVAILABLE })
                  : previous,
              ),
            );
          }
        : null,
  };
}
