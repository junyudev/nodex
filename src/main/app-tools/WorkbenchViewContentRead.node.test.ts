import { describe } from "vite-plus/test";
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
import {
  type WorkbenchContentReadInput,
  make as makeWorkbenchContentRead,
} from "./WorkbenchContentRead";
import { make } from "./WorkbenchViewContentRead";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import {
  make as makeWorkbenchContentRouting,
  type WorkbenchContentSurface,
  WorkbenchContentRouting,
} from "./WorkbenchContentRouting";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { make as makeWorkbenchOpenTarget } from "./WorkbenchOpenTarget";
import type {
  WorkbenchPrepareContentResult,
  WorkbenchPreparedPageContent,
  WorkbenchValidateContentResult,
} from "../../shared/nodex-app-tools/workbench-content";
import { FetchV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { BlockIdSchema } from "../../shared/nodex-agent-tools/base-schemas";
import type {
  NativeNodexAgentFetchObservation,
  NativeNodexAgentFetchRequest,
} from "../core-client/native-nodex-agent-fetch";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";

describe("WorkbenchViewContentRead", () => {
  const input: WorkbenchContentReadInput = {
    authority: {
      threadId: "thread:actor",
      turnId: "turn:actor",
      rootThreadId: "thread:actor",
      actorProjectId: "project:actor",
      libraryId: "library:current",
      storeEpoch: "epoch:current",
      admittedAtMs: 1,
    },
    callId: "call:exact",

    description: {
      status: "available",
      kind: "database_view",
      title: "Authorized View",
      libraryId: "library:current",
      displayedRoutingContext: { kind: "library" },
      databaseId: "database:target",
      dataSourceId: "source:target",
      viewId: "view:target",
      layout: "list",
    },
    live: {
      reference: {
        windowSessionId: "window:exact",
        rendererGeneration: "renderer:exact",
        sceneOwner: { kind: "library" },
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
    routingContext: { kind: "library" },
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
        Effect.provideService(CoreAuthority, {
          identity: { profileId: "profile:current" },
        } as never),
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
      assert.deepEqual(result.query.result.columns, ["page_id", "title", "url"]);
      assert.deepEqual(result.query.result.rows, [
        ["page:target", "Core title", "nodex://pages/page%3Atarget"],
      ]);
      assert.deepEqual(requests[0], {
        kind: "capture_view",
        sceneOwner: { kind: "library" },
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
        { ...capture, routingContext: { kind: "project" as const, projectId: "project:actor" } },
        { ...capture, search: { ...capture.search, current: "new search" } },
        ...Object.keys(capture.pending).map((key) => ({
          ...capture,
          pending: { ...capture.pending, [key]: true },
        })),
      ]) {
        const { read, reads } = yield* setup({ capture: changed });
        const result = yield* read(input, "effective_query");
        assert.ok(
          result.status === "stale_presentation" || result.status === "pending_presentation",
        );
        assert.equal(reads.length, 0);
      }
    }),
  );

  it.effect(
    "preserves Core conflicts, authority rejection and complete-result budget failures",
    () =>
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
});

describe("WorkbenchContentRouting", () => {
  const make = makeWorkbenchContentRouting;
  describe("WorkbenchContentRouting", () => {
    const authority: NodexAgentTurnContext = {
      threadId: "thread",
      turnId: "turn",
      rootThreadId: "thread",
      actorProjectId: "project:caller",
      libraryId: "library",
      storeEpoch: "epoch",
      admittedAtMs: 1,
    };
    const page: WorkbenchContentSurface = {
      id: "surface",
      kind: "page_stage",
      titleSnapshot: "Stale",
      config: {
        pageId: "page:target",
      },
    };
    const setup = (read: CoreModules["Service"]["library"]["read"]) =>
      make.pipe(
        Effect.provideService(CoreModules, { library: { read } } as never),
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      );
    it.effect(
      "reads a cross-Project surface using exact Profile execution and canonical metadata",
      () =>
        Effect.gen(function* () {
          const requests: unknown[] = [];
          const owner = yield* setup((read, _options, projectId) => {
            requests.push({ read, projectId });
            return Effect.succeed({
              value: {
                kind: "agent_surface_description",
                value: {
                  status: "available",
                  kind: "page",
                  page_id: "page:target",
                  title: "Current",
                  library_id: "library",
                  displayed_routing_context: { kind: "library" },
                },
              },
            } as never);
          });
          assert.deepEqual(yield* owner.describe({ authority, callId: "call", surface: page }), {
            status: "available",
            kind: "page",
            pageId: "page:target",
            title: "Current",
            libraryId: "library",
            displayedRoutingContext: { kind: "library" },
          });
          assert.deepEqual(requests, [
            {
              projectId: "project:caller",
              read: {
                kind: "agent_surface_description",
                target: { kind: "page", page_id: "page:target" },
                displayed_routing_context: { kind: "library" },
                authorization: {
                  call_id: "call",
                  provenance: {
                    profile_id: "profile",
                    authority: {
                      thread_id: "thread",
                      turn_id: "turn",
                      root_thread_id: "thread",
                      actor_project_id: "project:caller",
                      library_id: "library",
                      store_epoch: "epoch",
                    },
                  },
                },
              },
            },
          ]);
        }),
    );
    it.effect("missing surfaces and disconnected Core return structural unavailability", () =>
      Effect.gen(function* () {
        for (const read of [
          () =>
            Effect.succeed({
              value: { kind: "agent_surface_description", value: { status: "unavailable" } },
            } as never),
          () => Effect.fail(new Error("Core disconnected")),
        ] as unknown as CoreModules["Service"]["library"]["read"][]) {
          const owner = yield* setup(read);
          assert.deepEqual(yield* owner.describe({ authority, callId: "call", surface: page }), {
            status: "unavailable",
          });
        }
      }),
    );

    it.effect("validates a Page File through its Page and the canonical Core relation", () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const owner = yield* setup((read) => {
          requests.push(read.kind);
          return Effect.succeed({
            value:
              read.kind === "agent_surface_description"
                ? {
                    kind: "agent_surface_description",
                    value: {
                      status: "available",
                      kind: "page",
                      page_id: "page",
                      title: "Current Page",
                      library_id: "library",
                      displayed_routing_context: { kind: "library" },
                    },
                  }
                : {
                    kind: "resolved_page_file",
                    value: {
                      logical_path: "output/current.html",
                      file: {
                        file_id: "file",
                        library_id: "library",
                        default_name: "old.html",
                        lifecycle: "live",
                      },
                    },
                  },
          } as never);
        });
        assert.deepEqual(
          yield* owner.describePageFile({
            authority,
            callId: "call",
            surface: {
              id: "surface",
              kind: "page_file",
              titleSnapshot: "Stale",
              config: {
                pageId: "page",
                fileId: "file",
                logicalPath: "old.html",
              },
            },
          }),
          {
            status: "available",
            kind: "page_file",
            pageId: "page",
            pageTitle: "Current Page",
            fileId: "file",
            libraryId: "library",
            title: "current.html",
            logicalPath: "output/current.html",
            displayedRoutingContext: { kind: "library" },
          },
        );
        assert.deepEqual(requests, ["agent_surface_description", "resolve_page_file"]);
      }),
    );

    it.effect("does not describe an unrelated or trashed File or a missing Page", () =>
      Effect.gen(function* () {
        const surface = {
          id: "surface",
          kind: "page_file" as const,
          titleSnapshot: "private",
          config: {
            pageId: "page",
            fileId: "file",
            logicalPath: null,
          },
        };
        for (const failure of ["page", "relation", "trashed"] as const) {
          const owner = yield* setup((read) => {
            if (read.kind === "agent_surface_description")
              return Effect.succeed({
                value: {
                  kind: "agent_surface_description",
                  value:
                    failure === "page"
                      ? { status: "unavailable" }
                      : {
                          status: "available",
                          kind: "page",
                          page_id: "page",
                          title: "Page",
                          library_id: "library",
                          displayed_routing_context: { kind: "library" },
                        },
                },
              } as never);
            if (failure === "relation")
              return Effect.fail(
                coreRuntimeError({
                  operation: "resolve_page_file",
                  reason: "request",
                  retryable: false,
                  message: "File is not used by the Page",
                }),
              );
            return Effect.succeed({
              value: { kind: "resolved_page_file", value: { file: { lifecycle: "trashed" } } },
            } as never);
          });
          assert.deepEqual(yield* owner.describePageFile({ authority, callId: "call", surface }), {
            status: "unavailable",
          });
        }
      }),
    );
  });

  describe("WorkbenchOpenTarget", () => {
    const make = makeWorkbenchOpenTarget;
    it.effect("resolves a Page File open target through canonical Page/File validation", () =>
      Effect.gen(function* () {
        const target = workbenchControlSchemas.open_tab.shape.target.parse({
          kind: "page_file",
          pageId: "page",
          fileId: "file",
        });
        for (const available of [true, false]) {
          const resolve = yield* make.pipe(
            Effect.provideService(ProjectWorkspace, {} as never),
            Effect.provideService(WorkbenchContentRouting, {
              describe: () => Effect.succeed({ status: "unavailable" }),
              describePageFile: ({ surface }) => {
                assert.equal(surface.config.pageId, "page");
                assert.equal(surface.config.fileId, "file");
                return Effect.succeed(
                  available
                    ? {
                        status: "available",
                        kind: "page_file",
                        title: "report.html",
                        pageId: "page",
                        pageTitle: "Report",
                        fileId: "file",
                        logicalPath: "output/report.html",
                        libraryId: "library",
                        displayedRoutingContext: { kind: "library" },
                      }
                    : { status: "unavailable" },
                );
              },
            }),
          );
          const surface = yield* resolve({
            target,
            sceneOwner: { kind: "library" },
            operationId: "open",
            authority: {} as NodexAgentTurnContext,
            callId: "call",
          });
          assert.deepEqual(
            surface,
            available
              ? {
                  kind: "page_file",
                  titleSnapshot: "report.html",
                  config: {
                    pageId: "page",
                    fileId: "file",
                    logicalPath: "output/report.html",
                    titleSnapshot: "report.html",
                  },
                }
              : null,
          );
        }
      }),
    );
  });
});

