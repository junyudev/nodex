import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY,
  PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID,
  requirePageRelatedChatActivityScenarioFacts,
} from "../../../scripts/scenarios/scenarios/page-related-chat-activity";

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
