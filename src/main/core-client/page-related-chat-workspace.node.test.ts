import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";

describe("Page related Chats over the real Core transport", () => {
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
