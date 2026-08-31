import { describe, expect, it } from "vitest";
import { selectCodexRendererOwnerRetentionOverflow } from "./CodexRendererOwnerRetention";

const candidate = (conversationId: string, candidateSince: number, approximateBytes: number) => ({
  conversationId,
  candidateSince,
  generation: candidateSince,
  approximateBytes,
});

describe("selectCodexRendererOwnerRetentionOverflow", () => {
  it("evicts the oldest inactive owners until the count budget is satisfied", () => {
    const result = selectCodexRendererOwnerRetentionOverflow({
      candidates: [
        candidate("thread-newest", 3, 1),
        candidate("thread-oldest", 1, 1),
        candidate("thread-middle", 2, 1),
      ],
      maxRetained: 2,
      maxRetainedApproximateBytes: 100,
    });

    expect(result).toEqual([
      {
        conversationId: "thread-oldest",
        generation: 1,
        reason: "inactive-owner-retained-limit",
      },
    ]);
  });

  it("enforces aggregate byte pressure even below the owner-count limit", () => {
    const mib = 1024 * 1024;
    const result = selectCodexRendererOwnerRetentionOverflow({
      candidates: [
        candidate("thread-oldest", 1, 16 * mib),
        candidate("thread-middle", 2, 12 * mib),
        candidate("thread-newest", 3, 8 * mib),
      ],
      maxRetained: 4,
      maxRetainedApproximateBytes: 24 * mib,
    });

    expect(result).toEqual([
      {
        conversationId: "thread-oldest",
        generation: 1,
        reason: "inactive-owner-retained-byte-limit",
      },
    ]);
  });

  it("can release every passive owner when one candidate alone exceeds the byte budget", () => {
    expect(
      selectCodexRendererOwnerRetentionOverflow({
        candidates: [candidate("thread-huge", 1, 33)],
        maxRetained: 4,
        maxRetainedApproximateBytes: 32,
      }),
    ).toEqual([
      {
        conversationId: "thread-huge",
        generation: 1,
        reason: "inactive-owner-retained-byte-limit",
      },
    ]);
  });

  it("uses stable identity ordering for equal-age candidates and applies both budgets", () => {
    expect(
      selectCodexRendererOwnerRetentionOverflow({
        candidates: [candidate("thread-b", 1, 8), candidate("thread-a", 1, 8)],
        maxRetained: 1,
        maxRetainedApproximateBytes: 8,
      }),
    ).toEqual([
      {
        conversationId: "thread-a",
        generation: 1,
        reason: "inactive-owner-retained-limit",
      },
    ]);
  });
});
