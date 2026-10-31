import { useEffect, useMemo, useState } from "react";
import { useInteractivePageSearch } from "@/lib/interactive-page-search";
import {
  createPageReferenceSearchController,
  pageSearchResultsToReferenceCandidates,
} from "@/lib/page-reference-picker/search-controller";
import type {
  PageReferenceCandidate,
  PageReferencePickerRequest,
} from "@/lib/page-reference-picker/types";

/** Library search intentionally has no Session Project filter. Metadata stays available immediately. */
export function useComposerPageSuggestions(query: string) {
  const [controller] = useState(createPageReferenceSearchController);
  const [result, setResult] = useState<{
    query: string;
    items: readonly PageReferenceCandidate[] | null;
  } | null>(null);
  const request = useMemo<PageReferencePickerRequest>(
    () => ({
      routingContext: { kind: "library" },
      hostPageId: null,
      ancestorPageIds: [],
      intent: "mention",
      query,
      limit: 8,
    }),
    [query],
  );
  const metadata = useInteractivePageSearch({ projectIds: [], query, complete: false, limit: 8 });
  useEffect(() => {
    let active = true;
    void controller
      .search(request)
      .then((response) => {
        if (active && response.status === "current") setResult({ query, items: response.items });
      })
      .catch(() => {
        if (active) setResult({ query, items: null });
      });
    return () => {
      active = false;
    };
  }, [controller, query, request]);
  const current = result?.query === query ? result : null;
  const preview = pageSearchResultsToReferenceCandidates(request, metadata.rows);
  const items = current?.items ?? preview;
  return { items, loading: current === null };
}
