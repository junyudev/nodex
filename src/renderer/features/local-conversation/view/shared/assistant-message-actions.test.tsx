import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../../test/dom";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import { AssistantMessageActionsRow } from "./assistant-message-actions";
import { formatThreadMessageTimestamp } from "./thread-message-timestamp";
import { ThreadForkSubmissionContext } from "./thread-fork-state";

const base = { copyText: null, sentAtMs: null, canRate: false, canFork: true };

describe("assistant action capabilities", () => {
  test("rating does not require copyable text", () => {
    const { getByRole, queryByRole } = render(
      <NodexTooltipProvider>
        <AssistantMessageActionsRow
          actions={{ ...base, canRate: true, canFork: false }}
          threadId="thread"
          turnId="turn"
          isLatestTurn
        />
      </NodexTooltipProvider>,
    );
    expect(getByRole("button", { name: "Rate response" })).toBeTruthy();
    expect(queryByRole("button", { name: "Copy" })).toBeNull();
  });

  test("renders a requested timestamp without inventing an action", () => {
    const sentAtMs = new Date(2026, 8, 22, 9, 30).getTime();
    const { getByText, queryByRole } = render(
      <NodexTooltipProvider>
        <AssistantMessageActionsRow
          actions={{ ...base, canFork: false, sentAtMs, showTimestampWithoutActions: true }}
          threadId="thread"
          turnId="turn"
          isLatestTurn
        />
      </NodexTooltipProvider>,
    );
    expect(getByText(formatThreadMessageTimestamp(sentAtMs)!)).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
  });

  test("omits a timestamp-only footer unless requested", () => {
    const { container } = render(
      <NodexTooltipProvider>
        <AssistantMessageActionsRow
          actions={{ ...base, canFork: false, sentAtMs: Date.now() }}
          threadId="thread"
          turnId="turn"
          isLatestTurn
        />
      </NodexTooltipProvider>,
    );
    expect(container.childElementCount).toBe(0);
  });

  test("does not reserve a row for an unavailable fork capability", () => {
    const { container } = render(
      <NodexTooltipProvider>
        <AssistantMessageActionsRow actions={base} threadId="thread" turnId="turn" isLatestTurn />
      </NodexTooltipProvider>,
    );
    expect(container.childElementCount).toBe(0);
  });

  test("owner submission disables forks and marks only its originating turn busy", async () => {
    const fork = vi.fn();
    const { getByRole, rerender } = render(
      <NodexTooltipProvider>
        <ThreadForkSubmissionContext value="turn">
          <AssistantMessageActionsRow
            actions={base}
            threadId="thread"
            turnId="turn"
            isLatestTurn
            onForkFromTurn={fork}
          />
        </ThreadForkSubmissionContext>
      </NodexTooltipProvider>,
    );
    const button = getByRole("button", { name: "Fork chat from here" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fork).not.toHaveBeenCalled();
    rerender(
      <NodexTooltipProvider>
        <ThreadForkSubmissionContext value="other-turn">
          <AssistantMessageActionsRow
            actions={base}
            threadId="thread"
            turnId="turn"
            isLatestTurn
            onForkFromTurn={fork}
          />
        </ThreadForkSubmissionContext>
      </NodexTooltipProvider>,
    );
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    rerender(
      <NodexTooltipProvider>
        <ThreadForkSubmissionContext value={null}>
          <AssistantMessageActionsRow
            actions={base}
            threadId="thread"
            turnId="turn"
            isLatestTurn
            onForkFromTurn={fork}
          />
        </ThreadForkSubmissionContext>
      </NodexTooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fork).toHaveBeenCalledWith({
      threadId: "thread",
      turnId: "turn",
      message: "",
      isLatestTurn: true,
    });
  });
});
