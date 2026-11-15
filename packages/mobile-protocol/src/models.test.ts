import { describe, expect, it } from "vitest";

import { AgentCatalogSchema, ChatItemSchema, InboxProposalSchema } from "./models";

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
  it("reads a step from a host that predates its pictures as having none", () => {
    expect(
      ChatItemSchema.parse({
        kind: "activity",
        id: "step",
        at: "2026-11-08T00:00:00.000Z",
        category: "tool",
        title: "Take a screenshot",
        detail: null,
        status: "done",
        output: null,
        outputTruncated: false,
      }),
    ).toMatchObject({ kind: "activity", images: [], unavailableImages: [] });
  });
});
