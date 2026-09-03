import { describe, expect, it } from "vitest";
import {
  bucketRemoteHostedPipDuration,
  hashRemoteHostedPipTaskId,
  RemoteHostedPipDiagnostics,
} from "./RemoteHostedPipDiagnostics";

describe("RemoteHostedPipDiagnostics", () => {
  it("retains a bounded content-free ring", () => {
    const diagnostics = new RemoteHostedPipDiagnostics({
      capacity: 2,
      now: () => 42.8,
      salt: "profile-local-salt",
    });
    diagnostics.record({
      durationMs: 3,
      operation: "publish",
      result: "ok",
      revision: 1,
      source: "browser-use",
      taskId: "thread-with-private-content",
    });
    diagnostics.record({
      durationMs: 12,
      operation: "focus",
      result: "not-found",
      revision: 2,
      source: "chrome-control",
    });
    diagnostics.record({
      durationMs: 1_200,
      operation: "connect",
      result: "ready",
      revision: 3,
      source: "computer-use",
    });

    expect(diagnostics.snapshot()).toEqual([
      expect.objectContaining({ duration: "lt-100ms", sequence: 2 }),
      expect.objectContaining({ duration: "gte-1s", sequence: 3 }),
    ]);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("thread-with-private-content");
  });

  it("uses a profile-local salt and stable duration buckets", () => {
    expect(hashRemoteHostedPipTaskId("thread-1", "a")).not.toBe(
      hashRemoteHostedPipTaskId("thread-1", "b"),
    );
    expect([0, 1, 10, 100, 1_000].map(bucketRemoteHostedPipDuration)).toEqual([
      "lt-1ms",
      "lt-10ms",
      "lt-100ms",
      "lt-1s",
      "gte-1s",
    ]);
  });
});
