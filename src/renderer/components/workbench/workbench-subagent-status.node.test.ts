import { describe, expect, test } from "vite-plus/test";
import {
  projectSubagentOverviewRowToOpenPayload,
  projectThreadStatusToSubagentOpenStatus,
} from "./workbench-subagent-status";

describe("workbench Subagent status projection", () => {
  test.each([
    ["active", "active"],
    ["idle", "done"],
    ["notLoaded", "unknown"],
    ["systemError", "unknown"],
    [undefined, "unknown"],
  ] as const)("projects %s without fabricating lifecycle evidence", (status, expected) => {
    expect(projectThreadStatusToSubagentOpenStatus(status)).toBe(expected);
  });

  test("preserves unknown overview evidence when opening a child", () => {
    const payload = projectSubagentOverviewRowToOpenPayload({
      agentRole: null,
      canInteract: false,
      diffStats: null,
      displayName: "Agent",
      objective: "Inspect the runtime",
      spawnModel: null,
      status: "unknown",
      statusSummary: null,
      threadId: "thread:child",
    });

    expect(payload).toMatchObject({
      conversationId: "thread:child",
      status: "unknown",
      statusSummary: "Inspect the runtime",
    });
  });
});
