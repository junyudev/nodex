import { describe, expect, test } from "vite-plus/test";
import { inboxNewChatAction } from "../../shared/inbox";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createBoundedOperationId } from "../../shared/operation-identity";
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
        entryCount: 1,
        dispatchingCount: 0,
        pendingSuggestionCount: 0,
      });
      const dispatched = await client.workspaceRead({
        kind: "inbox_window",
        scope: { kind: "library" },
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
