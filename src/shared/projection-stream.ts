import type { components } from "@nodex/core-protocol";
import type { DatabasePageSummary } from "./types";

/** Renderer-derived resource impact for keyed cache repair. */
export type ProjectionImpact =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | {
      readonly kind: "resources";
      readonly page_ids: readonly string[];
      readonly database_ids: readonly string[];
      readonly data_source_ids: readonly string[];
      readonly view_ids: readonly string[];
      readonly document_heads: readonly {
        readonly page_id: string;
        readonly document_id: string;
        readonly generation: number;
        readonly head_seq: number;
      }[];
    };
export type LocalProjectionScope = components["schemas"]["LocalProjectionScope"];
export type CoreProjectionEffect = components["schemas"]["ProjectionEffect"];

/** Delivery coordinate for one renderer subscription. */
export type ProjectionScope =
  | { readonly kind: "library"; readonly libraryId: string }
  | {
      readonly kind: "project";
      readonly libraryId: string;
      readonly projectId: string;
    };

/** Durable stream progress. This is not a projection version. */
export interface ProjectionCursor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

/** Exact per-scope coordinate used for projection ordering. */
export interface ProjectionCoordinate {
  readonly storeEpoch: string;
  readonly scopeKey: string;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly coveredCommitSeq: number;
  readonly effectHash: string | null;
}

export type ProjectionPatch =
  | {
      readonly kind: "database_row_upsert";
      readonly projectId: string;
      readonly databaseId: string;
      readonly dataSourceId: string;
      readonly viewId: string;
      readonly row: DatabasePageSummary;
      readonly sourceRow: components["schemas"]["DatabaseRowSummary"];
      readonly effectiveGroupKey: string | null;
      readonly effectiveSubgroupKey: string | null;
      readonly rankKey: string | null;
      readonly totalRows: number;
      readonly groupTotal: number | null;
    }
  | {
      readonly kind: "database_row_remove";
      readonly projectId: string;
      readonly databaseId: string;
      readonly dataSourceId: string;
      readonly viewId: string;
      readonly pageId: string;
      readonly totalRows: number;
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
      readonly groupTotal: number | null;
    }
  | {
      readonly kind: "page_changed";
      readonly projectId: string;
      readonly pageId: string;
    };

export interface ProjectionEffect {
  readonly scope: CoreProjectionEffect["scope"];
  readonly baseRevision: number;
  readonly resultRevision: number;
  readonly coveredCommitSeq: number;
  readonly patch: ProjectionPatch | null;
  readonly requiresReadAtLeast: boolean;
  readonly effectHash: string;
}

export interface ProjectionDelivery {
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly manifestHash: string;
  readonly operationId: string;
  readonly committedAt: string;
  readonly impact: ProjectionImpact;
  readonly effect: ProjectionEffect;
}

export type ProjectionStreamMessage =
  | {
      readonly version: 2;
      readonly kind: "checkpoint";
      readonly scope: ProjectionScope;
      readonly stream: ProjectionCursor;
    }
  | {
      readonly version: 2;
      readonly kind: "effect";
      readonly scope: ProjectionScope;
      readonly stream: ProjectionCursor;
      readonly delivery: ProjectionDelivery;
    }
  | {
      readonly version: 2;
      readonly kind: "reset";
      readonly scope: ProjectionScope;
      readonly stream: ProjectionCursor;
      readonly reason:
        | "event_gap"
        | "reconnect"
        | "store_epoch_changed"
        | "projection_integrity_failure";
    };

export const projectionScopeKey = (scope: ProjectionScope): string =>
  scope.kind === "library"
    ? JSON.stringify(["library", scope.libraryId])
    : JSON.stringify(["project", scope.libraryId, scope.projectId]);

export const projectionCursorCovers = (
  actual: ProjectionCursor | null,
  required: ProjectionCursor,
): boolean => actual?.storeEpoch === required.storeEpoch && actual.commitSeq >= required.commitSeq;

export const projectionCoordinateFromSnapshot = (input: {
  readonly storeEpoch: string;
  readonly projection: {
    readonly scopeKey: string;
    readonly schemaVersion: number;
    readonly revision: number;
    readonly coveredCommitSeq: number;
    readonly effectHash: string | null;
  };
}): ProjectionCoordinate => ({
  storeEpoch: input.storeEpoch,
  ...input.projection,
});
