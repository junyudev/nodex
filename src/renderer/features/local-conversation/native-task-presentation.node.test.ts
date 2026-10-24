import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationChildMembership } from "../../../shared/types";
import { projectNativeTaskRows } from "./native-task-presentation";

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
