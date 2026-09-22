import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import type { CodexApprovalRequest, CodexMcpServerElicitationRequest } from "./types";
import { selectPrimaryBackgroundConversationRequest } from "./codex-conversation-request";

function elicitation(
  requestId: string,
  turnId: string,
  overrides: Partial<CodexMcpServerElicitationRequest> = {},
): CodexMcpServerElicitationRequest {
  return {
    type: "mcpServerElicitation",
    requestId,
    turnId,
    threadId: "child",
    projectId: "project",
    itemId: requestId,
    kind: "generic",
    mode: "form",
    serverName: "workspace",
    message: "Choose a workspace",
    createdAt: 1,
    ...overrides,
  };
}

function conversation(
  turnIds: string[],
  requests: CodexConversationRequestContext["requests"],
): CodexConversationRequestContext {
  return {
    projectId: "project",
    threadId: "child",
    requests,
    turns: turnIds.map((turnId) => ({
      threadId: "child",
      turnId,
      status: "inProgress",
      itemIds: [],
      items: [],
    })),
  };
}

const approval: CodexApprovalRequest = {
  type: "approval",
  requestId: "approval",
  kind: "command",
  projectId: "project",
  threadId: "child",
  turnId: "older",
  itemId: "command",
  createdAt: 2,
};

describe("background conversation requests", () => {
  test.each(["generic", "mcpToolCall", "toolSuggestion"] as const)(
    "selects a pending %s MCP elicitation from a materialized turn",
    (kind) => {
      const request = elicitation("request", "turn", { kind });
      expect(selectPrimaryBackgroundConversationRequest(conversation(["turn"], [request]))).toBe(
        request,
      );
    },
  );

  test("prefers approval within a turn, but a newer turn's elicitation precedes older approval", () => {
    const older = elicitation("older-mcp", "older");
    const newer = elicitation("newer-mcp", "newer");
    expect(
      selectPrimaryBackgroundConversationRequest(conversation(["older"], [approval, older])),
    ).toBe(approval);
    expect(
      selectPrimaryBackgroundConversationRequest(
        conversation(["older", "newer"], [approval, older, newer]),
      ),
    ).toBe(newer);
  });

  test("uses the latest turnless MCP request only after materialized-turn requests", () => {
    const oldest = elicitation("old-turnless", "", { createdAt: 100 });
    const latest = elicitation("latest-turnless", "", {
      mode: "url",
      url: "https://example.com/authorize",
    });
    expect(selectPrimaryBackgroundConversationRequest(conversation([], [oldest, latest]))).toBe(
      latest,
    );
    expect(
      selectPrimaryBackgroundConversationRequest(conversation(["older"], [approval, latest])),
    ).toBe(approval);
  });

  test("does not treat a discovered per-turn request as hydrated history", () => {
    const pending = elicitation("request", "turn");
    const cold = conversation([], [pending]);
    expect(selectPrimaryBackgroundConversationRequest(cold)).toBeNull();
    expect(
      selectPrimaryBackgroundConversationRequest({
        ...cold,
        turns: conversation(["turn"], []).turns,
      }),
    ).toBe(pending);
    expect(selectPrimaryBackgroundConversationRequest(conversation(["turn"], []))).toBeNull();
  });
});
