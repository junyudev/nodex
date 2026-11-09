import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../../../test/dom";
import { projectCodexCanonicalTurnItemViews } from "../../../../../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../../../../../shared/codex-transcript-entry-projection";
import { getToolComponent } from "./get-tool-component";
import {
  ConversationRuntimeContext,
  type ConversationRuntime,
} from "../../../conversation-runtime";
import { ThreadToolSurfaceBlock } from "../../blocks/local-conversation-block-leaves";
import { CodexThreadSettingsProvider } from "../../../../../lib/use-codex-thread-settings";
import { THREAD_SETTINGS_STORAGE_KEY } from "../../../../../lib/codex-thread-settings";

describe("native Automation proposal card", () => {
  test("hydrates only the addressed Automation before offering its resolved proposal", async () => {
    const proposal = {
      operation: "suggested_update",
      kind: "heartbeat",
      id: "automation-1",
      expectedRevision: 7,
      status: "PAUSED",
      name: "Follow up",
      prompt: "Check progress",
      rrule: "FREQ=DAILY",
      targetSessionId: "session:resolved",
    };
    const entry = (outputOmitted: boolean) => {
      const [view] = projectCodexCanonicalTurnItemViews({
        threadId: "thread-1",
        turnId: "turn-1",
        observedAtMs: 1,
        turnStatus: "completed",
        items: [
          {
            type: "mcpToolCall",
            id: "proposal-1",
            server: "nodex_app",
            tool: "automations_update",
            status: "completed",
            arguments: { ...proposal, targetSessionId: "session:raw" },
            appContext: null,
            mcpAppUi: null,
            pluginId: null,
            readOnlyHint: false,
            result: {
              content: [],
              structuredContent: outputOmitted ? null : { proposal, committed: false },
              _meta: null,
            },
            ...(outputOmitted ? { outputOmitted: true } : {}),
            error: null,
            durationMs: 2,
          },
        ],
      });
      if (!view) throw new Error("Missing native Automation projection");
      return projectCodexItemViewToTranscriptEntry(view, "live", 1);
    };
    const metadata = entry(true);
    const Component = getToolComponent(metadata);
    if (!Component) throw new Error("Missing native Automation card");
    const readItemDetail = vi.fn(async () => undefined);
    const runtime = { readItemDetail } as unknown as ConversationRuntime;
    const onOpen = vi.fn();
    const card = (outputOmitted: boolean) => (
      <CodexThreadSettingsProvider>
        <ConversationRuntimeContext.Provider value={runtime}>
          <ThreadToolSurfaceBlock
            block={{
              id: "proposal-1",
              type: "mcpToolCall",
              turnId: "turn-1",
              createdAt: 1,
              updatedAt: 1,
              searchableText: "Follow up",
              entry: entry(outputOmitted),
            }}
            isLatestTurn
            isStreamingTurn={false}
            onOpenSummaryAutomation={onOpen}
          />
        </ConversationRuntimeContext.Provider>
      </CodexThreadSettingsProvider>
    );
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_PROSE" }),
    );
    try {
      const view = render(card(true));
      await waitFor(() => expect(readItemDetail).toHaveBeenCalledWith("thread-1", "proposal-1"));
      expect(view.queryByRole("button", { name: /Follow up/ })).toBeNull();
      expect(onOpen).not.toHaveBeenCalled();
      view.rerender(card(false));
      const open = await view.findByRole("button", { name: /Follow up/ });
      await act(async () => {
        fireEvent.click(open);
        await Promise.resolve();
      });
      expect(readItemDetail).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ updateInput: proposal, mode: "suggested-update" }),
      );
    } finally {
      localStorage.removeItem(THREAD_SETTINGS_STORAGE_KEY);
    }
  });

  test.each(["suggested_create", "suggested_update"] as const)(
    "opens %s for review using the result target and revision",
    async (mode) => {
      const proposal = {
        operation: mode,
        kind: "heartbeat",
        name: "Follow up",
        prompt: "Check progress",
        rrule: "FREQ=DAILY",
        targetSessionId: "session:resolved",
        notificationPolicy: "failed_runs_only",
        ...(mode === "suggested_update"
          ? { id: "automation-1", status: "PAUSED", expectedRevision: 7 }
          : {}),
      };
      const [view] = projectCodexCanonicalTurnItemViews({
        threadId: "thread-1",
        turnId: "turn-1",
        observedAtMs: 1,
        turnStatus: "completed",
        commandExecutionStartedAtMsById: {},
        interruptedCommandExecutionItemIds: [],
        items: [
          {
            type: "mcpToolCall",
            id: "proposal-1",
            server: "nodex_app",
            tool: "automations_update",
            status: "completed",
            arguments: { ...proposal, targetSessionId: "session:raw" },
            appContext: null,
            mcpAppUi: null,
            pluginId: null,
            readOnlyHint: false,
            result: {
              content: [],
              structuredContent: { proposal, committed: false },
              _meta: null,
            },
            error: null,
            durationMs: 2,
          },
        ],
      });
      if (!view) throw new Error("Missing native Automation projection");
      const entry = projectCodexItemViewToTranscriptEntry(view, "live", 1);
      const Component = getToolComponent(entry);
      if (!Component) throw new Error("Missing native Automation card");
      const onOpen = vi.fn();
      const screen = render(<Component item={entry} onOpenSummaryAutomation={onOpen} />);
      expect(onOpen).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(screen.container).getByRole("button", { name: /Follow up/ }));
        await Promise.resolve();
      });
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          proposalId: "proposal-1",
          mode: mode === "suggested_create" ? "suggested-create" : "suggested-update",
          [mode === "suggested_create" ? "createInput" : "updateInput"]: proposal,
        }),
      );
    },
  );
});
