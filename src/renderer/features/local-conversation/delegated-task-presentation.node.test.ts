import { describe, expect, test } from "vite-plus/test";
import {
  delegatedTaskGroupStatusLabel,
  resolveDelegatedTaskRowStatus,
} from "./delegated-task-presentation";

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
    expect(resolveDelegatedTaskRowStatus("running", true)).toBe("stopping");
    expect(resolveDelegatedTaskRowStatus("waiting", true)).toBe("stopping");
    expect(resolveDelegatedTaskRowStatus("failed", true)).toBe("failed");
    expect(resolveDelegatedTaskRowStatus("stopped", true)).toBe("stopped");
  });
});
