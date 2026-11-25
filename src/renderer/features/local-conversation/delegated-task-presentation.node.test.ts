import { describe, expect, test } from "vite-plus/test";
import {
  delegatedTaskGroupStatusLabel,
  delegatedTaskRecoveryLabel,
  resolveDelegatedTaskRowStatus,
} from "./delegated-task-presentation";
import type { CodexConversationChildMembership } from "../../../shared/types";
import { projectNativeTaskRows } from "./native-task-presentation";

describe("delegated task status sentences", () => {
  test("distinguishes live, stopped, cancelled, failed and completed groups", () => {
    expect(delegatedTaskGroupStatusLabel(["running"])).toBe("is working");
    expect(delegatedTaskGroupStatusLabel(["running", "running"])).toBe("are working");
    expect(delegatedTaskGroupStatusLabel(["waiting"])).toBe("is waiting");
    expect(delegatedTaskGroupStatusLabel(["stopping"])).toBe("is stopping…");
    expect(delegatedTaskGroupStatusLabel(["stopped"])).toBe("stopped");
    expect(delegatedTaskGroupStatusLabel(["cancelled"])).toBe("was cancelled");
    expect(delegatedTaskGroupStatusLabel(["failed"])).toBe("failed");
    expect(delegatedTaskGroupStatusLabel(["completed"])).toBe("finished");
    expect(delegatedTaskGroupStatusLabel([])).toBe("");
  });

  test("mixed groups keep each outcome and prioritize problems ahead of completed counts", () => {
    expect(
      delegatedTaskGroupStatusLabel([
        "completed",
        "running",
        "completed",
        "failed",
        "stopping",
        "waiting",
        "stopped",
        "cancelled",
      ]),
    ).toBe("— 1 failed · 1 stopping… · 1 waiting · 1 working · 1 cancelled · 1 stopped · 2 done");
  });

  test("only unsettled live work can still be stopping", () => {
    expect(resolveDelegatedTaskRowStatus({ status: "running" }, true)).toBe("stopping");
    expect(resolveDelegatedTaskRowStatus({ status: "waiting" }, true)).toBe("stopping");
    expect(resolveDelegatedTaskRowStatus({ status: "failed" }, true)).toBe("failed");
    expect(resolveDelegatedTaskRowStatus({ status: "stopped" }, true)).toBe("stopped");
  });

  test("a running task recovering from a provider failure is retrying, not working or failed", () => {
    const recovery = {
      state: "retrying" as const,
      reason: "overloaded" as const,
      attempt: 2,
      maxAttempts: 4,
      retryAt: 120_000,
      updatedAt: 0,
    };
    expect(resolveDelegatedTaskRowStatus({ status: "running", recovery }, false)).toBe("retrying");
    expect(resolveDelegatedTaskRowStatus({ status: "running", recovery }, true)).toBe("stopping");
    expect(resolveDelegatedTaskRowStatus({ status: "failed", recovery }, false)).toBe("failed");
    expect(delegatedTaskGroupStatusLabel(["retrying", "retrying"])).toBe("are retrying");
    expect(delegatedTaskGroupStatusLabel(["retrying", "running"])).toBe("— 1 retrying · 1 working");
    expect(delegatedTaskRecoveryLabel(recovery, 0)).toBe("Service is busy · Retrying in 2m · 2/4");
    expect(
      delegatedTaskRecoveryLabel(
        { ...recovery, reason: "connection", maxAttempts: null, retryAt: 20_000 },
        0,
      ),
    ).toBe("Reconnecting · Retrying in 20s · Attempt 2");
  });
});

describe("native task presentation", () => {
  const child: CodexConversationChildMembership = {
    threadId: "durable-child",
    parentThreadId: "parent",
    role: "backgroundChild",
    displayName: "Review",
    statusType: "active",
  };

  describe("task summary identity", () => {
    test("preserves a child's identity when its name and status change", () => {
      const initial = projectNativeTaskRows([child], () => null)[0];
      const completed = projectNativeTaskRows(
        [{ ...child, displayName: "Final review", statusType: "idle" }],
        () => null,
      )[0];
      expect(initial?.identityThreadId).toBe("durable-child");
      expect(completed).toMatchObject({
        identityThreadId: initial?.identityThreadId,
        displayName: "Final review",
        status: "done",
      });
    });

    test("does not use a task observation key as a child avatar identity", () => {
      const [observed] = projectNativeTaskRows(
        [
          {
            ...child,
            threadId: "observation-key",
            task: { id: "task", bornTurnSequence: null, description: "Review", status: "running" },
          },
        ],
        () => null,
      );
      expect(observed).toMatchObject({
        conversationId: "observation-key",
        identityThreadId: null,
        canInteract: false,
      });
    });
  });
});
