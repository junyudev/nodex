import { describe, expect, test } from "vite-plus/test";
import { testPropertyManagement } from "../../shared/testing/database-property-record";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import type {
  DatabaseViewQueryResultV2,
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  DatabasePageProjectionError,
  projectCoreDatabaseRowSummary,
  projectCoreDatabaseViewBoard,
  projectDatabasePage,
  projectDatabaseViewReference,
} from "../../shared/database-page-projection";
import { projectCoreDatabaseQueryRow } from "../../shared/core-database-row-projection";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import { type CoreDatabaseRowSummary, applyResultCursor, type CoreClientPort } from "./types";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { ProjectionCursor, ProjectionStreamMessage } from "../../shared/projection-stream";
import { projectionMessageFromDelivery } from "../../shared/local-commit-delivery";
import { createSessionLinkedPageStore } from "../../renderer/lib/session-linked-page";
import { ProjectionInvalidationRegistry } from "../../renderer/lib/projection-invalidation-registry";
import { projectCoreProjectWorkspaceEvent } from "../core-runtime/CoreApplicationEventProjection";
import { planCoreWorkspaceNotifications } from "./core-project-workspace-invalidation";
import { projectWorkspaceSessionLinkedPageSummaryFromCore } from "./project-workspace-adapter";
import { CoreClient } from "./core-client";
import * as Effect from "effect/Effect";
import { runScenarioProjectWorkspace } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../../scripts/scenarios/scenarios/board-dense";
import { SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/sidebar-linked-page-status";
import { createBoundedOperationId } from "../../shared/operation-identity";
import type { CreatePageForCommand } from "../../shared/workspace-page-create";
import { inboxNewChatAction } from "../../shared/inbox";
import {
  inboxDispatchActionToCore,
  inboxItemFromCore,
  inboxSummaryFromCore,
} from "./inbox-adapter";

describe("database-page-projection", () => {
  const dataSourceId = parseDataSourceId("source:test");
  const databaseId = parseDatabaseId("database:test");
  const viewId = parseDatabaseViewId("view:test");

  const property = (
    propertyId: string,
    valueType: DataSourcePropertyRecordV2["valueType"],
    config: DataSourcePropertyRecordV2["config"] = {},
  ): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId,
    name: propertyId,
    schema: { kind: valueType } as DataSourcePropertyRecordV2["schema"],
    capabilities: {
      filterOperators: [
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "is_empty",
        "is_not_empty",
      ],
      sortable: true,
      groupable: true,
    },
    ...testPropertyManagement(),
    valueType,
    config,
    optionCount: Array.isArray(config.options) ? config.options.length : 0,
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  });

  const properties: readonly DataSourcePropertyRecordV2[] = [
    property("status", "select"),
    property("priority", "select"),
    property("estimate", "select"),
    property("tags", "multi_select"),
    property("due_date", "date"),
    property("scheduled_start", "datetime"),
    property("scheduled_end", "datetime"),
    property("assignee", "assignment"),
  ];

  const databaseValue = (
    propertyId: string,
    valueType: DataSourcePageRowV2["values"][string]["valueType"],
    value: DataSourcePageRowV2["values"][string]["value"],
  ) => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    valueType,
    value,
    revision: 1,
  });

  const makeRow = (pageId: string, status: "triage" | "doing" = "doing"): DataSourcePageRowV2 => ({
    pageKey: null,
    page: {
      pageId,
      libraryId: "library:test",
      parent: { kind: "data_source", dataSourceId },
      lifecycle: "active",
      parentRevision: 2,
      metadataRevision: 7,
      documentId: `document:${pageId}`,
      documentGeneration: 1,
      documentHeadSeq: 4,
      title: `Title ${pageId}`,
      richTitle: plainTextToPortableRichText(`Title ${pageId}`),
      preview: "Projection preview",
      plainText: "Projection plain text",
      createdAt: "2026-07-20T01:00:00.000Z",
      updatedAt: "2026-07-20T02:00:00.000Z",
    },
    membership: {
      membershipId: `membership:${pageId}`,
      dataSourceId,
      revision: 1,
      createdAt: "2026-07-20T00:30:00.000Z",
    },
    values: {
      status: databaseValue("status", "select", status),
      priority: databaseValue("priority", "select", "p1-high"),
      estimate: databaseValue("estimate", "select", "m"),
      tags: databaseValue("tags", "multi_select", ["o_BBBBBBBB", "o_AAAAAAAA"]),
      due_date: databaseValue("due_date", "date", "2026-07-25"),
      scheduled_start: databaseValue("scheduled_start", "datetime", "2026-07-25T08:00:00.000Z"),
      scheduled_end: databaseValue("scheduled_end", "datetime", "2026-07-25T09:00:00.000Z"),
      assignee: databaseValue("assignee", "assignment", { kind: "member", member_id: "Ada" }),
    },
    bodyMarkdown: "# Detail\n\nA body with **structure**.",
    intrinsicProperties: [
      {
        key: "work",
        valueType: "json",
        value: {
          owner: "person",
          assignee: { kind: "member", member_id: "Ada" },
          auto_start: false,
        },
        revision: 1,
      },
      { key: "run.target", valueType: "string", value: "newWorktree", revision: 1 },
      { key: "run.localPath", valueType: "string", value: "/repo/nodex", revision: 1 },
      { key: "run.baseBranch", valueType: "string", value: "main", revision: 1 },
      { key: "run.worktreePath", valueType: "string", value: null, revision: 1 },
      { key: "run.environmentPath", valueType: "string", value: null, revision: 1 },
      { key: "schedule.isAllDay", valueType: "boolean", value: false, revision: 1 },
      { key: "schedule.timezone", valueType: "string", value: "UTC", revision: 1 },
      {
        key: "recurrence.config",
        valueType: "json",
        value: { frequency: "weekly", interval: 1, byWeekdays: [1, 3] },
        revision: 1,
      },
      {
        key: "reminders.config",
        valueType: "json",
        value: [{ offsetMinutes: 30 }],
        revision: 1,
      },
    ],
    work: {
      unsatisfiedCount: 0,
      blockers: [],
      owner: "person",
      assignee: { kind: "member", member_id: "Ada" },
      autoStart: false,
    },
    taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
    position: {
      rankKey: `rank:${pageId}`,
      revision: 1,
    },
    effectiveGroupKey: status,
    effectiveSubgroupKey: null,
  });

  const makeQuery = (rows: readonly DataSourcePageRowV2[]): DatabaseViewQueryResultV2 => ({
    database: {
      databaseId,
      libraryId: "library:test",
      name: "Tasks",
      lifecycle: "active",
      defaultViewId: viewId,
      metadataRevision: 1,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
    dataSource: {
      dataSourceId,
      libraryId: "library:test",
      homeDatabaseId: databaseId,
      name: "Tasks",
      schemaKey: "nodex.database",
      schemaRevision: 1,
      lifecycle: "active",
      rankKey: "rank:source",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
    view: {
      viewId,
      databaseId,
      dataSourceId,
      name: "Board",
      layout: "board",
      config: upgradeDatabaseViewConfigV2({
        schemaKey: "nodex.database-view",
        schemaVersion: 2,
        filter: { kind: "group", operator: "and", children: [] },
        sort: [
          {
            field: { kind: "manual" },
            direction: "asc",
            nulls: "last",
          },
        ],
        group: { propertyId: "status" },
        display: { propertyIds: ["status"], showTitle: true },
      }),
      isDefault: true,
      revision: 1,
      rankKey: "rank:view",
      lifecycle: "active",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
    properties,
    rows,
  });

  describe("native Database Page projections", () => {
    test("keeps canonical option identities in the shared Board projection", () => {
      const row: CoreDatabaseRowSummary = {
        page_id: "page:defaults",
        lifecycle: "active",
        title: "Defaults",
        rich_title: plainTextToPortableRichText("Defaults"),
        description_preview: "",
        description_length: 0,
        has_description: false,
        database_values: { status: "triage", tags: ["o_AAAAAAAA"] },
        work: {
          owner: "person",
          assignee: { kind: "agent", instance_id: "codex", model: "gpt-6-luna", effort: null },
          auto_start: false,
          unsatisfied_count: 1,
          blockers: [
            {
              page_id: "page:prerequisite",
              page_key: "NODEX-12",
              title: "Prerequisite",
              status: "plan",
            },
          ],
        },
        intrinsic_properties: {
          work: {
            owner: "person",
            assignee: { kind: "agent", instance_id: "codex", model: "gpt-6-luna", effort: null },
            auto_start: false,
          },
          "run.target": "localProject",
          "run.localPath": null,
          "run.baseBranch": null,
          "run.worktreePath": null,
          "run.environmentPath": null,
          "schedule.isAllDay": false,
          "schedule.timezone": null,
          "recurrence.config": null,
          "reminders.config": [],
        },
        database_value_revisions: { status: 1, tags: 1 },
        task_parent_page_id: null,
        task_sibling_rank: null,
        task_parent_value_revision: 1,
        metadata_revision: 1,
        parent_revision: 1,
        document_id: "document:defaults",
        document_generation: 1,
        document_head_seq: 1,
        membership_id: "membership:defaults",
        membership_revision: 1,
        membership_created_at: "2026-07-25T00:00:00.000Z",
        created_at: "2026-07-25T00:00:00.000Z",
        updated_at: "2026-07-25T00:00:00.000Z",
      };

      const board = projectCoreDatabaseViewBoard([row], [{ id: "triage", name: "Incoming" }]);
      expect(board.columns[0]).toMatchObject({ id: "triage", name: "Incoming" });
      expect(board.columns[0]?.cards.map((card) => card.id)).toEqual(["page:defaults"]);
      expect(board.columns.find((column) => column.id === "doing")?.name).toBe("In Progress");

      expect(projectCoreDatabaseRowSummary(row)).toMatchObject({
        id: "page:defaults",
        status: "triage",
        pageWork: {
          owner: "person",
          assignee: { kind: "agent", instance_id: "codex", model: "gpt-6-luna", effort: null },
          auto_start: false,
        },
        work: {
          owner: "person",
          assignee: { kind: "agent", instance_id: "codex", model: "gpt-6-luna", effort: null },
          autoStart: false,
          unsatisfiedCount: 1,
          blockers: [
            {
              pageId: "page:prerequisite",
              pageKey: "NODEX-12",
              title: "Prerequisite",
              status: "plan",
            },
          ],
        },
        tags: ["o_AAAAAAAA"],
        priority: undefined,
        estimate: undefined,
        dueDate: undefined,
        scheduledStart: undefined,
        scheduledEnd: undefined,
        assignee: { kind: "agent", instance_id: "codex", model: "gpt-6-luna", effort: null },
      });
      expect(
        projectCoreDatabaseQueryRow(row, {
          libraryId: "library:test",
          dataSourceId,
          properties,
        }).values.tags?.value,
      ).toEqual(["o_AAAAAAAA"]);
    });

    test("builds the complete renderer Page from one native query row", () => {
      const page = projectDatabasePage(makeRow("page:one"), 3);

      expect(page).toMatchObject({
        id: "page:one",
        status: "doing",
        title: "Title page:one",
        description: "# Detail\n\nA body with **structure**.",
        priority: "p1-high",
        estimate: "m",
        tags: ["o_AAAAAAAA", "o_BBBBBBBB"],
        isAllDay: false,
        recurrence: { frequency: "weekly", interval: 1, byWeekdays: [1, 3] },
        reminders: [{ offsetMinutes: 30 }],
        scheduleTimezone: "UTC",
        assignee: { kind: "member", member_id: "Ada" },
        runInTarget: "newWorktree",
        runInLocalPath: "/repo/nodex",
        runInBaseBranch: "main",
        revision: 7,
        order: 3,
      });
      expect(page.dueDate?.toISOString()).toBe("2026-07-25T00:00:00.000Z");
      expect(page.scheduledStart?.toISOString()).toBe("2026-07-25T08:00:00.000Z");
      expect(page.created.toISOString()).toBe("2026-07-20T01:00:00.000Z");
    });

    test("fails closed when native exact-head or intrinsic evidence is absent", () => {
      const row = makeRow("page:missing");
      const withoutBody = { ...row, bodyMarkdown: undefined };
      const withoutIntrinsic = { ...row, intrinsicProperties: undefined };

      expect(() => projectDatabasePage(withoutBody)).toThrowError(DatabasePageProjectionError);
      expect(() => projectDatabasePage(withoutIntrinsic)).toThrow(
        "missing intrinsic Property evidence",
      );
    });

    test("rejects relational metadata that violates Page scheduling contracts", () => {
      const row = makeRow("page:invalid");
      const intrinsicProperties = row.intrinsicProperties?.map((propertyValue) =>
        propertyValue.key === "recurrence.config"
          ? {
              ...propertyValue,
              value: { frequency: "weekly", interval: 1 },
            }
          : propertyValue,
      );

      expect(() => projectDatabasePage({ ...row, intrinsicProperties })).toThrow(
        "invalid relational metadata",
      );
    });

    test("projects View identity and excludes an inline host without another read", () => {
      const model = projectDatabaseViewReference(
        makeQuery([makeRow("page:host"), makeRow("page:visible")]),
        {
          routingContext: {
            kind: "project",
            projectId: "project:reader",
          },
          databaseViewId: viewId,
          hostBlockId: "page:host",
        },
        {
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          commitSeq: 1,
        },
      );

      expect(model.view).toMatchObject({
        id: viewId,
        databaseBlockId: databaseId,
        projectId: "project:reader",
        isPrimary: true,
      });
      expect(model.rows.map((row) => row.page.id)).toEqual(["page:visible"]);
      expect(model.rows[0]?.rankKey).toBe("rank:page:visible");
    });
  });
});

describe("session-linked-page", () => {
  test("Status edits, renamed options and link changes refresh independent Session Linked Page recipients", async () => {
    await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
      const projectId = ctx.manifest.projectId;
      const pageId = ctx.manifest.pageIdsByKey.source!;
      const sessionId = createUuidV7();
      const client = ctx.client.forProject(projectId);
      const view = await client.databaseRead({
        kind: "view",
        view_id: ctx.manifest.databaseViewId!,
      });
      if (view.value.kind !== "view") throw new Error("Missing View");
      const dataSourceId = view.value.value.data_source_id;
      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "create_session",
          session_id: sessionId,
          project_id: projectId,
          title: "Linked Page proof",
          initial_page_ids: [pageId],
        },
      });
      const peer = await CoreClient.connect({
        nodexHome: ctx.profile.nodexHome,
        clientKind: "electron_host",
        buildId: "session-linked-page-recipient",
      });
      const scope = { kind: "library" as const, libraryId: ctx.runtime.identity.libraryId };
      const repairs: unknown[] = [];
      const recipient = async (broker: Pick<CoreClientPort, "openProjectionEventStream">) => {
        const projections = new Set<(message: ProjectionStreamMessage) => void>();
        const sessions = new Set<(event: ProjectSessionsChangeEvent) => void>();
        let latest: ProjectionCursor | null = null;
        let lastReadCommitHead = 0;
        const stream = await broker.openProjectionEventStream(
          [scope],
          (event) => {
            latest = {
              storeEpoch: event.packet.manifest.identity.store_epoch,
              commitSeq: event.packet.manifest.identity.commit_seq,
            };
            for (const effect of event.packet.projection_effects) {
              const message = projectionMessageFromDelivery(event.packet, effect, scope);
              for (const listener of projections) listener(message);
            }
            for (const atom of event.packet.atoms) {
              const workspace = projectCoreProjectWorkspaceEvent(atom);
              if (!workspace) continue;
              const event = planCoreWorkspaceNotifications(workspace).sessions;
              if (!event) continue;
              for (const listener of sessions) listener(event);
            }
          },
          (repair) => repairs.push(repair),
        );
        latest ??= {
          storeEpoch: stream.barrier.store_epoch,
          commitSeq: stream.barrier.commit_head,
        };
        const registry = new ProjectionInvalidationRegistry({
          subscribeProjection: (_scope, listener) => {
            projections.add(listener);
            listener({ version: 2, kind: "checkpoint", scope, stream: latest! });
            return () => projections.delete(listener);
          },
        });
        const store = createSessionLinkedPageStore({
          read: async (input) => {
            const snapshot = await client.workspaceRead({
              kind: "session_linked_page_summaries",
              session_ids: input.sessionIds,
            });
            if (snapshot.value.kind !== "session_linked_page_summaries")
              throw new Error("Missing Session Linked Pages");
            lastReadCommitHead = snapshot.commit_head;
            return {
              summaries: snapshot.value.summaries.map(
                projectWorkspaceSessionLinkedPageSummaryFromCore,
              ),
              libraryId: snapshot.value.library_id,
              storeEpoch: snapshot.store_epoch,
              projectionRevision: snapshot.value.projection_revision,
            };
          },
          subscribeSessions: (listener) => {
            sessions.add(listener);
            return () => sessions.delete(listener);
          },
          registerProjection: (registration) => registry.register(registration),
        });
        const release = store.subscribeSession(sessionId, () => {});
        return {
          store,
          readCommitHead: () => lastReadCommitHead,
          close: () => {
            release();
            registry.dispose();
            stream.close();
          },
        };
      };
      const left = await recipient(ctx.runtime.rootClient);
      let right: Awaited<ReturnType<typeof recipient>> | undefined;
      try {
        right = await recipient(peer);
        const recipients = [left, right];
        const stores = [left.store, right.store];
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)?.status?.optionId))
          .toEqual(["doing", "doing"]);
        const row = await client.databaseRead({ kind: "row_detail", page_id: pageId });
        if (row.value.kind !== "row_detail") throw new Error("Missing row");
        const changed = await client.databaseApply({
          operationId: createUuidV7(),
          intent: [
            {
              kind: "edit_property_values",
              edits: [
                {
                  address: { page_id: pageId, data_source_id: dataSourceId, property_id: "status" },
                  edit: {
                    kind: "replace",
                    expected_value_revision:
                      row.value.value.summary.database_value_revisions.status!,
                    value: { kind: "select", option_id: "review" },
                  },
                },
              ],
            },
          ],
        });
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)?.status?.optionId))
          .toEqual(["review", "review"]);
        const properties = await client.databaseRead({
          kind: "property_window",
          data_source_id: dataSourceId,
          window: { after: null, first: 50 },
        });
        if (properties.value.kind !== "property_window") throw new Error("Missing Properties");
        const status = properties.value.properties.items.find(
          (property) => property.property_id === "status",
        );
        if (!status) throw new Error("Missing Status Property");
        await client.databaseApply({
          operationId: createUuidV7(),
          intent: [
            {
              kind: "put_option",
              data_source_id: dataSourceId,
              property_id: "status",
              option_id: "review",
              name: "Ready for review",
              color: null,
              expected_property_revision: status.revision,
            },
          ],
        });
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)?.status?.label))
          .toEqual(["Ready for review", "Ready for review"]);
        const notesPageId = createUuidV7();
        await ctx.seed.createStandalonePage({
          pageId: notesPageId,
          documentId: createUuidV7(),
          operationId: createUuidV7(),
          projectId,
          title: "Research notes",
        });
        const linkedNotes = await client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "link_page", page_id: notesPageId },
          },
        });
        await expect
          .poll(() =>
            recipients.every(
              (recipient) => recipient.readCommitHead() >= applyResultCursor(linkedNotes),
            ),
          )
          .toBe(true);
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)?.status?.label))
          .toEqual(["Ready for review", "Ready for review"]);
        await client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "unlink_page", page_id: pageId },
          },
        });
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)))
          .toEqual(
            stores.map(() => ({
              pageId: notesPageId,
              pageKey: null,
              title: "Research notes",
              status: null,
            })),
          );
        const relinkedWork = await client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "link_page", page_id: pageId },
          },
        });
        await expect
          .poll(() =>
            recipients.every(
              (recipient) => recipient.readCommitHead() >= applyResultCursor(relinkedWork),
            ),
          )
          .toBe(true);
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)?.pageId))
          .toEqual([notesPageId, notesPageId]);
        expect(stores.map((store) => store.read(sessionId)?.status)).toEqual([null, null]);
        await client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "unlink_page", page_id: notesPageId },
          },
        });
        await expect
          .poll(() => stores.map((store) => store.read(sessionId)?.pageId))
          .toEqual([pageId, pageId]);
        expect(applyResultCursor(changed)).toBeGreaterThan(row.commit_head);
        expect(repairs).toEqual([]);
      } finally {
        left.close();
        right?.close();
      }
    });
  });
});

