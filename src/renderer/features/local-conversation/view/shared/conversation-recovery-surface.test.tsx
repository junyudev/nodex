import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ConversationRecovery } from "../../../../../shared/conversation-recovery";
import type { CodexTranscriptEntry } from "../../../../../shared/types";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { writeTextToClipboard } from "@/lib/clipboard";
import { render } from "@/test/dom";
import {
  RECOVERY_CONFIRMATION_MS,
  RECOVERY_REVEAL_DELAY_MS,
} from "../../projection/conversation-recovery-presentation";
import {
  ConversationRecoverySurface,
  type ConversationRecoverySurfaceProps,
} from "./conversation-recovery-surface";

vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: vi.fn() }));

const retrying: ConversationRecovery = {
  state: "retrying",
  reason: "unknown",
  attempt: 2,
  maxAttempts: 5,
  retryAt: null,
  updatedAt: null,
};

function entry(recovery: ConversationRecovery): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "recovery-1",
    type: "error",
    kind: "systemEvent",
    markdownText: "Claude API unknown.",
    additionalDetails: "ECONNRESET: request stream closed.",
    recovery,
    createdAt: 0,
    updatedAt: 0,
  };
}

function surface(
  recovery: ConversationRecovery,
  props: Partial<Omit<ConversationRecoverySurfaceProps, "entry">> = {},
) {
  return (
    <NodexTooltipProvider>
      <ConversationRecoverySurface
        entry={entry(recovery)}
        isLatestTurn
        isStreamingTurn={recovery.state === "retrying"}
        {...props}
      />
    </NodexTooltipProvider>
  );
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ConversationRecoverySurface", () => {
  test("updates a real deadline in place and keeps retrying when the countdown ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const view = render(surface({ ...retrying, retryAt: 2000 }));
    expect(view.queryByRole("button")).toBeNull();
    await advance(RECOVERY_REVEAL_DELAY_MS);
    const disclosure = view.getByRole("button", {
      name: "Retrying request · Retrying in 2s · 2/5",
    });
    await advance(2000);
    expect(view.getByRole("button", { name: "Retrying request · 2/5" })).toBe(disclosure);
    expect(view.getByRole("status").textContent).toBe("Retrying request");
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  test("confirms an observed recovery briefly without replaying confirmation from history", async () => {
    vi.useFakeTimers();
    const view = render(surface(retrying));
    await advance(RECOVERY_REVEAL_DELAY_MS);
    view.rerender(surface({ ...retrying, state: "recovered" }));
    expect(view.getByRole("button", { name: "Request resumed" })).toBeTruthy();
    await advance(RECOVERY_CONFIRMATION_MS);
    expect(view.queryByRole("button")).toBeNull();
    view.unmount();
    const history = render(surface({ ...retrying, state: "recovered" }));
    expect(history.queryByRole("status")).toBeNull();
  });

  test("does not flash either retry or recovery when a request recovers before the reveal delay", async () => {
    vi.useFakeTimers();
    const view = render(surface(retrying));
    view.rerender(surface({ ...retrying, state: "recovered" }));
    await advance(RECOVERY_REVEAL_DELAY_MS);
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("status")).toBeNull();
  });

  test("keeps open diagnostics available through recovery and copies the provider evidence", async () => {
    vi.useFakeTimers();
    vi.mocked(writeTextToClipboard).mockResolvedValue(true);
    const view = render(surface(retrying));
    await advance(RECOVERY_REVEAL_DELAY_MS);
    const disclosure = view.getByRole("button", { name: "Retrying request · 2/5" });
    await act(async () => {
      disclosure.focus();
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    view.rerender(surface({ ...retrying, state: "recovered" }));
    await advance(RECOVERY_CONFIRMATION_MS);
    expect(view.getByRole("button", { name: "Request resumed" })).toBe(disclosure);
    // The row already states the recovery; only copying repeats it.
    expect(view.getByRole("region", { name: "Recovery diagnostics" }).textContent).toBe(
      "Claude API unknown.\nECONNRESET: request stream closed.",
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy diagnostics" }));
      await Promise.resolve();
    });
    expect(writeTextToClipboard).toHaveBeenCalledExactlyOnceWith(
      "Claude API unknown.\n\nECONNRESET: request stream closed.\n\nState: recovered\nReason: unknown\nRetry: 2/5",
    );
    expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    expect(view.queryByRole("button")).toBeNull();
  });

  test("guards a final-failure action while pending and keeps failures available for another attempt", async () => {
    let rejectAction: (error: Error) => void = () => {};
    const onContinue = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAction = reject;
        }),
    );
    const failed = { ...retrying, state: "failed" as const };
    const view = render(surface(failed, { onContinue }));
    const button = view.getByRole("button", { name: "Continue" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      rejectAction(new Error("The provider is unavailable."));
      await Promise.resolve();
    });
    expect(view.getByRole("alert").textContent).toBe("The provider is unavailable.");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(view.getByRole("button", { name: "Request failed" })).toBeTruthy();
    view.rerender(surface(failed, { onContinue, isLatestTurn: false }));
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  test("uses the available account action for authentication failures and does not treat stopping as failure", async () => {
    const onManageProvider = vi.fn();
    const onContinue = vi.fn();
    const view = render(
      surface(
        { ...retrying, state: "failed", reason: "authentication" },
        { onContinue, onManageProvider },
      ),
    );
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Agent settings" }));
      await Promise.resolve();
    });
    expect(onManageProvider).toHaveBeenCalledTimes(1);
    view.rerender(surface({ ...retrying, state: "stopped" }, { onContinue, onManageProvider }));
    expect(view.getByRole("button", { name: "Stopped" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(view.queryByRole("button", { name: "Agent settings" })).toBeNull();
  });

  test.each(["rejected", "accepted"] as const)(
    "retains a %s continuation outcome while an optimistic turn temporarily hides its action",
    async (outcome) => {
      let resolveAction: () => void = () => {};
      let rejectAction: (error: Error) => void = () => {};
      const onContinue = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveAction = resolve;
            rejectAction = reject;
          }),
      );
      const failed = { ...retrying, state: "failed" as const };
      const view = render(surface(failed, { onContinue }));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Continue" }));
        await Promise.resolve();
      });
      view.rerender(surface(failed, { onContinue, isLatestTurn: false }));
      expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
      await act(async () => {
        if (outcome === "rejected") rejectAction(new Error("The continuation was rejected."));
        else resolveAction();
        await Promise.resolve();
      });
      expect(view.queryByRole("alert")).toBeNull();
      view.rerender(surface(failed, { onContinue }));
      expect(view.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
      expect(onContinue).toHaveBeenCalledTimes(1);
      if (outcome === "rejected")
        expect(view.getByRole("alert").textContent).toBe("The continuation was rejected.");
      else expect(view.queryByRole("alert")).toBeNull();
    },
  );
});
