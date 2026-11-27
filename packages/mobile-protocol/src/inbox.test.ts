import { describe, expect, it } from "vite-plus/test";
import {
  AgentCatalogSchema,
  ChatItemSchema,
  InboxDecisionSchema,
  InboxEntrySchema,
  InboxProposalSchema,
} from "./models";

const common = {
  id: "row",
  pageId: "page",
  pageKey: null,
  title: "Work",
  titleProvisional: false,
  body: "Choose a scope",
  bodyTruncated: false,
  submittedAt: "2026-11-06T12:00:00Z",
  source: { kind: "user", label: null },
  scope: { kind: "all" },
  revision: 1,
};

describe("mixed Member Inbox wire", () => {
  it("keeps Page Turns and non-Page Problems distinct", () => {
    const turn = InboxEntrySchema.parse({
      ...common,
      rowKind: "turn",
      snooze: null,
      turn: {
        episode: "episode",
        reason: "question",
        since: common.submittedAt,
        options: ["Project", "Library"],
        chatSessionId: "chat",
        pullRequestUrl: null,
        deliveryError: null,
        replyCapability: { kind: "available" },
      },
    });
    expect(turn.rowKind).toBe("turn");
    const problem = InboxEntrySchema.parse({
      ...common,
      id: "problem",
      pageId: null,
      rowKind: "problem",
      problem: {
        id: "problem",
        fix: "reconnect",
        sourceId: "github",
        capability: { kind: "unavailable", reason: "Reconnect in desktop Settings." },
      },
    });
    expect(problem.pageId).toBeNull();
    expect(InboxEntrySchema.safeParse({ ...common, rowKind: "turn" }).success).toBe(false);
    expect(InboxEntrySchema.safeParse({ ...common, rowKind: "problem" }).success).toBe(false);
  });

  it("requires the episode and exact Problem fix for person actions", () => {
    expect(InboxDecisionSchema.safeParse({ type: "turn_accept" }).success).toBe(false);
    expect(
      InboxDecisionSchema.safeParse({ type: "turn_reply", episode: "episode", text: " " }).success,
    ).toBe(false);
    expect(
      InboxDecisionSchema.parse({ type: "turn_reply", episode: "episode", text: "Project" }),
    ).toEqual({ type: "turn_reply", episode: "episode", text: "Project" });
    const text = "  Keep my words\nexactly.  ";
    expect(
      InboxDecisionSchema.parse({ type: "turn_reply", episode: "episode", text }),
    ).toMatchObject({ text });
    expect(
      InboxDecisionSchema.safeParse({ type: "problem_fix", problemId: "problem" }).success,
    ).toBe(false);
  });

  it("refuses the retired untyped message wire", () => {
    expect(
      InboxEntrySchema.safeParse({ ...common, important: false, state: "open", proposal: null })
        .success,
    ).toBe(false);
  });
});

describe("AgentCatalogSchema", () => {
  it("reads a catalog from a host that predates reasoning efforts as offering none", () => {
    expect(
      AgentCatalogSchema.parse({
        providers: [
          {
            instanceId: "codex",
            label: "Codex",
            unavailableReason: null,
            models: [{ id: "m", label: "Model" }],
          },
        ],
        defaultChoice: { providerInstanceId: "codex", model: "m" },
      }),
    ).toMatchObject({
      providers: [{ models: [{ efforts: [], defaultEffort: null }] }],
      defaultChoice: { reasoningEffort: null },
    });
  });
});

describe("InboxProposalSchema", () => {
  it("reads a suggestion from a desktop that predates its newer fields", () => {
    const proposal = InboxProposalSchema.parse({
      proposalId: "p",
      revision: 1,
      state: "open",
      outdated: false,
      summary: "Start on it",
      rationale: null,
      action: { type: "new_chat", projectId: null, projectName: null, prompt: "Do it" },
      failureMessage: null,
    });
    expect(proposal).toMatchObject({
      origin: "agent",
      producedBy: null,
      action: { additions: [], agent: null },
    });
  });
});

describe("ChatItemSchema", () => {
  const activity = {
    kind: "activity",
    id: "step",
    at: "2026-11-08T00:00:00.000Z",
    detail: null,
    status: "done",
    output: null,
    outputTruncated: false,
  };

  it("reads a step from a host that predates its pictures as having none", () => {
    expect(
      ChatItemSchema.parse({
        ...activity,
        category: "tool",
        title: "Take a screenshot",
      }),
    ).toMatchObject({ kind: "activity", images: [], unavailableImages: [] });
  });

  it.each([
    ["view", "Viewed chart.png"],
    ["generate", "Generated image"],
  ])("decodes an image activity for %s", (imageAction, title) => {
    expect(
      ChatItemSchema.parse({ ...activity, category: "image", imageAction, title }),
    ).toMatchObject({
      category: "image",
      imageAction,
      title,
    });
  });
});
