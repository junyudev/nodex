import { describe, expect, test } from "vite-plus/test";
import {
  codexConversationRecoveryReason,
  isWaitingForNetworkMessage,
  parseConversationRetryProgress,
} from "./conversation-recovery";

describe("conversation recovery reasons", () => {
  test.each([
    [429, "rate_limit"],
    [529, "overloaded"],
    [401, "authentication"],
  ] as const)(
    "uses upstream HTTP %s before a broad connection wrapper",
    (httpStatusCode, reason) => {
      expect(
        codexConversationRecoveryReason({ responseStreamDisconnected: { httpStatusCode } }),
      ).toBe(reason);
    },
  );

  test("keeps an explicit connection cause when the HTTP status is unavailable or unclassified", () => {
    expect(
      codexConversationRecoveryReason({ responseStreamConnectionFailed: { httpStatusCode: null } }),
    ).toBe("connection");
    expect(codexConversationRecoveryReason({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe(
      "connection",
    );
  });

  test("reads direct protocol codes without treating absent or future details as network evidence", () => {
    expect(codexConversationRecoveryReason("usageLimitExceeded")).toBe("usage_limit");
    expect(codexConversationRecoveryReason("flexUnavailable")).toBe("overloaded");
    expect(codexConversationRecoveryReason(null)).toBe("unknown");
    expect(codexConversationRecoveryReason({})).toBe("unknown");
    expect(codexConversationRecoveryReason({ futureError: { httpStatusCode: null } })).toBe(
      "unknown",
    );
  });

  test("reads disconnect evidence from the message the way the runtime does", () => {
    expect(codexConversationRecoveryReason("other", "stream disconnected before completion")).toBe(
      "connection",
    );
    expect(codexConversationRecoveryReason("other", "Something broke.")).toBe("unknown");
  });
});

describe("provider retry progress", () => {
  test.each([
    "Reconnecting... 2/5",
    "Retrying… 2 / 5",
    "Service is busy, RECONNECTING 2/5",
    "Retrying 2/5. Please wait.",
  ])("reads explicit provider progress from %s", (message) => {
    expect(parseConversationRetryProgress(message)).toEqual({ attempt: 2, maxAttempts: 5 });
  });

  test("preserves supplied counters instead of clamping them to a guessed retry budget", () => {
    expect(parseConversationRetryProgress("Retrying 6/5")).toEqual({ attempt: 6, maxAttempts: 5 });
    expect(parseConversationRetryProgress("Retrying 9007199254740991/9007199254740991")).toEqual({
      attempt: Number.MAX_SAFE_INTEGER,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    });
  });

  test.each([
    "Claude API unknown.",
    "Retrying request",
    "Request failed after 2/5 attempts",
    "Retrying 0/5",
    "Retrying 1/0",
    "Retrying -1/5",
    "Retrying 1/-5",
    "Retrying 1.5/5",
    "Retrying 1/2.5",
    "Retrying 9007199254740992/5",
    "Retrying 1/9007199254740992",
  ])("does not invent valid progress from %s", (message) => {
    expect(parseConversationRetryProgress(message)).toBeNull();
  });
});

describe("network waits", () => {
  test.each([
    ["Reconnecting... waiting for network", true],
    ["Waiting for the network", true],
    ["Reconnecting... 2/5", false],
    ["The network request failed", false],
    [null, false],
  ] as const)("%s → %s", (message, expected) => {
    expect(isWaitingForNetworkMessage(message)).toBe(expected);
  });
});
