import { describe, expect, test } from "vite-plus/test";
import {
  conversationRecoveryReason,
  type ConversationRecovery,
} from "../../../../shared/conversation-recovery";
import type { CodexTranscriptEntry } from "../../../../shared/types";
import {
  recoveryAction,
  recoveryDiagnosticText,
  recoveryProgressLabel,
  recoveryRetrySeconds,
  recoveryStatusLabel,
} from "./conversation-recovery-presentation";

const retrying: ConversationRecovery = {
  state: "retrying",
  reason: "unknown",
  attempt: 2,
  maxAttempts: 5,
  retryAt: null,
  updatedAt: null,
};

describe("conversation recovery presentation", () => {
  test("keeps the original provider JSON in diagnostics when the visible message was normalized", () => {
    const rawMessage = JSON.stringify({
      error: { message: "Server overloaded", request_id: "req-42", code: 529 },
    });
    const entry: CodexTranscriptEntry = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "error-1",
      type: "error",
      kind: "systemEvent",
      markdownText: "Server overloaded",
      rawItem: { type: "error", message: rawMessage },
      additionalDetails: "Upstream service returned 529",
      recovery: retrying,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(recoveryDiagnosticText(entry)).toBe(
      `${rawMessage}\n\nUpstream service returned 529\n\nState: retrying\nReason: unknown\nRetry: 2/5`,
    );
    expect(recoveryDiagnosticText({ ...entry, recovery: undefined })).toBe(
      `${rawMessage}\n\nUpstream service returned 529`,
    );
    expect(
      recoveryDiagnosticText({ ...entry, rawItem: { type: "message", message: "unrelated" } }),
    ).toBe(
      "Server overloaded\n\nUpstream service returned 529\n\nState: retrying\nReason: unknown\nRetry: 2/5",
    );
  });

  test("counts down only provider deadlines and never interprets expiry as recovery", () => {
    expect(recoveryRetrySeconds(retrying, 1000)).toBeNull();
    expect(recoveryProgressLabel(retrying, 1000)).toBe("2/5");
    const scheduled = { ...retrying, retryAt: 2501 };
    expect(recoveryRetrySeconds(scheduled, 1000)).toBe(2);
    expect(recoveryProgressLabel(scheduled, 1000)).toBe("Retrying in 2s · 2/5");
    expect(recoveryRetrySeconds(scheduled, 2501)).toBe(0);
    expect(recoveryProgressLabel(scheduled, 3000)).toBe("2/5");
    expect(recoveryStatusLabel(scheduled)).toBe("Retrying request");
    expect(recoveryRetrySeconds({ ...scheduled, state: "recovered" }, 1000)).toBeNull();
  });

  test("does not invent a network diagnosis or a retry budget", () => {
    expect(recoveryStatusLabel(retrying)).toBe("Retrying request");
    expect(recoveryStatusLabel({ ...retrying, reason: "connection" })).toBe("Reconnecting");
    expect(recoveryStatusLabel({ ...retrying, state: "recovered" })).toBe("Request resumed");
    expect(recoveryProgressLabel({ ...retrying, maxAttempts: null }, 0)).toBe("Attempt 2");
    expect(recoveryProgressLabel({ ...retrying, maxAttempts: 1 }, 0)).toBe("Attempt 2");
    expect(recoveryProgressLabel({ ...retrying, attempt: 0 }, 0)).toBeNull();
    expect(recoveryProgressLabel({ ...retrying, state: "stopped" }, 0)).toBeNull();
  });

  test("offers actions only for the latest idle failed turn and routes account issues to settings", () => {
    const failed = { ...retrying, state: "failed" as const };
    expect(recoveryAction(retrying, true, false)).toBeNull();
    expect(recoveryAction({ ...failed, state: "stopped" }, true, false)).toBeNull();
    expect(recoveryAction({ ...failed, state: "recovered" }, true, false)).toBeNull();
    expect(recoveryAction(failed, false, false)).toBeNull();
    expect(recoveryAction(failed, true, true)).toBeNull();
    expect(recoveryAction(failed, true, false)).toBe("continue");
    expect(recoveryAction({ ...failed, reason: "authentication" }, true, false)).toBe(
      "manage-provider",
    );
    expect(recoveryAction({ ...failed, reason: "usage_limit" }, true, false)).toBe(
      "manage-provider",
    );
  });

  test("a conversation the provider can't reopen says so and offers no Continue", () => {
    const unrecoverable = {
      ...retrying,
      state: "failed" as const,
      reason: conversationRecoveryReason("native_session_unrecoverable"),
    };
    expect(recoveryStatusLabel(unrecoverable)).toBe("Couldn't reopen this conversation");
    expect(recoveryAction(unrecoverable, true, false)).toBeNull();
  });
});
