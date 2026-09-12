import { expect, it } from "vitest";
import {
  INITIAL_CONVERSATION_RESUME_RETRY,
  conversationResumeTimeoutMs,
  nextConversationResumeRetry,
  conversationResumeRequestOptions,
} from "./codex-conversation-resume-retry";

const closing = "thread thread is closing; retry thread/resume after the thread is closed";

it.each([undefined, 0, 250_000])(
  "reconnect timeout retries stay with the recovery controller despite caller deadline %s",
  (callerDeadline) => {
    const options = conversationResumeRequestOptions(true, callerDeadline);
    expect(options).toEqual({ priority: "interactive", timeoutMs: 30_000 });
    expect(
      nextConversationResumeRetry(
        INITIAL_CONVERSATION_RESUME_RETRY,
        "thread",
        "Timeout",
        options.timeoutMs,
      ),
    ).toBeNull();
    expect(
      nextConversationResumeRetry(
        INITIAL_CONVERSATION_RESUME_RETRY,
        "thread",
        closing,
        options.timeoutMs,
      )?.delayMs,
    ).toBe(750);
  },
);

it("keeps closing and timeout retry budgets independent when failures alternate", () => {
  let state = INITIAL_CONVERSATION_RESUME_RETRY;
  const observed: number[][] = [];
  for (const error of [closing, "Timeout", closing, "Timeout", closing, closing]) {
    const next = nextConversationResumeRetry(state, "thread", error);
    if (!next) throw new Error("Expected another admitted resume attempt");
    state = next.state;
    observed.push([next.delayMs, conversationResumeTimeoutMs(state)]);
  }
  expect(observed).toEqual([
    [750, 120_000],
    [750, 240_000],
    [1500, 240_000],
    [750, 480_000],
    [3000, 480_000],
    [6000, 480_000],
  ]);
  expect(nextConversationResumeRetry(state, "thread", closing)).toBeNull();
  expect(nextConversationResumeRetry(state, "thread", "Timeout")).toBeNull();
});

it.each([0, 30_000])(
  "preserves an explicit %i ms deadline and only retries closing",
  (timeoutMs) => {
    expect(conversationResumeTimeoutMs(INITIAL_CONVERSATION_RESUME_RETRY, timeoutMs)).toBe(
      timeoutMs,
    );
    expect(
      nextConversationResumeRetry(
        INITIAL_CONVERSATION_RESUME_RETRY,
        "thread",
        "Timeout",
        timeoutMs,
      ),
    ).toBeNull();
    const next = nextConversationResumeRetry(
      INITIAL_CONVERSATION_RESUME_RETRY,
      "thread",
      closing,
      timeoutMs,
    )!;
    expect(next.delayMs).toBe(750);
    expect(conversationResumeTimeoutMs(next.state, timeoutMs)).toBe(timeoutMs);
  },
);

it.each([
  "request timed out",
  "timeout",
  "Host unavailable",
  "Canceled",
  "thread other is closing; retry thread/resume after the thread is closed",
])("does not retry a different failure: %s", (message) => {
  expect(
    nextConversationResumeRetry(INITIAL_CONVERSATION_RESUME_RETRY, "thread", message),
  ).toBeNull();
});
