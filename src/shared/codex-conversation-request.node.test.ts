import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import type { CodexUserInputRequest, CodexMcpServerElicitationRequest } from "./types";
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

const question: CodexUserInputRequest = {
  type: "userInput",
  requestId: "question",
  questions: [{ id: "q", header: "Choice", question: "Continue?", isOther: false }],
  isBlocking: true,
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

  test("prefers a genuine question within a turn, while a newer Turn elicitation precedes it", () => {
    const older = elicitation("older-mcp", "older");
    const newer = elicitation("newer-mcp", "newer");
    expect(
      selectPrimaryBackgroundConversationRequest(conversation(["older"], [question, older])),
    ).toBe(question);
    expect(
      selectPrimaryBackgroundConversationRequest(
        conversation(["older", "newer"], [question, older, newer]),
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
      selectPrimaryBackgroundConversationRequest(conversation(["older"], [question, latest])),
    ).toBe(question);
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

test("keeps a Session-origin question visible without inventing a Turn or loading history", () => {
  const request = {
    type: "userInput" as const,
    requestId: "native-question",
    threadId: "child",
    projectId: "project",
    turnId: null,
    itemId: "question-item",
    questions: [{ id: "q", header: "Choice", question: "Continue?", isOther: false }],
    isBlocking: true,
    createdAt: 3,
  };
  const context = conversation([], [request]);
  expect(selectPrimaryBackgroundConversationRequest(context)).toBe(request);
});
