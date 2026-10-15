import type { ContentRoutingContext } from "./content-routing-context";

export interface ResolvePageOwnershipPathInput {
  /** Presentation routing inherited from the Page surface requesting the breadcrumb. */
  readonly routingContext: ContentRoutingContext;
  readonly targetPageId: string;
}

export interface PageOwnershipPathAncestor {
  readonly pageId: string;
  readonly title: string;
  readonly lifecycle: "active" | "archived";
}

/**
 * Canonical Page ownership path in the current Library, with presentation routing.
 * Ancestors are ordered from the highest visible parent to the direct parent.
 */
export type PageOwnershipPathReadModel =
  | {
      readonly libraryId: string;
      readonly storeEpoch: string;
      readonly commitSeq: number;
      readonly status: "missing";
      readonly targetPageId: string;
    }
  | {
      readonly libraryId: string;
      readonly storeEpoch: string;
      readonly commitSeq: number;
      readonly status: "available";
      readonly targetPageId: string;
      readonly ancestors: readonly PageOwnershipPathAncestor[];
    };
