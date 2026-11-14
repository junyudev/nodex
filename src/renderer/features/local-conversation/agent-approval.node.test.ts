import { describe, expect, it } from "vite-plus/test";
import {
  agentApprovalComposerPlaceholder,
  agentApprovalWaitingStatus,
  planAgentApprovalDeclineOnSend,
  resolveAgentApprovalOptions,
  splitAgentApprovalOptions,
  type AgentPendingApproval,
} from "./agent-approval";

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
      { decision: "acceptForSession", label: "Allow curl https://uploads.example/* this session" },
    ]);
    expect(options).toEqual([
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve", warning: "Untrusted source" },
      // The session allowance names exactly what it allows.
      { decision: "acceptForSession", label: "Allow curl https://uploads.example/* this session" },
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
