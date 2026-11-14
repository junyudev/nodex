import { afterEach, expect, test, vi } from "vite-plus/test";
import { approvalsRefusedBySend, createAgentApprovalRuntime } from "./agent-approval-runtime";
import type { AgentPendingApproval } from "./agent-approval";

const approval: AgentPendingApproval = {
  requestId: "request",
  runId: null,
  kind: "permission",
  detail: "Read /private",
  reason: null,
  appName: null,
  options: [
    { decision: "accept", label: "Approve" },
    { decision: "decline", label: "Decline" },
  ],
  fullAccessOverride: null,
  live: true,
  supportsFeedback: true,
  createdAt: 0,
  autoDeclineAt: null,
};
afterEach(() => vi.useRealTimers());

test("tracks each response separately and releases its in-flight state after a failure", async () => {
  let reject!: (cause: unknown) => void;
  const deliver = vi.fn(
    () =>
      new Promise<void>((_, no) => {
        reject = no;
      }),
  );
  const runtime = createAgentApprovalRuntime(deliver);
  runtime.update({ pending: [approval], suppressedItemIds: new Set() });
  const response = runtime.respond("request", {
    decision: "decline",
    feedback: "Use the public file",
  });
  expect(runtime.getSnapshot().responding.has("request")).toBe(true);
  expect(deliver).toHaveBeenCalledWith(approval, {
    decision: "decline",
    feedback: "Use the public file",
  });
  await expect(runtime.respond("request", { decision: "accept" })).rejects.toThrow("already");
  reject(new Error("Offline"));
  await expect(response).rejects.toThrow("Offline");
  expect(runtime.getSnapshot().responding.size).toBe(0);
  runtime.clear();
});

test("typing extends a held arrival's deadline; idle, blur and send release it", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const runtime = createAgentApprovalRuntime(vi.fn(async () => {}));
  runtime.interact({ type: "focus" });
  runtime.interact({ type: "type", now: 100 });
  runtime.update({ pending: [approval], suppressedItemIds: new Set() });
  expect(runtime.getSnapshot().held.has("request")).toBe(true);
  await expect(runtime.respond("request", { decision: "accept" })).rejects.toThrow("cannot");
  vi.advanceTimersByTime(1400);
  runtime.interact({ type: "type", now: Date.now() });
  vi.advanceTimersByTime(1499);
  expect(runtime.getSnapshot().held.size).toBe(1);
  vi.advanceTimersByTime(1);
  expect(runtime.getSnapshot().held.size).toBe(0);
  await runtime.respond("request", { decision: "accept" });
  runtime.clear();
});

test("a Send refuses only approvals the person could see, not ones held while typing", () => {
  vi.useFakeTimers();
  const runtime = createAgentApprovalRuntime(async () => {});
  const seen = { ...approval, requestId: "seen" };
  runtime.update({ pending: [seen], suppressedItemIds: new Set() });
  runtime.interact({ type: "focus" });
  runtime.interact({ type: "type", now: Date.now() });
  const arrived = { ...approval, requestId: "arrived-while-typing" };
  runtime.update({ pending: [seen, arrived], suppressedItemIds: new Set() });
  expect(runtime.getSnapshot().held.has("arrived-while-typing")).toBe(true);
  expect(approvalsRefusedBySend(runtime.getSnapshot()).map((entry) => entry.requestId)).toEqual([
    "seen",
  ]);
  runtime.interact({ type: "send" });
  expect(runtime.getSnapshot().held.size).toBe(0);
  runtime.clear();
});
