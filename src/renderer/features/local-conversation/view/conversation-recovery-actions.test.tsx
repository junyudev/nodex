import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render } from "@/test/dom";
import type { ConversationRecoveryReason } from "../../../../shared/conversation-recovery";
import type { ThreadStageActions, ThreadTranscriptBlockModel } from "../thread-stage-types";
import { ConversationRecoveryActionsProvider } from "./conversation-recovery-actions";
import { ThreadRecoveryBlock } from "./blocks/local-conversation-block-leaves";

function recoveryBlock(reason: ConversationRecoveryReason): ThreadTranscriptBlockModel {
  return {
    id: "failure",
    turnId: "failed-turn",
    createdAt: 1,
    updatedAt: 1,
    searchableText: "The provider rejected this request.",
    type: "systemError",
    entry: {
      threadId: "thread",
      turnId: "failed-turn",
      itemId: "failure",
      type: "error",
      kind: "systemEvent",
      markdownText: "The provider rejected this request.",
      createdAt: 1,
      updatedAt: 1,
      recovery: {
        state: "failed",
        reason,
        attempt: null,
        maxAttempts: null,
        retryAt: null,
        updatedAt: 1,
      },
    },
  };
}

function surface({
  onManageFailedProvider,
  onContinueAfterFailure,
  reason = "authentication",
  showRow = true,
}: Pick<ThreadStageActions, "onManageFailedProvider" | "onContinueAfterFailure"> & {
  reason?: ConversationRecoveryReason;
  showRow?: boolean;
}) {
  return (
    <NodexTooltipProvider>
      <ConversationRecoveryActionsProvider
        onManageFailedProvider={onManageFailedProvider}
        onContinueAfterFailure={onContinueAfterFailure}
      >
        {showRow ? (
          <ThreadRecoveryBlock block={recoveryBlock(reason)} isLatestTurn isStreamingTurn={false} />
        ) : null}
      </ConversationRecoveryActionsProvider>
    </NodexTooltipProvider>
  );
}

describe("Conversation recovery actions", () => {
  test.each(["authentication", "usage_limit"] as const)(
    "delegates %s settings to the owner of the failed Turn",
    async (reason) => {
      const onManageFailedProvider = vi.fn();
      const view = render(surface({ reason, onManageFailedProvider }));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Agent settings" }));
        await Promise.resolve();
      });
      expect(onManageFailedProvider).toHaveBeenCalledExactlyOnceWith("failed-turn");
      expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
    },
  );

  test("omits settings navigation when the conversation supplies no settings action", () => {
    const view = render(surface({}));
    expect(view.queryByRole("button", { name: "Agent settings" })).toBeNull();
  });

  test("keeps a continuation pending and its rejection visible across row removal and remount", async () => {
    let rejectContinuation: (error: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, reject) => {
      rejectContinuation = reject;
    });
    const onContinueAfterFailure = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(undefined);
    const props = { reason: "unknown" as const, onContinueAfterFailure };
    const view = render(surface(props));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Continue" }));
      await Promise.resolve();
    });
    expect(onContinueAfterFailure).toHaveBeenCalledExactlyOnceWith("failed-turn");
    view.rerender(surface({ ...props, showRow: false }));
    view.rerender(surface(props));
    expect(view.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Continue" }));
      rejectContinuation(new Error("The request was not accepted."));
      await Promise.resolve();
    });
    expect(view.getByRole("alert").textContent).toBe("The request was not accepted.");
    expect(onContinueAfterFailure).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Continue" }));
      await Promise.resolve();
    });
    expect(onContinueAfterFailure).toHaveBeenCalledTimes(2);
    expect(view.queryByRole("alert")).toBeNull();
  });
});
