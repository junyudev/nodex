import { describe, expect, test } from "vite-plus/test";
import {
  codexConversationRecoveryReason,
  conversationRecoveryReason,
  parseConversationRetryProgress,
} from "./conversation-recovery";

describe("conversation recovery reasons", () => {
  test.each([
    ["api_error_529", "overloaded"],
    ["overloaded", "overloaded"],
    ["serverOverloaded", "overloaded"],
    ["api_error_429", "rate_limit"],
    ["rate_limit", "rate_limit"],
    ["rateLimitExceeded", "rate_limit"],
    ["usageLimitExceeded", "usage_limit"],
    ["billing_error", "usage_limit"],
    ["blocking_limit", "usage_limit"],
    ["unauthorized", "authentication"],
    ["authentication_failed", "authentication"],
    ["api_error_401", "authentication"],
    ["httpConnectionFailed", "connection"],
    ["responseStreamConnectionFailed", "connection"],
    ["responseStreamDisconnected", "connection"],
    ["responseTooManyFailedAttempts", "connection"],
  ] as const)("classifies the provider's exact %s code as %s", (code, reason) => {
    expect(conversationRecoveryReason(code)).toBe(reason);
  });

  test.each([
    null,
    "unknown",
    "other",
    "api_error_500",
    "server_error",
    "transport_error",
    "Connection failed; retrying",
    "future_provider_error",
  ])("keeps an unclassified cause unknown: %s", (code) => {
    expect(conversationRecoveryReason(code)).toBe("unknown");
  });

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
    expect(codexConversationRecoveryReason(null)).toBe("unknown");
    expect(codexConversationRecoveryReason({})).toBe("unknown");
    expect(codexConversationRecoveryReason({ futureError: { httpStatusCode: null } })).toBe(
      "unknown",
    );
    expect(codexConversationRecoveryReason({ futureError: { httpStatusCode: 500 } })).toBe(
      "unknown",
    );
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