describe("Page related Chats over the real Core transport", () => {
  test("reads Library Page chats without a Project and removes only the selected relation", async () => {
    await withCoreScenario({ scenarioId: BOARD_DENSE_SCENARIO_ID }, async (context) => {
      const page = await context.seed.sendInboxMessage("Library message with linked chats");
      const otherPage = await context.seed.sendInboxMessage("Another Library message");
      const sessionId = createUuidV7();
      const otherSessionId = createUuidV7();

      await runScenarioProjectWorkspace(context.runtime, (workspace) =>
        Effect.gen(function* () {
          for (const [id, title, pageIds] of [
            [sessionId, "Shared Library chat", [page.pageId, otherPage.pageId]],
            [otherSessionId, "Second Library chat", [page.pageId]],
          ] as const) {
            yield* workspace.createProjectSession({
              operationId: createUuidV7(),
              payload: {
                sessionId: id,
                input: {
                  projectId: context.manifest.projectId,
                  noThreadFallbackTitle: title,
                  initialPageIds: [...pageIds],
                },
              },
            });
          }

          const summaries = yield* workspace.readPageChatActivitySummaries({
            pageIds: [page.pageId, otherPage.pageId],
          });
          expect(summaries.summaries).toMatchObject([
            { pageId: page.pageId, relatedCount: 2, soleSessionId: null },
            { pageId: otherPage.pageId, relatedCount: 1, soleSessionId: sessionId },
          ]);

          const chats = yield* workspace.listPageChatWindow({ pageId: page.pageId });
          expect(chats.items.map((chat) => chat.sessionId).sort()).toEqual(
            [sessionId, otherSessionId].sort(),
          );
          expect(chats.hasMore).toBe(false);
          expect(chats.projectionRevision).toBeGreaterThanOrEqual(summaries.projectionRevision);

          yield* workspace.unlinkPageFromProjectSession(sessionId, { pageId: page.pageId });
          const remaining = yield* workspace.readPageChatActivitySummaries({
            pageIds: [page.pageId, otherPage.pageId],
          });
          expect(remaining.summaries).toMatchObject([
            { pageId: page.pageId, relatedCount: 1, soleSessionId: otherSessionId },
            { pageId: otherPage.pageId, relatedCount: 1, soleSessionId: sessionId },
          ]);
          const remainingChats = yield* workspace.listPageChatWindow({ pageId: page.pageId });
          expect(remainingChats.items.map((chat) => chat.sessionId)).toEqual([otherSessionId]);
        }),
      );
    });
  });

  test("creates, reads, unlinks, and relinks a threadless Chat", async () => {
    await withCoreScenario({ scenarioId: BOARD_DENSE_SCENARIO_ID }, async (context) => {
      const projectId = context.manifest.projectId;
      const pageId = context.manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
      if (!pageId) throw new Error("Scenario manifest has no primary Page");
      const client = context.client.forProject(projectId);
      const sessionId = createUuidV7();

      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "create_session",
          session_id: sessionId,
          project_id: projectId,
          title: "Related Chat transport proof",
          initial_page_ids: [pageId],
        },
      });

      const activity = await client.workspaceRead({
        kind: "page_chat_activity_summaries",
        page_ids: [pageId],
      });
      expect(activity.value).toMatchObject({
        kind: "page_chat_activity_summaries",
        summaries: [
          {
            page_id: pageId,
            related_count: 1,
            working_count: 0,
            unread_count: 0,
            sole_session_id: sessionId,
          },
        ],
      });
      if (activity.value.kind !== "page_chat_activity_summaries") {
        throw new Error("Core returned the wrong Page Chat activity variant");
      }

      const detail = await client.workspaceRead({
        kind: "page_chat_window",
        page_id: pageId,
        include_archived: false,
        window: { after: null, first: 50 },
      });
      expect(detail.value).toMatchObject({
        kind: "page_chat_window",
        chats: {
          items: [
            {
              session_id: sessionId,
              thread_id: null,
              display_title: "Related Chat transport proof",
            },
          ],
          next_cursor: null,
        },
      });
      if (detail.value.kind !== "page_chat_window") {
        throw new Error("Core returned the wrong Page Chat window variant");
      }
      expect(detail.value.chats.authority.projection_revision).toBeGreaterThanOrEqual(
        activity.value.projection_revision,
      );

      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: {
            kind: "unlink_page",
            page_id: pageId,
          },
        },
      });
      const unlinked = await client.workspaceRead({
        kind: "page_chat_activity_summaries",
        page_ids: [pageId],
      });
      expect(unlinked.value).toMatchObject({
        kind: "page_chat_activity_summaries",
        summaries: [{ page_id: pageId, related_count: 0, sole_session_id: null }],
      });
      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: {
            kind: "link_page",
            page_id: pageId,
          },
        },
      });

      const relinked = await client.workspaceRead({
        kind: "page_chat_activity_summaries",
        page_ids: [pageId],
      });
      expect(relinked.value).toMatchObject({
        kind: "page_chat_activity_summaries",
        summaries: [{ page_id: pageId, related_count: 1, sole_session_id: sessionId }],
      });
    });
  });
});

