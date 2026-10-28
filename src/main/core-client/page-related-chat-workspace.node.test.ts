import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { runScenarioProjectWorkspace } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";

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
