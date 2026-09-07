import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type {
  WorkbenchAgentRequestBody,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import type { WorkbenchViewSnapshot } from "../../shared/nodex-app-tools/workbench-view-content";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError, type CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import type { WorkbenchContentReadInput } from "./WorkbenchContentRead";
import { make } from "./WorkbenchViewContentRead";

const input: WorkbenchContentReadInput = {
  authority: {
    threadId: "thread:actor",
    turnId: "turn:actor",
    rootThreadId: "thread:actor",
    actorProjectId: "project:actor",
    libraryId: "library:current",
    storeEpoch: "epoch:current",
    scope: "project",
    source: "project_turn",
    frozenAtMs: 1,
    readOnly: true,
  },
  callId: "call:exact",
  taskAccess: {
    kind: "consent",
    scope: "task",
    rootThreadId: "thread:actor",
    actorProjectId: "project:actor",
    libraryId: "library:current",
    storeEpoch: "epoch:current",
    grants: [{ root: { kind: "database", databaseId: "database:target" }, access: "read" }],
  },
  description: {
    status: "authorized",
    kind: "database_view",
    title: "Authorized View",
    libraryId: "library:current",
    displayedAccessContext: { kind: "library" },
    databaseId: "database:target",
    dataSourceId: "source:target",
    viewId: "view:target",
    layout: "list",
  },
  live: {
    reference: {
      windowSessionId: "window:exact",
      rendererGeneration: "renderer:exact",
      sceneOwner: { kind: "pages" },
    },
    tabId: "tab:exact",
    expectedPresentationRevision: 4,
  },
  isCurrent: Effect.succeed(true),
};
const capture: WorkbenchViewSnapshot = {
  status: "ready",
  capturedAt: "2026-09-08T00:00:00.000Z",
  layout: "list",
  libraryId: "library:current",
  accessContext: { kind: "library" },
  databaseId: "database:target",
  dataSourceId: "source:target",
  databaseViewId: "view:target",
  storeEpoch: "epoch:current",
  commitSeq: 10,
  viewRevision: 3,
  schemaRevision: 4,
  preferencesRevision: null,
  preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
  search: { current: "alpha", deferred: "alpha", pending: false },
  pending: { preferences: false, optimistic: false, loading: false, options: false },
  selection: {
    allMatching: false,
    selectedOccurrenceKeys: ["occurrence:target"],
    excludedOccurrenceKeys: [],
    anchorOccurrenceKey: "occurrence:target",
    activeOccurrenceKey: "occurrence:target",
  },
  collapsedOccurrenceKeys: ["group:collapsed"],
  coverage: {
    range: "viewport",
    offset: 0,
    returnedCount: 1,
    rangeCount: 1,
    loadedOccurrenceCount: 100,
    mountedOccurrenceCount: 10,
    viewportOccurrenceCount: 1,
    totalOccurrenceCount: null,
    allRowsLoaded: false,
    viewportKnown: true,
    hasMoreInRange: false,
  },
  occurrences: [
    {
      displayKey: "display:target",
      occurrenceKey: "occurrence:target",
      pageId: "page:target",
      groupPath: [],
      ancestorPageIds: [],
      mounted: true,
      inViewport: true,
      selected: true,
      condition: {
        metadataRevision: 1,
        parentRevision: 2,
        documentId: "document:target",
        documentGeneration: 3,
        documentHeadSeq: 4,
        membershipId: "membership:target",
        membershipRevision: 5,
        databaseValueRevisions: { status: 6 },
        positionRevision: 7,
        rankKey: "a0",
      },
    },
  ],
};

const setup = (
  options: {
    capture?: WorkbenchViewSnapshot;
    error?: CoreRuntimeError;
    commitHead?: number;
    onRead?: () => void;
  } = {},
) =>
  Effect.gen(function* () {
    const requests: WorkbenchAgentRequestBody[] = [];
    const reads: Parameters<CoreModules["Service"]["query"]["read"]>[] = [];
    const read = yield* make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile:current" } } as never),
      Effect.provideService(WorkbenchAgentBridge, {
        request: (_reference: WorkbenchWindowReference, body: WorkbenchAgentRequestBody) =>
          Effect.sync(() => {
            requests.push(body);
            return { kind: "capture_view", capture: options.capture ?? capture };
          }),
      } as unknown as WorkbenchAgentBridge["Service"]),
      Effect.provideService(CoreModules, {
        query: {
          read: (...args: Parameters<CoreModules["Service"]["query"]["read"]>) => {
            reads.push(args);
            options.onRead?.();
            if (options.error) return Effect.fail(options.error);
            return Effect.succeed({
              store_epoch: "epoch:current",
              commit_head: options.commitHead ?? 12,
              contract_version: 3,
              authorization: null,
              value: {
                kind: "displayed_view_query",
                value: {
                  result: {
                    columns: ["page_id", "title"],
                    rows: [["page:target", "Core title"]],
                    returned_count: 1,
                    snapshot: "query:current",
                  },
                  rules_fingerprint: "rules:current",
                  view_revision: 3,
                  schema_revision: 4,
                  preferences_revision: null,
                  coverage: { kind: "effective_complete" },
                  total_effective_occurrences: 205,
                },
              },
            });
          },
        },
      } as unknown as CoreModules["Service"]),
    );
    return { read, requests, reads };
  });

