import type { Page } from "./page";
import type { ContentRoutingContext } from "./content-routing-context";

export interface ResolvePageTargetInput {
  /** Authority inherited from the content surface containing the reference. */
  readonly routingContext: ContentRoutingContext;
  readonly targetPageId: string;
}

interface PageTargetAuthority {
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

/**
 * Membership-independent read model for opening or previewing a Page.
 * Database properties and View position deliberately do not participate: a
 * Page may live in the Library, another Page, or a Data Source.
 */
export type PageTargetReadModel =
  | (PageTargetAuthority & {
      readonly status: "missing";
      readonly targetPageId: string;
    })
  | (PageTargetAuthority & {
      readonly status: "invalid_target";
      readonly targetPageId: string;
      readonly actualBlockType: string;
    })
  | (PageTargetAuthority & {
      readonly status: "deleted";
      readonly targetPageId: string;
    })
  | (PageTargetAuthority & {
      readonly status: "available";
      readonly targetPageId: string;
      readonly page: Page & {
        readonly lifecycle: "active" | "archived";
      };
      readonly document: {
        readonly readiness: "pending_genesis" | "ready" | "failed";
        readonly schemaKey: string;
        readonly schemaVersion: number;
      };
    });