describe("workspace-page-create-scenario", () => {
  const command = (target: CreatePageForCommand["for"]): CreatePageForCommand => ({
    for: target,
    operationId: createBoundedOperationId("workspace.page.create-for"),
    pageId: createUuidV7(),
    documentId: createUuidV7(),
    title: "A **literal** title",
  });

  describe("Workspace Page creation through the public Core transport", () => {
    test("resolves the content home and returns an immediately readable linked Page on exact retry", async () => {
      await withCoreScenario(
        { scenarioId: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID },
        async (ctx) => {
          const projectId = ctx.manifest.projectId;
          const sessionId = createUuidV7();
          await ctx.client.workspaceApply({
            operationId: createBoundedOperationId("session.create"),
            intent: {
              kind: "create_session",
              session_id: sessionId,
              project_id: projectId,
              title: "New chat",
              initial_page_ids: [],
            },
          });
          const input = command({ kind: "session", sessionId });
          const result = await runScenarioProjectWorkspace(ctx.runtime, (workspace) =>
            workspace.createPageFor(input),
          );
          expect(result).toEqual({
            pageId: input.pageId,
            projectId,
            pageKey: expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/u),
            placement: {
              kind: "data_source",
              databaseId: expect.any(String),
              dataSourceId: expect.any(String),
              viewId: expect.any(String),
            },
          });
          const row = await ctx.client.databaseRead({ kind: "row_detail", page_id: result.pageId });
          expect(row.value).toMatchObject({
            kind: "row_detail",
            value: {
              summary: {
                page_id: result.pageId,
                title: input.title,
                page_key: result.pageKey,
                database_values: { status: "triage" },
              },
            },
          });
          const links = await ctx.client.workspaceRead({
            kind: "session_linked_page_summaries",
            session_ids: [sessionId],
          });
          expect(links.value).toMatchObject({
            kind: "session_linked_page_summaries",
            summaries: [
              { session_id: sessionId, page: { page_id: result.pageId, page_key: result.pageKey } },
            ],
          });
          const replay = await runScenarioProjectWorkspace(ctx.runtime, (workspace) =>
            workspace.createPageFor(input),
          );
          expect(replay).toEqual(result);
          const rawReplay = await ctx.client.workspaceApply({
            operationId: input.operationId,
            intent: {
              kind: "create_page_for",
              for: { kind: "session", session_id: sessionId },
              page_id: input.pageId,
              document_id: input.documentId,
              title: input.title!,
            },
          });
          expect(rawReplay.receipt.duplicate).toBe(true);
          if (rawReplay.status !== "committed") throw new Error("Page creation must commit");
          expect(rawReplay.delivery?.atoms).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                descriptor: expect.objectContaining({ kind: "library_navigation_changed" }),
              }),
              expect.objectContaining({
                descriptor: expect.objectContaining({ kind: "project_workspace_changed" }),
              }),
            ]),
          );

          const projectlessSessionId = createUuidV7();
          await ctx.client.workspaceApply({
            operationId: createBoundedOperationId("session.create"),
            intent: {
              kind: "create_session",
              session_id: projectlessSessionId,
              project_id: null,
              title: "New chat",
              initial_page_ids: [],
            },
          });
          const rootInput = {
            ...command({ kind: "session", sessionId: projectlessSessionId }),
            title: undefined,
          };
          const root = await runScenarioProjectWorkspace(ctx.runtime, (workspace) =>
            workspace.createPageFor(rootInput),
          );
          expect(root.placement).toEqual({
            kind: "library",
            libraryId: ctx.runtime.identity.libraryId,
          });
          expect(root.pageKey).toBeNull();
          expect(root.projectId).toBeNull();
          const detail = await ctx.client.libraryRead({
            kind: "page_detail",
            page_id: root.pageId,
          });
          expect(detail.value).toMatchObject({
            kind: "page_detail",
            value: { page: { parent: { kind: "library" }, title: "Untitled" } },
          });
          const roots = await ctx.client.libraryRead({
            kind: "children",
            parent: { kind: "library" },
            limit: 1,
            cursor: null,
            force_include_target: null,
          });
          expect(roots.value).toMatchObject({
            kind: "children",
            items: [{ kind: "page", page_id: root.pageId }],
          });
          await runScenarioProjectWorkspace(ctx.runtime, (workspace) =>
            Effect.gen(function* () {
              const summaries = yield* workspace.readSessionLinkedPageSummaries({
                sessionIds: [projectlessSessionId],
              });
              expect(summaries.summaries).toMatchObject([
                { sessionId: projectlessSessionId, page: { pageId: root.pageId } },
              ]);
            }),
          );
        },
      );
    });
  });
});

