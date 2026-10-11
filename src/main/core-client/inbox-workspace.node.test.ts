import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  inboxDispatchActionToCore,
  inboxItemFromCore,
  inboxSummaryFromCore,
} from "./inbox-adapter";

describe("Inbox over the real Core transport", () => {
  test("captures a message, dispatches it to a new chat, and drains the outbox", async () => {
    await withCoreScenario({ scenarioId: BOARD_DENSE_SCENARIO_ID }, async (context) => {
      const projectId = context.manifest.projectId;
      const client = context.client;
      const pageId = createUuidV7();

      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "send_inbox_message",
          page_id: pageId,
          document_id: createUuidV7(),
          text: "Survey onboarding flows\nKeep it read-only.",
        },
      });

      const window = await client.workspaceRead({
        kind: "inbox_window",
        filter: "inbox",
        window: { after: null, first: 20 },
      });
      if (window.value.kind !== "inbox_window") throw new Error("Wrong Inbox window variant");
      const [item] = window.value.items.items.map(inboxItemFromCore);
      expect(item).toMatchObject({
        pageId,
        title: "Survey onboarding flows",
        body: "Survey onboarding flows\nKeep it read-only.",
        source: { kind: "user" },
        location: { kind: "inbox" },
        suggestionState: "pending",
        proposal: null,
      });
      expect(item?.pageKey).toMatch(/-1$/);

      const sessionId = createUuidV7();
      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "dispatch_inbox_entries",
          proposal_id: createUuidV7(),
          page_ids: [pageId],
          action: inboxDispatchActionToCore({
            type: "new_chat",
            projectId,
            prompt: "Survey three onboarding flows; do not change code.",
          }),
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

      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "complete_inbox_dispatch",
          proposal_id: work.proposal_id,
          dispatched_thread_id: null,
        },
      });
      const summary = await client.workspaceRead({ kind: "inbox_summary" });
      if (summary.value.kind !== "inbox_summary") throw new Error("Wrong summary variant");
      expect(inboxSummaryFromCore(summary.value.summary)).toMatchObject({
        entryCount: 1,
        dispatchingCount: 0,
        pendingSuggestionCount: 0,
      });
      const dispatched = await client.workspaceRead({
        kind: "inbox_window",
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
