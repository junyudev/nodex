import { act, fireEvent, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../../../test/dom";
import { projectCodexCanonicalTurnItemViews } from "../../../../../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../../../../../shared/codex-transcript-entry-projection";
import { getToolComponent } from "./get-tool-component";

describe("native automation proposal card", () => {
  test.each(["suggested_create", "suggested_update"] as const)(
    "opens %s for review using the result target and revision",
    async (mode) => {
      const proposal = {
        mode,
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
            tool: "automation_update",
            status: "completed",
            arguments: { ...proposal, targetSessionId: "session:raw" },
            appContext: null,
            pluginId: null,
            readOnlyHint: false,
            result: {
              content: [],
              structuredContent: { ok: true, data: { proposal, committed: false } },
              _meta: null,
            },
            error: null,
            durationMs: 2,
          },
        ],
      });
      if (!view) throw new Error("Missing native automation projection");
      const entry = projectCodexItemViewToTranscriptEntry(view, "live", 1);
      const Component = getToolComponent(entry);
      if (!Component) throw new Error("Missing native automation card");
      const onOpen = vi.fn();
      const screen = render(<Component item={entry} onOpenSummaryScheduledAutomation={onOpen} />);
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
