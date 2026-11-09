import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../test/browser-globals";
import {
  archiveAutomationRun,
  createAutomation,
  deleteAutomation,
  publishCodexHeartbeatEnabled,
  publishCodexHeartbeatThreadState,
  runAutomationNow,
  setAutomationRunReadState,
  unarchiveAutomationRun,
  updateAutomation,
} from "./automations-runtime";

const invoke = vi.fn(async (channel: string) => {
  if (channel === "automations:create") {
    return { item: { id: "automation-created" } };
  }
  if (channel === "automations:update") {
    return { item: { id: "automation-updated" } };
  }
  if (channel === "automations:delete") {
    return { item: null, success: true, status: "deleted" };
  }
  if (channel === "automations:runs:set-read-state") return null;
  return { success: true };
});

beforeEach(() => {
  invoke.mockClear();
  installWindowApi({ invoke, on: () => () => undefined });
});

describe("Codex automation runtime", () => {
  test("returns complete automation mutation values without claiming LocalCommit evidence", async () => {
    const created = await createAutomation({ kind: "cron", name: "Daily notes" });
    const updated = await updateAutomation({
      id: "automation-created",
      kind: "cron",
      name: "Daily summary",
      status: "ACTIVE",
    });
    const deleted = await deleteAutomation({ id: "automation-created" });

    expect(created.item.id).toBe("automation-created");
    expect(updated.item.id).toBe("automation-updated");
    expect(deleted).toMatchObject({ success: true, status: "deleted" });
    expect(invoke.mock.calls).toEqual([
      ["automations:create", { kind: "cron", name: "Daily notes" }],
      [
        "automations:update",
        {
          id: "automation-created",
          kind: "cron",
          name: "Daily summary",
          status: "ACTIVE",
        },
      ],
      ["automations:delete", { id: "automation-created" }],
    ]);
  });

  test("separates run submission, inbox mutations, and heartbeat bookkeeping", async () => {
    await runAutomationNow({ id: "automation-1" });
    await archiveAutomationRun({ runId: "thread-1", archivedReason: "manual" });
    await unarchiveAutomationRun({ runId: "thread-1" });
    await setAutomationRunReadState({ runId: "thread-1", readAt: 42 });
    await publishCodexHeartbeatEnabled({ enabled: true });
    await publishCodexHeartbeatThreadState({
      sessionId: "session-1",
      streamRole: "owner",
      isEligible: true,
    });

    expect(invoke.mock.calls).toEqual([
      ["automations:run-now", { id: "automation-1" }],
      ["automations:runs:archive", { runId: "thread-1", archivedReason: "manual" }],
      ["automations:runs:unarchive", { runId: "thread-1" }],
      ["automations:runs:set-read-state", { runId: "thread-1", readAt: 42 }],
      ["automations:heartbeat-enabled-changed", { enabled: true }],
      [
        "automations:heartbeat-thread-state-changed",
        { sessionId: "session-1", streamRole: "owner", isEligible: true },
      ],
    ]);
  });
});