describe("Inbox over the real Core transport", () => {
  test("captures a message, dispatches it to a new chat, and drains the outbox", async () => {
    await withCoreScenario({ scenarioId: BOARD_DENSE_SCENARIO_ID }, async (context) => {
      const projectId = context.manifest.projectId;
      const client = context.client;
      const pageId = createUuidV7();

      await client.workspaceApply({
        operationId: createBoundedOperationId("test.inbox.send"),
        intent: {
          kind: "send_inbox_message",
          page_id: pageId,
          document_id: createUuidV7(),
          body: "Survey onboarding flows\nKeep it read-only.",
        },
      });

      const window = await client.workspaceRead({
        kind: "inbox_window",
        scope: { kind: "library" },
        filter: "inbox",
        window: { after: null, first: 20 },
      });
      if (window.value.kind !== "inbox_window") throw new Error("Wrong Inbox window variant");
      const [coreItem] = window.value.items.items;
      if (!coreItem) throw new Error("Missing Inbox message");
      const item = inboxItemFromCore(coreItem);
      expect(item).toMatchObject({
        pageId,
        pageStatus: { id: "triage", label: "Triage" },
        title: "Survey onboarding flows",
        body: "Survey onboarding flows\nKeep it read-only.",
        source: { kind: "user" },
        location: { kind: "inbox" },
        suggestionState: "waiting",
        proposal: null,
      });
      expect(item.pageKey).toMatch(/-1$/);
      expect(inboxItemFromCore({ ...coreItem, page_status: null }).pageStatus).toBeNull();

      const sessionId = createUuidV7();
      await client.workspaceApply({
        operationId: createBoundedOperationId("test.inbox.dispatch"),
        intent: {
          kind: "dispatch_inbox_entries",
          proposal_id: createUuidV7(),
          page_ids: [pageId],
          basis: window.value.items.items.map((entry) => entry.basis),
          expected_store_epoch: window.store_epoch,
          execution_selection: {
            model_selection: { instanceId: "codex", model: "reviewed-model" },
            interaction_mode: "plan",
          },
          action: inboxDispatchActionToCore(
            inboxNewChatAction(projectId, "Survey three onboarding flows; do not change code."),
          ),
          session_id: sessionId,
        },
      });

      const outbox = await client.workspaceRead({ kind: "inbox_dispatch_outbox", limit: 8 });
      if (outbox.value.kind !== "inbox_dispatch_outbox") throw new Error("Wrong outbox variant");
      expect(outbox.value.dispatches).toMatchObject([
        { session_id: sessionId, project_id: projectId, page_ids: [pageId], thread_id: null },
      ]);
      const [work] = outbox.value.dispatches;
      if (!work) throw new Error("Missing dispatch work");
      expect(work.final_text).toContain("Keep it read-only.");
      expect(work.execution_selection?.model_selection.model).toBe("reviewed-model");

      await client.workspaceApply({
        operationId: createBoundedOperationId("test.inbox.complete"),
        intent: {
          kind: "complete_inbox_dispatch",
          proposal_id: work.proposal_id,
          expected_revision: work.revision,
          message_id: work.message_id,
          dispatched_thread_id: createUuidV7(),
        },
      });
      const summary = await client.workspaceRead({
        kind: "inbox_summary",
        scope: { kind: "library" },
      });
      if (summary.value.kind !== "inbox_summary") throw new Error("Wrong summary variant");
      expect(inboxSummaryFromCore(summary.value.summary, summary.store_epoch)).toMatchObject({
        entryCount: 0,
        dispatchingCount: 0,
        pendingSuggestionCount: 0,
      });
      const dispatched = await client.workspaceRead({
        kind: "inbox_window",
        scope: { kind: "project", project_id: projectId },
        filter: "processed",
        window: { after: null, first: 20 },
      });
      if (dispatched.value.kind !== "inbox_window") throw new Error("Wrong Inbox window variant");
      expect(dispatched.value.items.items.map(inboxItemFromCore)[0]?.proposal).toMatchObject({
        origin: "user",
        state: "completed",
        chat: { sessionId, projectId },
      });
    });
  });
});
