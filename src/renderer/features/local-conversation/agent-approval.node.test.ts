import { afterEach, expect, test, vi, describe, it } from "vite-plus/test";
import { approvalsRefusedBySend, createAgentApprovalRuntime } from "./agent-approval-runtime";
import {
  type AgentPendingApproval,
  agentApprovalComposerPlaceholder,
  agentApprovalWaitingStatus,
  planAgentApprovalDeclineOnSend,
  resolveAgentApprovalOptions,
  splitAgentApprovalOptions,
} from "./agent-approval";

describe("agent approval runtime", () => {
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
});

describe("agent approval", () => {
  function approval(overrides: Partial<AgentPendingApproval> = {}): AgentPendingApproval {
    return {
      requestId: "request-1",
      runId: "run-1",
      kind: "command",
      detail: "pnpm install",
      reason: null,
      appName: null,
      options: resolveAgentApprovalOptions(null),
      fullAccessOverride: null,
      live: true,
      supportsFeedback: false,
      createdAt: 0,
      autoDeclineAt: null,
      ...overrides,
    };
  }

  describe("approval options", () => {
    it("offers every decision when the provider advertises none", () => {
      expect(resolveAgentApprovalOptions([]).map((option) => option.decision)).toEqual([
        "accept",
        "decline",
        "acceptForSession",
        "cancel",
      ]);
    });

    it("keeps only the provider's choices without duplicates, named the same for every Agent", () => {
      const options = resolveAgentApprovalOptions([
        { decision: "decline", label: "No" },
        { decision: "accept", label: "Approve once", warning: "Untrusted source" },
        { decision: "decline", label: "Duplicate" },
        {
          decision: "acceptForSession",
          label: "Allow curl https://uploads.example/* this session",
        },
      ]);
      expect(options).toEqual([
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Approve", warning: "Untrusted source" },
        // The session allowance names exactly what it allows.
        {
          decision: "acceptForSession",
          label: "Allow curl https://uploads.example/* this session",
        },
      ]);
    });

    it("keeps distinct native scopes of the same decision", () => {
      const options = resolveAgentApprovalOptions([
        { decision: "acceptForSession", label: "Always allow in this folder", optionId: "folder" },
        { decision: "acceptForSession", label: "Always allow everywhere", optionId: "global" },
      ]);
      expect(options.map((option) => [option.optionId, option.label])).toEqual([
        ["folder", "Always allow in this folder"],
        ["global", "Always allow everywhere"],
      ]);
    });

    it("puts Decline then Approve inline and the rest behind More", () => {
      const { primary, more } = splitAgentApprovalOptions(resolveAgentApprovalOptions(null));
      expect(primary.map((option) => option.decision)).toEqual(["decline", "accept"]);
      expect(more.map((option) => option.decision)).toEqual(["acceptForSession", "cancel"]);
    });

    it("shows Decline and stop inline when the provider offers no plain decline", () => {
      const { primary, more } = splitAgentApprovalOptions(
        resolveAgentApprovalOptions([
          { decision: "accept", label: "Approve once" },
          { decision: "cancel", label: "Cancel" },
        ]),
      );
      expect(primary.map((option) => option.label)).toEqual(["Decline and stop", "Approve"]);
      expect(more).toEqual([]);
    });
  });

  describe("an approval that declines itself when unanswered", () => {
    it("names the deadline in whole minutes and changes only when the wording does", () => {
      expect(agentApprovalWaitingStatus(null, 0)).toEqual({
        label: "Waiting for approval",
        nextChangeAt: null,
      });
      expect(agentApprovalWaitingStatus(120_000, 0)).toEqual({
        label: "Waiting for approval · declines in 2 min",
        nextChangeAt: 60_000,
      });
      expect(agentApprovalWaitingStatus(120_000, 60_000)).toEqual({
        label: "Waiting for approval · declines in under a minute",
        nextChangeAt: 120_000,
      });
      expect(agentApprovalWaitingStatus(120_000, 120_000)).toEqual({
        label: "No answer, declining",
        nextChangeAt: null,
      });
    });
  });

  describe("sending while approvals wait", () => {
    it("has no approval placeholder when nothing can be answered", () => {
      expect(agentApprovalComposerPlaceholder([approval({ live: false })])).toBeNull();
    });

    it("delivers the message as feedback to a single feedback-capable approval", () => {
      const plan = planAgentApprovalDeclineOnSend(
        [approval({ supportsFeedback: true })],
        "  use npm instead ",
      );
      expect(plan).toEqual({
        responses: [
          {
            requestId: "request-1",
            response: { decision: "decline", feedback: "use npm instead" },
          },
        ],
        steerMessage: null,
        steer: true,
      });
    });

    it("stops the turn and sends the message as a new turn when only Decline and stop is offered", () => {
      const plan = planAgentApprovalDeclineOnSend(
        [
          approval({
            supportsFeedback: true,
            options: resolveAgentApprovalOptions([
              { decision: "accept", label: "Approve once" },
              { decision: "cancel", label: "Cancel" },
            ]),
          }),
        ],
        "skip it",
      );
      expect(plan).toEqual({
        responses: [{ requestId: "request-1", response: { decision: "cancel" } }],
        steerMessage: "skip it",
        steer: false,
      });
    });

    it("declines every answerable approval and steers with the message otherwise", () => {
      const plan = planAgentApprovalDeclineOnSend(
        [
          approval({ requestId: "a", supportsFeedback: true }),
          approval({ requestId: "b" }),
          approval({ requestId: "gone", live: false }),
        ],
        "try another way",
      );
      expect(plan.responses).toEqual([
        { requestId: "a", response: { decision: "decline" } },
        { requestId: "b", response: { decision: "decline" } },
      ]);
      expect(plan.steerMessage).toBe("try another way");
    });

    it("declines without a steer when the message is empty", () => {
      const plan = planAgentApprovalDeclineOnSend([approval({ supportsFeedback: true })], "   ");
      expect(plan).toEqual({
        responses: [{ requestId: "request-1", response: { decision: "decline" } }],
        steerMessage: null,
        steer: true,
      });
    });
  });
});
