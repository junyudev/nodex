import { describe, expect, it } from "vite-plus/test";
import {
  GIT_WORKER_PROTOCOL_VERSION,
  isGitWorkerMessageForView,
  isGitWorkerMessageFromHost,
  isGitWorkerMessageFromThread,
  isGitWorkerMessageFromView,
} from "./git-worker-protocol";

describe("Git worker protocol", () => {
  it("requires a nullable origin URL in stable repository metadata", () => {
    const metadata = {
      cwd: "/repo",
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      isGitRepository: true,
      currentBranch: "main",
      defaultBranch: "main",
      originUrl: null,
      errorMessage: null,
    };
    const response = (value: unknown) => ({
      type: "worker-response",
      workerId: "git",
      id: "metadata",
      method: "stable-metadata",
      result: { type: "ok", value },
    });
    for (const originUrl of [null, "git@github.com:example/project.git"])
      expect(isGitWorkerMessageForView(response({ ...metadata, originUrl }))).toBe(true);
    for (const originUrl of [undefined, 42, {}])
      expect(isGitWorkerMessageForView(response({ ...metadata, originUrl }))).toBe(false);
  });
  it("accepts bounded typed request, response, and lifecycle envelopes", () => {
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-1",
          method: "probe",
          params: { nonce: "hello" },
          enqueuedAtMs: 42,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-push",
          method: "push",
          params: { cwd: "/repo", force: true },
          enqueuedAtMs: 45,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-3",
          method: "review-diff",
          params: {
            cwd: "/repo",
            source: "unstaged",
            snapshotGeneration: 3,
            files: [{ path: "file.ts", status: "modified" }],
          },
          enqueuedAtMs: 44,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromHost({
        type: "worker-shutdown",
        workerId: "git",
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-2",
          method: "status-summary",
          params: { cwd: "/repo" },
          enqueuedAtMs: 43,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromThread({
        type: "worker-ready",
        workerId: "git",
        epoch: 1,
        protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageForView({
        type: "worker-response",
        workerId: "git",
        id: "request-1",
        method: "probe",
        result: {
          type: "ok",
          value: {
            nonce: "hello",
            protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
          },
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageForView({
        type: "git-live-query-event",
        workerId: "git",
        event: {
          type: "git-live-query-updated",
          subscriptionId: "subscription-1",
          generation: 1,
          requiresRecovery: false,
          phase: "complete",
          method: "base-branch",
          result: {
            cwd: "/repo",
            local: "main",
            remote: "origin/main",
            errorMessage: null,
          },
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageForView({
        type: "worker-response",
        workerId: "git",
        id: "request-2",
        method: "status-summary",
        result: {
          type: "ok",
          value: {
            type: "success",
            stagedCount: 1,
            unstagedCount: 2,
            untrackedCount: null,
            snapshotGeneration: 3,
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed, oversized, and version-skewed envelopes", () => {
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-1",
          method: "probe",
          params: { nonce: "" },
          enqueuedAtMs: 42,
        },
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request-cancel",
        workerId: "git",
        id: "x".repeat(257),
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageFromThread({
        type: "worker-ready",
        workerId: "git",
        epoch: 1,
        protocolVersion: GIT_WORKER_PROTOCOL_VERSION + 1,
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageForView({
        type: "worker-restarted",
        workerId: "git",
        epoch: 1,
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-3",
          method: "review-diff",
          params: {
            cwd: "/repo",
            source: "unstaged",
            snapshotGeneration: 3,
            files: Array.from({ length: 513 }, () => ({
              path: "file.ts",
              status: "modified",
            })),
          },
          enqueuedAtMs: 44,
        },
      }),
    ).toBe(false);
  });
});