describe("WorkbenchContentRead", () => {
  const make = makeWorkbenchContentRead;
  const authority: NodexAgentTurnContext = {
    threadId: "thread:actor",
    turnId: "turn:actor",
    rootThreadId: "thread:actor",
    actorProjectId: "project:actor",
    libraryId: "library:current",
    storeEpoch: "epoch:current",
    admittedAtMs: 1,
  };
  const input: WorkbenchContentReadInput = {
    authority,
    callId: "call:exact",

    description: {
      status: "available",
      kind: "page",
      pageId: "page:target",
      title: "Described title",
      libraryId: authority.libraryId,
      displayedRoutingContext: { kind: "library" },
    },
    live: {
      reference: {
        windowSessionId: "window:exact",
        rendererGeneration: "generation:exact",
        sceneOwner: { kind: "project", projectId: "project:displayed" },
      },
      tabId: "tab:exact",
      expectedPresentationRevision: 4,
    },
    isCurrent: Effect.succeed(true),
  };
  const prepared: WorkbenchPreparedPageContent = {
    status: "ready",
    token: "01980000-0000-7000-8000-000000000001",
    editorSurfaceId: "editor:exact",
    pageId: "page:target",
    documentId: "document:target",
    libraryId: authority.libraryId,
    routingContext: { kind: "library" },
    storeEpoch: authority.storeEpoch,
    generation: 2,
    expectedHeadSeq: 10,
    localEditRevision: 3,
    preparedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-08T00:01:00.000Z",
  };
  const validation: WorkbenchValidateContentResult = {
    status: "synchronized",
    token: prepared.token,
    headSeq: 11,
    localEditRevision: 3,
    checkedAt: "2026-09-08T00:00:01.000Z",
  };
  const observation = (
    markdown = "- Canonical paragraph\n",
  ): Extract<NativeNodexAgentFetchObservation, { ok: true }> => ({
    ok: true,
    tool: "fetch",
    document: {
      documentId: prepared.documentId,
      ownerPageId: prepared.pageId,
      targetBlockId: prepared.pageId,
      storeEpoch: authority.storeEpoch,
      generation: 2,
      headSeq: 11,
      commitHead: 20,
    },
    validators: { title: `nxe2.${"a".repeat(43)}`, body: `nxe2.${"b".repeat(43)}` },
    output: FetchV6OutputSchema.parse({
      data: {
        resource: {
          id: prepared.pageId,
          type: "page",
          pageKey: null,
          title: { markdown: "Canonical title", etag: `nxe2.${"a".repeat(43)}` },
          lifecycle: "active",
          location: { kind: "library", libraryId: authority.libraryId },
        },
        content: {
          format: "markdown",
          markdown,
          contentHash: "a".repeat(64),
          etag: `nxe2.${"b".repeat(43)}`,
        },
      },
    }),
  });

  const setup = (
    options: {
      preparation?: WorkbenchPrepareContentResult;
      validation?: WorkbenchValidateContentResult;
      observation?: NativeNodexAgentFetchObservation;
      onRead?: () => void;
    } = {},
  ) =>
    Effect.gen(function* () {
      const reads: NativeNodexAgentFetchRequest[] = [];
      const requests: WorkbenchAgentRequestBody[] = [];
      const service = yield* make.pipe(
        Effect.provideService(CoreAuthority, {
          identity: { profileId: "profile:current" },
        } as never),
        Effect.provideService(CoreModules, {
          query: { read: () => Effect.die("Unexpected View read") },
        } as never),
        Effect.provideService(NodexAgentApplication, {
          readPageObservation: (request: NativeNodexAgentFetchRequest) =>
            Effect.sync(() => {
              reads.push(request);
              options.onRead?.();
              return options.observation ?? observation();
            }),
        } as unknown as NodexAgentApplication["Service"]),
        Effect.provideService(WorkbenchAgentBridge, {
          request: (_reference: WorkbenchWindowReference, body: WorkbenchAgentRequestBody) =>
            Effect.sync(() => {
              requests.push(body);
              if (body.kind === "prepare_content")
                return { kind: body.kind, preparation: options.preparation ?? prepared };
              if (body.kind === "validate_content")
                return { kind: body.kind, validation: options.validation ?? validation };
              throw new Error("Unexpected renderer request");
            }),
        } as unknown as WorkbenchAgentBridge["Service"]),
      );
      return { service, reads, requests };
    });

  it.effect(
    "reads the exact authorized Page and returns one synchronized snapshot with its validators",
    () =>
      Effect.gen(function* () {
        const { service, reads, requests } = yield* setup();
        const result = yield* service.read(input);
        assert.equal(result.status, "ready");
        if (result.status !== "ready" || result.kind !== "page") return;
        assert.equal(result.readiness, "synchronized");
        assert.deepEqual(result.output, observation().output);
        assert.deepEqual(result.validators, observation().validators);
        assert.deepEqual(result.document, observation().document);
        assert.equal(result.synchronization?.editorSurfaceId, prepared.editorSurfaceId);
        assert.deepEqual(reads[0], {
          tool: "fetch",
          projectId: authority.actorProjectId,
          authority,
          callId: input.callId,

          input: {
            id: BlockIdSchema.parse(prepared.pageId),
            format: "markdown",
            includeDataSource: false,
          },
        });
        assert.deepEqual(requests, [
          {
            kind: "prepare_content",
            sceneOwner: input.live!.reference.sceneOwner,
            tabId: input.live!.tabId,
            expectedPresentationRevision: 4,
          },
          { kind: "validate_content", token: prepared.token },
        ]);
      }),
  );

  it.effect(
    "keeps stable target reads canonical and rejects restricted descriptions before a body read",
    () =>
      Effect.gen(function* () {
        const { service, reads, requests } = yield* setup();
        const result = yield* service.read({ ...input, live: undefined });
        assert.equal(result.status === "ready" && result.readiness, "canonical");
        assert.equal(requests.length, 0);
        assert.deepEqual(
          yield* service.read({
            ...input,
            description: { status: "unavailable" },
          }),
          { status: "unavailable" },
        );
        assert.equal(reads.length, 1);
      }),
  );

  it.effect(
    "does not fall back to Core content when the live editor is pending or targets another surface",
    () =>
      Effect.gen(function* () {
        for (const preparation of [
          { status: "pending_local_edits" as const },
          { ...prepared, pageId: "page:other" },
          {
            ...prepared,
            routingContext: { kind: "project" as const, projectId: "project:actor" },
          },
          { ...prepared, storeEpoch: "epoch:old" },
        ]) {
          const { service, reads } = yield* setup({ preparation });
          const result = yield* service.read(input);
          assert.equal(
            result.status,
            preparation.status === "ready" ? "stale_presentation" : "pending_local_edits",
          );
          assert.equal(reads.length, 0);
        }
      }),
  );

  it.effect(
    "rejects generation changes, advanced remote heads, new local edits and expired editor tokens",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            observation: {
              ...observation(),
              document: { ...observation().document, generation: 3 },
            },
          },
          {
            observation: { ...observation(), document: { ...observation().document, headSeq: 9 } },
          },
          { validation: { ...validation, headSeq: 12 } },
          { validation: { ...validation, localEditRevision: 4 } },
          { validation: { ...validation, token: "01980000-0000-7000-8000-000000000002" } },
          { validation: { status: "expired" as const } },
        ];
        for (const item of cases) {
          const { service } = yield* setup(item);
          assert.deepEqual(yield* service.read(input), { status: "stale_presentation" });
        }
      }),
  );

  it.effect(
    "discards withdrawn calls and rejects an oversized Markdown result without partial output",
    () =>
      Effect.gen(function* () {
        let current = true;
        const cancelled = yield* setup({
          onRead: () => {
            current = false;
          },
        });
        assert.deepEqual(
          yield* cancelled.service.read({ ...input, isCurrent: Effect.sync(() => current) }),
          { status: "cancelled" },
        );
        assert.equal(cancelled.requests.length, 1);
        const oversized = yield* setup({ observation: observation("字".repeat(22_000)) });
        assert.deepEqual(yield* oversized.service.read(input), { status: "result_too_large" });
        assert.equal(oversized.requests.length, 1);
      }),
  );
});
