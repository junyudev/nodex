import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { inspectScenario } from "../../../scripts/scenarios/seed/scenario-seed";
import {
  requireSidebarChatStatusFacts,
  SIDEBAR_CHAT_STATUS_SCENARIO_ID,
  SIDEBAR_CHAT_STATUS_SCENARIO_REVISION,
} from "../../../scripts/scenarios/scenarios/sidebar-chat-status";
import { createBoundedOperationId } from "../../shared/operation-identity";

describe("sidebar/chat-status over the real Core transport", () => {
  test("preserves chat status and unread news after startup without a native identity", async () => {
    await withCoreScenario(
      { scenarioId: SIDEBAR_CHAT_STATUS_SCENARIO_ID },
      async ({ client, manifest, seed }) => {
        // Startup projects native unread state before the sidebar reads Sessions.
        await client.workspaceApply({
          operationId: createBoundedOperationId("scenario.thread.read-state.select"),
          intent: {
            kind: "select_thread_read_state_identity",
            identity_key: null,
            execution_host_keys: {},
          },
        });
        const observed = requireSidebarChatStatusFacts(await inspectScenario(manifest, seed));
        expect(observed.projectIdsByKey.statusProject).toBe(manifest.projectId);
        expect(new Set(Object.values(observed.projectIdsByKey)).size).toBe(3);
        expect(new Set(Object.values(observed.sessionIdsByKey)).size).toBe(11);

        const chats = Object.fromEntries(
          await Promise.all(
            Object.entries(observed.sessionIdsByKey).map(async ([key, sessionId]) => [
              key,
              await seed.readSession(sessionId),
            ]),
          ),
        );
        expect(chats).toMatchObject({
          waitingApproval: {
            displayTitle: "Waiting for approval",
            unread: false,
            thread: { statusType: "active", statusActiveFlags: ["waitingOnApproval"] },
          },
          waitingAnswer: {
            displayTitle: "Waiting for an answer",
            unread: false,
            thread: { statusType: "active", statusActiveFlags: ["waitingOnUserInput"] },
          },
          working: {
            displayTitle: "Working",
            unread: false,
            thread: { statusType: "active", statusActiveFlags: [] },
          },
          unread: {
            displayTitle: "Unread reply",
            unread: true,
            thread: null,
          },
          quiet: {
            displayTitle: "Quiet chat",
            unread: false,
            thread: { statusType: "idle", statusActiveFlags: [] },
          },
          collapsedWaiting: {
            projectId: observed.projectIdsByKey.collapsedWaitingProject,
            unread: false,
            thread: { statusType: "active", statusActiveFlags: ["waitingOnApproval"] },
          },
          collapsedWaitingUnread: {
            projectId: observed.projectIdsByKey.collapsedWaitingProject,
            unread: true,
            thread: null,
          },
          collapsedUnread: {
            projectId: observed.projectIdsByKey.collapsedUnreadProject,
            unread: true,
            thread: null,
          },
          collapsedUnreadWorking: {
            projectId: observed.projectIdsByKey.collapsedUnreadProject,
            unread: false,
            thread: { statusType: "active", statusActiveFlags: [] },
          },
          reviewWaiting: {
            unread: false,
            thread: { statusType: "active", statusActiveFlags: ["waitingOnUserInput"] },
          },
          reviewUnread: {
            unread: true,
            thread: null,
          },
        });
        const review = await seed.listSidebarSectionItems(observed.reviewSectionId);
        expect(
          review.items.map((item) => (item.kind === "session" ? item.session.id : null)),
        ).toEqual([observed.sessionIdsByKey.reviewWaiting, observed.sessionIdsByKey.reviewUnread]);

        await expect(inspectScenario(manifest, seed)).resolves.toEqual(observed);
        expect(() => requireSidebarChatStatusFacts({ ...observed, sessionIdsByKey: {} })).toThrow(
          /missing identities/u,
        );
        expect(() =>
          requireSidebarChatStatusFacts({
            ...observed,
            scenarioRevision: SIDEBAR_CHAT_STATUS_SCENARIO_REVISION + 1,
          }),
        ).toThrow(/facts/u);
      },
    );
  });
});
