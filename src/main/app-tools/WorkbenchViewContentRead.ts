import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import { contentAccessContextKey } from "../../shared/content-access-context";
import type { WorkbenchViewSnapshot } from "../../shared/nodex-app-tools/workbench-view-content";
import { toCoreAgentExecutionAuthorization } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { toCoreDatabaseViewPreferencesOverride } from "../core-client/database-presentation-adapter";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import type { WorkbenchContentReadInput } from "./WorkbenchContentRead";

type CoreQueryResult = components["schemas"]["DatabaseDisplayedViewQueryResult"];
type QueryFailureStatus =
  | "access_denied"
  | "unavailable"
  | "stale_presentation"
  | "surface_unavailable"
  | "pending_presentation"
  | "cancelled"
  | "result_too_large";

export type WorkbenchViewContentReadResult =
  | { readonly status: QueryFailureStatus }
  | {
      readonly status: "ready";
      readonly kind: "database_view";
      readonly readiness: "observed" | "effective_query";
      readonly observedAt: string;
      readonly query: CoreQueryResult;
      readonly display: Omit<WorkbenchViewSnapshot, "status" | "occurrences">;
      readonly collapseTreatment: "captured_selection" | "ignored";
    };

const coordinate = (
  snapshot: WorkbenchViewSnapshot,
): components["schemas"]["DatabaseEffectiveViewCoordinate"] => ({
  database_id: snapshot.databaseId,
  data_source_id: snapshot.dataSourceId,
  view_id: snapshot.databaseViewId,
  expected_view_revision: snapshot.viewRevision,
  expected_schema_revision: snapshot.schemaRevision,
  expected_preferences_revision: snapshot.preferencesRevision,
  preferences_override: toCoreDatabaseViewPreferencesOverride(snapshot.preferencesOverride),
  search_query: snapshot.search.deferred,
});

const occurrences = (
  snapshot: WorkbenchViewSnapshot,
): components["schemas"]["DatabaseObservedOccurrence"][] =>
  snapshot.occurrences.map((occurrence) => ({
    occurrence_key: occurrence.occurrenceKey,
    page_id: occurrence.pageId,
    group_path: occurrence.groupPath,
    ancestor_page_ids: occurrence.ancestorPageIds,
    condition: {
      metadata_revision: occurrence.condition.metadataRevision,
      parent_revision: occurrence.condition.parentRevision,
      document_id: occurrence.condition.documentId,
      document_generation: occurrence.condition.documentGeneration,
      document_head_seq: occurrence.condition.documentHeadSeq,
      membership_id: occurrence.condition.membershipId,
      membership_revision: occurrence.condition.membershipRevision,
      database_value_revisions: occurrence.condition.databaseValueRevisions,
      position_revision: occurrence.condition.positionRevision,
      rank_key: occurrence.condition.rankKey,
    },
  }));

const queryFailure = (error: { readonly cause?: unknown }): WorkbenchViewContentReadResult => {
  if (!(error.cause instanceof CoreModuleResponseError)) return { status: "unavailable" };
  const code = error.cause.coreError.code;
  if (code === "revision_conflict") return { status: "stale_presentation" };
  if (code === "unauthorized") return { status: "access_denied" };
  if (code === "resource_exhausted") return { status: "result_too_large" };
  if (code === "cancelled") return { status: "cancelled" };
  return { status: "unavailable" };
};

/** Uses the renderer only for bounded presentation coordinates; Core owns every returned row value. */
export const make = Effect.gen(function* () {
  const bridge = yield* WorkbenchAgentBridge;
  const core = yield* CoreModules;
  const identity = yield* CoreAuthority;

  return Effect.fn("WorkbenchViewContentRead.read")(function* (
    input: WorkbenchContentReadInput,
    purpose: "display" | "effective_query",
  ): Effect.fn.Return<WorkbenchViewContentReadResult> {
    if (!(yield* input.isCurrent)) return { status: "cancelled" };
    const description = input.description;
    if (description.status !== "authorized" || description.kind !== "database_view")
      return { status: "access_denied" };
    if (!input.live) return { status: "surface_unavailable" };
    const captured = yield* bridge
      .request(input.live.reference, {
        kind: "capture_view",
        sceneOwner: input.live.reference.sceneOwner,
        tabId: input.live.tabId,
        expectedPresentationRevision: input.live.expectedPresentationRevision,
        purpose,
        range: input.range ?? "viewport",
        offset: input.offset ?? 0,
        limit:
          purpose === "effective_query" ? Math.min(input.limit ?? 50, 200) : (input.limit ?? 50),
      })
      .pipe(
        Effect.map((reply) => reply.capture),
        Effect.catch(() => Effect.succeed({ status: "surface_unavailable" as const })),
      );
    if (!(yield* input.isCurrent)) return { status: "cancelled" };
    if (captured.status !== "ready") return captured;
    if (
      captured.libraryId !== description.libraryId ||
      captured.libraryId !== input.authority.libraryId ||
      captured.databaseId !== description.databaseId ||
      captured.dataSourceId !== description.dataSourceId ||
      captured.databaseViewId !== description.viewId ||
      captured.layout !== description.layout ||
      captured.storeEpoch !== input.authority.storeEpoch ||
      contentAccessContextKey(captured.accessContext) !==
        contentAccessContextKey(description.displayedAccessContext)
    )
      return { status: "stale_presentation" };
    if (
      captured.search.pending ||
      captured.search.current !== captured.search.deferred ||
      Object.values(captured.pending).some(Boolean)
    )
      return { status: "pending_presentation" };
    if (
      purpose === "display" &&
      captured.coverage.range === "viewport" &&
      !captured.coverage.viewportKnown
    )
      return { status: "surface_unavailable" };
    const result = yield* core.query
      .read(
        {
          kind: "agent_displayed_view_query",
          authorization: toCoreAgentExecutionAuthorization(
            identity.identity.profileId,
            input.authority,
            input.callId,
            input.taskAccess,
          ),
          coordinate: coordinate(captured),
          projection_property_ids: input.propertyIds ? [...input.propertyIds] : null,
          selection:
            purpose === "display"
              ? { kind: "observed", occurrences: occurrences(captured) }
              : { kind: "effective", limit: input.limit ?? null },
        },
        input.authority.actorProjectId,
        { deadlineMs: 10_000 },
      )
      .pipe(
        Effect.map((snapshot) => ({ status: "snapshot" as const, snapshot })),
        Effect.catch((error) => Effect.succeed(queryFailure(error))),
      );
    if (!(yield* input.isCurrent)) return { status: "cancelled" };
    if (result.status !== "snapshot") return result;
    const snapshot = result.snapshot;
    if (snapshot.store_epoch !== captured.storeEpoch || snapshot.commit_head < captured.commitSeq)
      return { status: "stale_presentation" };
    if (snapshot.value.kind !== "displayed_view_query") return { status: "unavailable" };
    const { status: _status, occurrences: _occurrences, ...display } = captured;
    return {
      status: "ready",
      kind: "database_view",
      readiness: purpose === "display" ? "observed" : "effective_query",
      observedAt: new Date().toISOString(),
      query: snapshot.value.value,
      display,
      collapseTreatment: purpose === "display" ? "captured_selection" : "ignored",
    };
  });
});