it.effect("reprojects displayed occurrence conditions through exact Agent authority", () =>
  Effect.gen(function* () {
    const { read, reads, requests } = yield* setup();
    const result = yield* read({ ...input, propertyIds: ["status"] }, "display");
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.readiness, "observed");
    assert.equal(result.collapseTreatment, "captured_selection");
    assert.equal(result.display.coverage.totalOccurrenceCount, null);
    assert.deepEqual(result.query.result.rows, [["page:target", "Core title"]]);
    assert.deepEqual(requests[0], {
      kind: "capture_view",
      sceneOwner: { kind: "pages" },
      tabId: "tab:exact",
      expectedPresentationRevision: 4,
      purpose: "display",
      range: "viewport",
      offset: 0,
      limit: 50,
    });
    const [request, projectId] = reads[0]!;
    assert.equal(projectId, "project:actor");
    assert.equal(request.kind, "agent_displayed_view_query");
    if (request.kind !== "agent_displayed_view_query") return;
    assert.equal(request.authorization.call_id, "call:exact");
    assert.equal(request.authorization.provenance.authority.actor_project_id, "project:actor");
    assert.equal(request.authorization.resource_access?.scope, "task");
    assert.deepEqual(request.coordinate, {
      database_id: "database:target",
      data_source_id: "source:target",
      view_id: "view:target",
      expected_view_revision: 3,
      expected_schema_revision: 4,
      expected_preferences_revision: null,
      preferences_override: { rules_override: {}, presentation_override: {} },
      search_query: "alpha",
    });
    assert.deepEqual(request.selection, {
      kind: "observed",
      occurrences: [
        {
          occurrence_key: "occurrence:target",
          page_id: "page:target",
          group_path: [],
          ancestor_page_ids: [],
          condition: {
            metadata_revision: 1,
            parent_revision: 2,
            document_id: "document:target",
            document_generation: 3,
            document_head_seq: 4,
            membership_id: "membership:target",
            membership_revision: 5,
            database_value_revisions: { status: 6 },
            position_revision: 7,
            rank_key: "a0",
          },
        },
      ],
    });
  }),
);

it.effect(
  "queries complete effective rules independently of loaded rows and only limits on explicit input",
  () =>
    Effect.gen(function* () {
      const { read, reads, requests } = yield* setup();
      const result = yield* read(input, "effective_query");
      assert.equal(result.status, "ready");
      if (result.status !== "ready") return;
      assert.equal(result.readiness, "effective_query");
      assert.equal(result.collapseTreatment, "ignored");
      assert.equal(result.query.total_effective_occurrences, 205);
      assert.equal(result.display.coverage.loadedOccurrenceCount, 100);
      const request = reads[0]![0];
      assert.equal(
        request.kind === "agent_displayed_view_query" && request.selection.kind,
        "effective",
      );
      assert.deepEqual(request.kind === "agent_displayed_view_query" && request.selection, {
        kind: "effective",
        limit: null,
      });
      yield* read({ ...input, limit: 20 }, "effective_query");
      assert.deepEqual(
        reads[1]![0].kind === "agent_displayed_view_query" && reads[1]![0].selection,
        { kind: "effective", limit: 20 },
      );
      yield* read({ ...input, limit: 500 }, "effective_query");
      assert.deepEqual(
        reads[2]![0].kind === "agent_displayed_view_query" && reads[2]![0].selection,
        { kind: "effective", limit: 500 },
      );
      assert.equal(requests[2]?.kind === "capture_view" && requests[2].limit, 200);
    }),
);

it.effect("rejects another surface and unsettled presentation without a Core query", () =>
  Effect.gen(function* () {
    for (const changed of [
      { ...capture, databaseViewId: "view:other" },
      { ...capture, accessContext: { kind: "project" as const, projectId: "project:actor" } },
      { ...capture, search: { ...capture.search, current: "new search" } },
      ...Object.keys(capture.pending).map((key) => ({
        ...capture,
        pending: { ...capture.pending, [key]: true },
      })),
    ]) {
      const { read, reads } = yield* setup({ capture: changed });
      const result = yield* read(input, "effective_query");
      assert.ok(result.status === "stale_presentation" || result.status === "pending_presentation");
      assert.equal(reads.length, 0);
    }
  }),
);

it.effect("preserves Core conflicts, authority rejection and complete-result budget failures", () =>
  Effect.gen(function* () {
    for (const [code, status] of [
      ["revision_conflict", "stale_presentation"],
      ["unauthorized", "access_denied"],
      ["resource_exhausted", "result_too_large"],
    ] as const) {
      const error = coreRuntimeError({
        operation: "query.read",
        reason: "operation",
        retryable: false,
        cause: new CoreModuleResponseError({
          code,
          message: "Rejected",
          retryable: false,
          recovery: { kind: "none" },
        }),
      });
      const { read } = yield* setup({ error });
      assert.deepEqual(yield* read(input, "effective_query"), { status });
    }
    const stale = yield* setup({ commitHead: 9 });
    assert.deepEqual(yield* stale.read(input, "display"), { status: "stale_presentation" });
  }),
);

it.effect("discards a query completed after caller withdrawal", () =>
  Effect.gen(function* () {
    let current = true;
    const { read } = yield* setup({
      onRead: () => {
        current = false;
      },
    });
    assert.deepEqual(
      yield* read({ ...input, isCurrent: Effect.sync(() => current) }, "effective_query"),
      { status: "cancelled" },
    );
  }),
);
