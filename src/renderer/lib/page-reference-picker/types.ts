import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import type { LibraryPageReferenceMatchSource } from "../../../shared/library-module";
import type { PageSearchMatch, PageSearchTextPart } from "../../../shared/types";
import type { WorkflowStatus } from "../../../shared/workflow-status";

export type PageReferenceIntent = "mention" | "reference_block" | "link";

export interface PageReferencePickerRequest {
  readonly routingContext: ContentRoutingContext;
  readonly hostPageId: string | null;
  readonly ancestorPageIds: readonly string[];
  readonly intent: PageReferenceIntent;
  readonly query: string;
  readonly limit: number;
}

export interface PageReferenceCandidate {
  readonly pageId: string;
  readonly title: string;
  readonly pageKey: string | null;
  readonly status: WorkflowStatus | null;
  readonly locationLabel: string;
  readonly lifecycle: "active" | "archived";
  readonly matchExcerpt: string | null;
  readonly matchSource: LibraryPageReferenceMatchSource;
  readonly titleParts: readonly PageSearchTextPart[];
  readonly matchExcerptParts: readonly PageSearchTextPart[];
  readonly matches: readonly PageSearchMatch[];
  readonly disabledReason: "self" | "ancestor_cycle" | null;
}

export interface PageReferenceSelection {
  readonly pageId: string;
  readonly titleSnapshot: string;
}
