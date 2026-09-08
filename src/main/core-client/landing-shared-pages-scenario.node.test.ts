import { expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";

test("Shared Pages starts with ready content and a linked Chat without fabricated execution", async () => {
  await withCoreScenario(
    { scenarioId: "landing/shared-pages" },
    async ({ manifest, seed, client }) => {
      const pageId = manifest.pageIdsByKey.brief;
      if (!pageId) throw new Error("Missing brief");
      const board = await seed.readBoard(manifest.projectId, manifest.databaseViewId);
      expect(board.totalRows).toBe(3);
      const page = await seed.readPage(manifest.projectId, pageId);
      expect(page.documentReadiness).toBe("ready");
      const scoped = client.forProject(manifest.projectId);
      const activity = await scoped.workspaceRead({
        kind: "page_chat_activity_summaries",
        page_access_project_id: manifest.projectId,
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
            sole_session_id: manifest.entityIdsByKey?.chat,
          },
        ],
      });
      const detail = await scoped.workspaceRead({
        kind: "page_chat_window",
        page_access_project_id: manifest.projectId,
        page_id: pageId,
        include_archived: false,
        window: { after: null, first: 50 },
      });
      expect(detail.value).toMatchObject({
        kind: "page_chat_window",
        chats: {
          items: [{ session_id: manifest.entityIdsByKey?.chat, thread_id: null }],
          next_cursor: null,
        },
      });
    },
  );
});
