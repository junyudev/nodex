import { describe, expect, test } from "vite-plus/test";

import { WORKFLOW_STATUS_ORDER } from "../../shared/workflow-status";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  requireSidebarLinkedPageStatusScenarioFacts,
  SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID,
  SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_REVISION,
} from "../../../scripts/scenarios/scenarios/sidebar-linked-page-status";

describe("sidebar/linked-page-status over the real Core transport", () => {
  test("creates workflow Pages and idle, read Chats with exact durable links and pinning", async () => {
    await withCoreScenario(
      { scenarioId: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID },
      async ({ client, facts, manifest, seed }) => {
        const observed = requireSidebarLinkedPageStatusScenarioFacts(facts);
        const project = client.forProject(manifest.projectId);
        const pageKeys = new Set<string>();
        for (const status of WORKFLOW_STATUS_ORDER) {
          const page = observed.pages[status];
          const snapshot = await project.databaseRead({ kind: "row_detail", page_id: page.pageId });
          if (snapshot.value.kind !== "row_detail") throw new Error("Expected a Database row");
          expect(snapshot.value.value.summary).toMatchObject({
            page_id: page.pageId,
            title: page.title,
            database_values: { status },
            page_key: expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/u),
          });
          pageKeys.add(snapshot.value.value.summary.page_key!);
        }
        expect(pageKeys.size).toBe(5);

        const standalone = await project.libraryRead({
          kind: "page_detail",
          page_id: observed.pages.noStatus.pageId,
        });
        expect(standalone.value).toMatchObject({
          kind: "page_detail",
          value: {
            page: { title: observed.pages.noStatus.title, parent: { kind: "library" } },
            data_source_context: { kind: "standalone" },
          },
        });

        const chats = Object.values(observed.chats);
        expect(chats).toHaveLength(9);
        expect(new Set(chats.map((chat) => chat.sessionId)).size).toBe(9);
        for (const chat of chats) {
          const snapshot = await project.workspaceRead({
            kind: "session",
            session_id: chat.sessionId,
          });
          expect(snapshot.value).toMatchObject({
            kind: "session",
            session: {
              id: chat.sessionId,
              project_id: manifest.projectId,
              no_thread_fallback_title: chat.title,
              display_title: chat.title,
              thread_id: null,
              pinned: chat.pinned,
              unread: false,
              archived: false,
            },
          });
          const linkedPageIds: string[] = [];
          for (const page of Object.values(observed.pages)) {
            const window = await seed.readPageChats(page.pageId);
            if (window.items.some((item) => item.sessionId === chat.sessionId)) {
              linkedPageIds.push(page.pageId);
            }
          }
          expect(new Set(linkedPageIds)).toEqual(new Set(chat.linkedPageIds));
          const summary = await project.workspaceRead({
            kind: "session_linked_page_summaries",
            session_ids: [chat.sessionId],
          });
          if (summary.value.kind !== "session_linked_page_summaries") {
            throw new Error("Expected Session Linked Page summaries");
          }
          // Each Chat's initial links share one operation timestamp.
          const earliestPageId = [...linkedPageIds].sort()[0];
          expect(summary.value.summaries.map((item) => item.page.page_id)).toEqual(
            earliestPageId ? [earliestPageId] : [],
          );
          expect(summary.value.summaries[0]?.page.status?.option_id ?? null).toBe(
            chat.expectedStatusOptionId,
          );
        }
        expect(observed.chats.multiple.linkedPageIds).toHaveLength(2);
        expect(observed.chats.multiple.expectedStatusOptionId).toBe("build");
        expect(observed.chats.noStatus.linkedPageIds).toEqual([observed.pages.noStatus.pageId]);
        expect(observed.chats.unlinked.linkedPageIds).toEqual([]);
        expect(observed.chats.pinnedBuild).toMatchObject({
          pinned: true,
          linkedPageIds: [observed.pages.build.pageId],
          expectedStatusOptionId: "build",
        });

        expect(() =>
          requireSidebarLinkedPageStatusScenarioFacts({ ...observed, chats: {} }),
        ).toThrow(/facts/u);
        expect(() =>
          requireSidebarLinkedPageStatusScenarioFacts({
            ...observed,
            scenarioRevision: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_REVISION + 1,
          }),
        ).toThrow(/identity/u);
      },
    );
  });
});
