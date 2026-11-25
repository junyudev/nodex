import { describe, expect, test } from "vite-plus/test";
import {
  allProjectSessionInvalidation,
  planCoreWorkspaceNotifications,
} from "./core-project-workspace-invalidation";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY,
  PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID,
  requirePageRelatedChatActivityScenarioFacts,
} from "../../../scripts/scenarios/scenarios/page-related-chat-activity";

describe("Core Workspace notification planning", () => {
  test("preserves every old and new Session scope across a move", () => {
    const plan = planCoreWorkspaceNotifications({
      inboxChanged: false,
      projectIds: ["project:a", "project:b"],
      sessionIds: ["session:one"],
      threadIds: ["thread:one"],
      sessionSummaryScopes: [
        { kind: "project", projectId: "project:a" },
        { kind: "project", projectId: "project:b" },
      ],
      sessionDetailIds: ["session:one"],
    });
    expect(plan.sessions).toEqual({
      summaryScopes: [
        { kind: "project", projectId: "project:a" },
        { kind: "project", projectId: "project:b" },
      ],
      detailInvalidation: {
        kind: "sessions",
        sessionIds: ["session:one"],
      },
      changeType: "update",
    });
    expect(plan.invalidateStandaloneRoots).toBe(false);
  });

  test("maps catalog semantics without collapsing them to a generic update", () => {
    const plan = planCoreWorkspaceNotifications({
      projectCatalogChange: "sources_updated",
      inboxChanged: false,
      projectIds: ["project:a"],
      sessionIds: [],
      threadIds: [],
      sessionSummaryScopes: [],
      sessionDetailIds: [],
    });
    expect(plan.project).toEqual({
      projectId: "project:a",
      changeType: "sources",
    });
    expect(plan.invalidateStandaloneRoots).toBe(false);
  });

  test.each(["created", "lifecycle_updated"] as const)(
    "invalidates standalone roots for %s Project catalog changes",
    (projectCatalogChange) => {
      const plan = planCoreWorkspaceNotifications({
        projectCatalogChange,
        inboxChanged: false,
        projectIds: ["project:a"],
        sessionIds: [],
        threadIds: [],
        sessionSummaryScopes: [],
        sessionDetailIds: [],
      });

      expect(plan.invalidateStandaloneRoots).toBe(true);
    },
  );

  test("uses a global summary scope when durable history must be resynced", () => {
    expect(allProjectSessionInvalidation()).toEqual({
      summaryScopes: [{ kind: "all" }],
      detailInvalidation: { kind: "all" },
      changeType: "update",
    });
  });
});

describe("page/related-chat-activity over the real Core transport", () => {
  test("materializes working, unread, and threadless related Chats through public operations", async () => {
    await withCoreScenario(
      { scenarioId: PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID },
      async ({ facts, manifest, seed }) => {
        const observed = requirePageRelatedChatActivityScenarioFacts(facts);
        expect(observed.activityPage).toMatchObject({
          pageId: manifest.pageIdsByKey[PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY],
          relatedCount: 2,
          workingCount: 1,
          unreadCount: 1,
          soleSessionId: null,
        });
        expect(observed.openActionPage.relatedCount).toBe(0);

        const chats = await seed.readPageChats(observed.activityPage.pageId);
        expect(new Set(chats.items.map((item) => item.sessionId))).toEqual(
          new Set([observed.chats.attachedSessionId, observed.chats.threadlessSessionId]),
        );
        expect(
          chats.items.find((item) => item.sessionId === observed.chats.attachedSessionId),
        ).toMatchObject({
          threadId: observed.chats.workingThreadId,
          unread: true,
          threadStatus: { statusType: "active", activeFlags: [] },
        });
        expect(
          chats.items.find((item) => item.sessionId === observed.chats.threadlessSessionId),
        ).toMatchObject({ threadId: null, unread: false });
      },
    );
  });
});
