import { useInteractivePageSearch } from "@/lib/interactive-page-search";
import { pageSearchResultsToReferenceCandidates } from "@/lib/page-reference-picker/search-controller";

/** The current Project promotes suggestions across the readable Library. */
export function useComposerPageSuggestions(query: string, preferredProjectId?: string | null) {
  const search = useInteractivePageSearch({ query, preferredProjectId, limit: 8 });
  return {
    items: pageSearchResultsToReferenceCandidates(
      {
        routingContext: { kind: "library" },
        hostPageId: null,
        ancestorPageIds: [],
        intent: "mention",
        query,
        limit: 8,
      },
      search.rows,
    ),
    loading: search.enrichment === "loading",
  };
}
