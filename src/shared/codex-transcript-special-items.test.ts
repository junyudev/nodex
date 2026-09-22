import { describe, expect, test } from "vite-plus/test";
import {
  buildAutomaticApprovalReviewActionSummary,
  buildAutomaticApprovalReviewSummary,
  buildAutomaticApprovalReviewTitle,
  normalizeAutomaticApprovalReviewPayload,
  normalizeMultiAgentActionPayload,
  shouldShowAutoReviewInterruptionWarning,
} from "./codex-transcript-special-items";

describe("codex-transcript-special-items", () => {
  test("normalizes automatic approval review payloads from nested review records", () => {
    const payload = normalizeAutomaticApprovalReviewPayload(
      {
        review: {
          status: "approved",
          riskScore: 0.25,
          riskLevel: "low",
          rationale: "Looks safe",
        },
      },
      "item_123",
    );

    expect(payload).toEqual({
      targetItemId: "item_123",
      status: "approved",
      riskScore: 0.25,
      riskLevel: "low",
      userAuthorization: null,
      rationale: "Looks safe",
      action: null,
    });
  });

  test("normalizes current guardian review protocol fields", () => {
    const payload = normalizeAutomaticApprovalReviewPayload({
      targetItemId: null,
      review: {
        status: "timedOut",
        riskLevel: "critical",
        userAuthorization: "high",
        rationale: null,
      },
      action: {
        type: "requestPermissions",
      },
    });

    expect(payload).toEqual({
      targetItemId: null,
      status: "timedOut",
      riskScore: null,
      riskLevel: "critical",
      userAuthorization: "high",
      rationale: null,
      action: {
        type: "requestPermissions",
      },
    });
  });

  test("matches auto-review interruption guardian warnings by message prefix", () => {
    expect(
      shouldShowAutoReviewInterruptionWarning({
        threadId: "thread-1",
        message: "Automatic approval review rejected too many approval requests for this turn.",
      }),
    ).toBe(true);
    expect(
      shouldShowAutoReviewInterruptionWarning({
        threadId: "thread-1",
        message: "Different guardian warning",
      }),
    ).toBe(false);
  });

  test("formats automatic approval review title and fallback detail like the thread row", () => {
    expect(buildAutomaticApprovalReviewTitle({ status: "inProgress", riskLevel: null })).toBe(
      "Auto-reviewing",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "approved", riskLevel: "low" })).toBe(
      "Auto-review approved",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "denied", riskLevel: "high" })).toBe(
      "Auto-review denied high risk",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "denied", riskLevel: "medium" })).toBe(
      "Auto-review denied",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "timedOut", riskLevel: null })).toBe(
      "Auto-review timed out",
    );
    expect(buildAutomaticApprovalReviewTitle({ status: "aborted", riskLevel: null })).toBe(
      "Auto-review stopped",
    );

    expect(buildAutomaticApprovalReviewSummary({ status: "timedOut", rationale: null })).toBe(
      "A carefully prompted reviewer agent timed out before Nodex ran this request",
    );
  });

  test("formats automatic approval review action summaries from guardian protocol actions", () => {
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "command",
        command: "bun test",
        source: "shell",
        cwd: "/tmp/project",
      }),
    ).toBe("bun test");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "execve",
        program: "python",
        argv: ["-m", "pytest"],
        source: "shell",
        cwd: "/tmp/project",
      }),
    ).toBe("python -m pytest");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "applyPatch",
        cwd: "/tmp/project",
        files: ["src/app.ts"],
      }),
    ).toBe("Editing src/app.ts");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "applyPatch",
        cwd: "/tmp/project",
        files: ["src/app.ts", "src/app.test.ts"],
      }),
    ).toBe("Editing 2 files");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "networkAccess",
        target: "api.openai.com",
        host: "api.openai.com",
        protocol: "https",
        port: 443,
      }),
    ).toBe("Network access to api.openai.com");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "mcpToolCall",
        server: "docs",
        toolName: "search",
        connectorId: null,
        connectorName: "Docs",
        toolTitle: null,
      }),
    ).toBe("MCP search on Docs");
    expect(
      buildAutomaticApprovalReviewActionSummary({
        type: "requestPermissions",
        reason: "Need to edit generated assets",
        permissions: "fullAccess",
      }),
    ).toBe("Permission request: Need to edit generated assets");
    expect(buildAutomaticApprovalReviewActionSummary(null)).toBe("Request");
  });

  test("filters invalid receiver threads and agent states in multi-agent action payloads", () => {
    const payload = normalizeMultiAgentActionPayload({
      tool: "sendInput",
      status: "completed",
      receiverThreadIds: ["thr_a", 42, "thr_b"],
      receiverThreads: [
        {
          threadId: "thr_a",
          thread: {
            nickname: "Scout",
            model: "gpt-5",
            agentRole: "explorer",
          },
        },
        {
          threadId: 7,
          thread: {
            nickname: "Broken",
          },
        },
      ],
      agentsStates: {
        thr_a: {
          status: "running",
          message: "Working",
        },
        thr_b: {
          status: "mystery",
          message: "Bad",
        },
      },
    });

    expect(payload).toEqual({
      id: null,
      action: "sendInput",
      status: "completed",
      senderThreadId: null,
      receiverThreadIds: ["thr_a", "thr_b"],
      receiverThreads: [
        {
          threadId: "thr_a",
          thread: {
            nickname: "Scout",
            model: "gpt-5",
            agentRole: "explorer",
          },
        },
      ],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {
        thr_a: {
          status: "running",
          message: "Working",
        },
      },
    });
  });

  test("normalizes subagent receiver display metadata aliases", () => {
    const payload = normalizeMultiAgentActionPayload({
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["thr_euclid", "thr_named", "thr_source"],
      receiverThreads: [
        {
          threadId: "thr_euclid",
          thread: {
            agentNickname: "@Euclid",
            model: "gpt-5-codex",
            agentRole: "explorer",
          },
        },
        {
          threadId: "thr_named",
          thread: {
            name: "Proof Writer",
            model: null,
            agentRole: "worker",
          },
        },
        {
          threadId: "thr_source",
          thread: {
            model: "gpt-5-codex",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "thr_parent",
                  agent_nickname: "@Nash",
                  agent_role: "reviewer",
                },
              },
            },
          },
        },
      ],
      agentsStates: {},
    });

    expect(payload?.receiverThreads[0]?.thread?.nickname).toBe("@Euclid");
    expect(payload?.receiverThreads[1]?.thread?.nickname).toBeNull();
    expect(payload?.receiverThreads[1]?.thread?.name).toBe("Proof Writer");
    expect(payload?.receiverThreads[2]?.thread?.nickname).toBe("@Nash");
    expect(payload?.receiverThreads[2]?.thread?.agentRole).toBe("reviewer");
  });
});
