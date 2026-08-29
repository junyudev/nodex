import type { DatabaseViewId } from "./database-identities";
import type {
  DatabaseViewPresentationOverride,
  DatabaseViewRulesOverride,
} from "./database-kernel";
import type { DatabaseViewDisclosureTargetV2 } from "./database-module-v2";

export const DATABASE_CHANGE_EVENT_VERSION = 3 as const;

export type DatabaseChangeSourceKind =
  | "database_module"
  | "database_mutation"
  | "block_transfer"
  | "page_lifecycle"
  | "nodex_agent_create"
  | "nodex_agent_transfer"
  | "nodex_agent_database_edit";

export type DatabasePersonalViewChange =
  | {
      readonly kind: "preferences";
      readonly viewId: DatabaseViewId;
      readonly rulesOverride: DatabaseViewRulesOverride;
      readonly presentationOverride: DatabaseViewPresentationOverride;
      readonly revision: number;
    }
  | {
      readonly kind: "occurrence_disclosure";
      readonly viewId: DatabaseViewId;
      readonly target: DatabaseViewDisclosureTargetV2;
      readonly collapsed: boolean;
    };

/**
 * Resource-scoped invalidation after one durable mutation touches Library
 * Database authority. Project remains the subscription/actor context; the
 * affected resource coordinates are canonical Library identities.
 */
export interface DatabaseChangeEvent {
  readonly version: typeof DATABASE_CHANGE_EVENT_VERSION;
  readonly projectId: string;
  readonly libraryId?: string;
  readonly storeEpoch: string;
  readonly operationId: string;
  readonly sourceKind: DatabaseChangeSourceKind;
  readonly affectedDatabaseIds: readonly string[];
  readonly affectedDataSourceIds?: readonly string[];
  readonly affectedPageIds?: readonly string[];
  readonly affectedViewIds?: readonly string[];
  readonly personalViewChanges: readonly DatabasePersonalViewChange[];
  readonly commitSeq: number;
}
