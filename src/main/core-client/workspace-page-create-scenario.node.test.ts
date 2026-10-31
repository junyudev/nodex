import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";

import { runScenarioProjectWorkspace } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/sidebar-linked-page-status";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { CreatePageForCommand } from "../../shared/workspace-page-create";

const command = (target: CreatePageForCommand["for"]): CreatePageForCommand => ({
  for: target,
  operationId: createBoundedOperationId("workspace.page.create-for"),
  pageId: createUuidV7(),
  documentId: createUuidV7(),
  title: "A **literal** title",
});

describe("Workspace Page creation through the public Core transport", () => {
  test("resolves the content home and returns an immediately readable linked Page on exact retry", async () => {
    await withCoreScenario({ scenarioId: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID }, async (ctx) => {
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
      const detail = await ctx.client.libraryRead({ kind: "page_detail", page_id: root.pageId });
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
    });
  });
});
