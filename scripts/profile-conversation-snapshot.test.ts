import { expect, test } from "vite-plus/test";
import { parseProfileConversationSnapshot } from "./profile-conversation-snapshot";

const receipt = {
  version: 1,
  captureStartedAt: "2026-09-22T00:00:00Z",
  captureCompletedAt: "2026-09-22T00:00:01Z",
  requiredThreadCount: 2,
  capturedThreadCount: 1,
  externalThreadCount: 3,
  missingThreadIds: ["missing-thread"],
  rolloutCount: 4,
  nativeStateSchema: "state_5",
  contentSha256: "a".repeat(64),
};

test("preserves explicit incomplete coverage and rejects contradictory receipts", () => {
  expect(parseProfileConversationSnapshot(receipt)).toEqual(receipt);
  for (const invalid of [
    { capturedThreadCount: 2 },
    { requiredThreadCount: -1 },
    { missingThreadIds: ["duplicate", "duplicate"] },
    { captureCompletedAt: "2026-09-21T00:00:00Z" },
    { contentSha256: "incomplete" },
    { nativeStateSchema: "state_6" },
  ])
    expect(() => parseProfileConversationSnapshot({ ...receipt, ...invalid })).toThrow(
      "invalid or unsupported",
    );
});

test("requires recreation of Store-only development snapshots", () => {
  expect(() => parseProfileConversationSnapshot(undefined)).toThrow("Create a new --home");
});
