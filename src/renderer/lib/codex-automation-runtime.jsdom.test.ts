import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../test/browser-globals";
import {
  archiveCodexAutomationRun,
  createCodexScheduledAutomation,
  deleteCodexScheduledAutomation,
  publishCodexHeartbeatEnabled,
  publishCodexHeartbeatThreadState,
  runCodexScheduledAutomationNow,
  setCodexAutomationRunReadState,
  unarchiveCodexAutomationRun,
  updateCodexScheduledAutomation,
} from "./codex-automation-runtime";

const invoke = vi.fn(async (channel: string) => {
  if (channel === "codex:scheduled-automations:create") {
    return { item: { id: "automation-created" } };
  }
  if (channel === "codex:scheduled-automations:update") {
    return { item: { id: "automation-updated" } };
  }
  if (channel === "codex:scheduled-automations:delete") {
    return { item: null, success: true, status: "deleted" };
  }
  if (channel === "codex:automation-runs:set-read-state") return null;
  return { success: true };
});

beforeEach(() => {
  invoke.mockClear();
  installWindowApi({ invoke, on: () => () => undefined });
});

describe("Codex automation runtime", () => {
  test("returns complete automation mutation values without claiming LocalCommit evidence", async () => {
    const created = await createCodexScheduledAutomation({ kind: "cron", name: "Daily notes" });
    const updated = await updateCodexScheduledAutomation({
      id: "automation-created",
      kind: "cron",
      name: "Daily summary",
      status: "ACTIVE",
    });
    const deleted = await deleteCodexScheduledAutomation({ id: "automation-created" });

    expect(created.item.id).toBe("automation-created");
    expect(updated.item.id).toBe("automation-updated");
    expect(deleted).toMatchObject({ success: true, status: "deleted" });
    expect(invoke.mock.calls).toEqual([
      ["codex:scheduled-automations:create", { kind: "cron", name: "Daily notes" }],
      [
        "codex:scheduled-automations:update",
        {
          id: "automation-created",
          kind: "cron",
          name: "Daily summary",
          status: "ACTIVE",
        },
      ],
      ["codex:scheduled-automations:delete", { id: "automation-created" }],
    ]);
  });

  test("separates run submission, inbox mutations, and heartbeat bookkeeping", async () => {
    await runCodexScheduledAutomationNow({ id: "automation-1" });
    await archiveCodexAutomationRun({ threadId: "thread-1", archivedReason: "manual" });
    await unarchiveCodexAutomationRun({ threadId: "thread-1" });
    await setCodexAutomationRunReadState({ threadId: "thread-1", readAt: 42 });
    await publishCodexHeartbeatEnabled({ enabled: true });
    await publishCodexHeartbeatThreadState({
      threadId: "thread-1",
      streamRole: "owner",
      isEligible: true,
    });

    expect(invoke.mock.calls).toEqual([
      ["codex:scheduled-automations:run-now", { id: "automation-1" }],
      ["codex:automation-runs:archive", { threadId: "thread-1", archivedReason: "manual" }],
      ["codex:automation-runs:unarchive", { threadId: "thread-1" }],
      ["codex:automation-runs:set-read-state", { threadId: "thread-1", readAt: 42 }],
      ["codex:scheduled-automations:heartbeat-enabled-changed", { enabled: true }],
      [
        "codex:scheduled-automations:heartbeat-thread-state-changed",
        { threadId: "thread-1", streamRole: "owner", isEligible: true },
      ],
    ]);
  });
});
