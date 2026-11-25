import { expect, test } from "vitest";
import {
  MANAGED_CHAT_STALL_MS,
  observeManagedChat,
  unavailableManagedChatFacts,
  type ManagedChatFacts,
} from "./managed-chat-observation";

const working: ManagedChatFacts = {
  state: "working",
  runId: "run",
  runStartedAt: 0,
  terminalStatus: null,
  pendingRequests: [],
  progressFingerprint: "progress",
};

test("keeps a bounded Unicode reply through unavailability and clears it on a newer Run", () => {
  const quiet = observeManagedChat({
    previous: null,
    facts: {
      ...working,
      state: "idle",
      terminalStatus: "completed",
      lastReplyExcerpt: `  ${"🌱".repeat(401)}  `,
    },
    now: 0,
  });
  expect(quiet.lastReplyExcerpt).toBe("🌱".repeat(400));
  expect(
    observeManagedChat({ previous: quiet, facts: unavailableManagedChatFacts, now: 1 }),
  ).toEqual(quiet);
  const next = observeManagedChat({
    previous: quiet,
    facts: { ...working, runId: "next" },
    now: 2,
  });
  expect(next.lastReplyExcerpt).toBeUndefined();
});

test("keeps the stall clock only while the same Run makes no progress", () => {
  const previous = observeManagedChat({ previous: null, facts: working, now: 0 });
  expect(
    observeManagedChat({ previous, facts: working, now: MANAGED_CHAT_STALL_MS - 1 }).stalled,
  ).toBe(false);
  expect(observeManagedChat({ previous, facts: working, now: MANAGED_CHAT_STALL_MS }).stalled).toBe(
    true,
  );
  const resumed = observeManagedChat({
    previous,
    facts: working,
    now: MANAGED_CHAT_STALL_MS,
    restartStallClock: true,
  });
  expect(resumed).toMatchObject({ stalled: false, progressSince: MANAGED_CHAT_STALL_MS });
});
