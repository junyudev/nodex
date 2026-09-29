import { bucketizeTurnItems } from "../renderer/features/local-conversation/projection/bucketize-turn-items";
import {
  classifyThreadAgentActivityItem,
  isThreadClassifiableActivityItem,
} from "../renderer/features/local-conversation/projection/agent-activity-v2";
import { describe, expect, test } from "vite-plus/test";
import type { AgentBackendSessionPresentation } from "./agent-conversation";
import type { CodexThreadSummary } from "./types";
import { projectAgentConversation } from "./agent-conversation-presentation";
import { buildRendererItemStream } from "../renderer/features/local-conversation/projection/build-renderer-item-stream";
import { hasDurableCanonicalFirstSubmission } from "../renderer/features/conversation-launch/session-first-submission-owner";

const summary: CodexThreadSummary = {
  threadId: "thread",
  projectId: "project",
  source: null,
  threadName: "Task",
  threadPreview: "Hello",
  cwd: "/workspace",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-09-29T00:00:00Z",
};
const presentation = (backend: "claude" | "acp"): AgentBackendSessionPresentation => ({
  snapshot: {
    backend,
    threadId: "thread",
    sessionId: "native-session",
    status: "running",
    error: null,
    revision: 1,
    turns: [
      {
        sequence: 1,
        clientUserMessageId: "client-message",
        promptText: "Hello",
        stopReason: null,
        updates: [
          {
            kind: "message",
            key: "message-1",
            role: "agent",
            messageId: "message-1",
            text: "**Working**",
          },
          {
            kind: "tool-call",
            key: "tool-1",
            toolCallId: "tool-1",
            title: "Inspect workspace",
            name: "Task",
            toolKind: "other",
            status: "in_progress",
            detail: "Read the files",
            locations: [],
          },
        ],
      },
    ],
    requests: [
      {
        id: "question",
        toolName: "AskUserQuestion",
        title: "Target",
        detail: "",
        questions: [
          {
            id: "Which target?",
            question: "Which target?",
            multiSelect: true,
            options: [
              { label: "Desktop", description: "Application" },
              { label: "CLI", description: "Terminal" },
            ],
          },
        ],
      },
    ],
  },
  configOptions: [
    {
      id: "model",
      category: "model",
      name: "Model",
      description: null,
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet", description: null }],
    },
  ],
  modes: {
    currentModeId: "plan",
    availableModes: [{ id: "plan", name: "Plan", description: null }],
  },
  capabilities: {
    prompt: { text: true, resourceLink: true, image: false, audio: false, embeddedContext: false },
    session: {
      load: true,
      list: false,
      delete: false,
      resume: true,
      unstableFork: false,
      close: true,
      additionalDirectories: false,
    },
    authMethods: [],
  },
});

describe.each(["claude", "acp"] as const)("%s shared conversation presentation", (backend) => {
  test("uses the normal timeline and acknowledges the accepted first message without raw Codex records", () => {
    const conversation = projectAgentConversation(presentation(backend), summary);
    expect(hasDurableCanonicalFirstSubmission(conversation.turns, "client-message")).toBe(true);
    expect(conversation.turns[0]?.items.every((item) => item.rawItem === undefined)).toBe(true);
    const items = buildRendererItemStream({
      entries: conversation.turns[0]!.items,
      requests: [],
      turnStatus: "inProgress",
    });
    expect(items.map((item) => item.type)).toEqual(["userMessage", "assistantMessage", "toolCall"]);
    const tools = bucketizeTurnItems({ items }).agentItems.filter(
      (item) => item.type === "toolCall",
    );
    expect(tools).toHaveLength(1);
    expect(
      tools
        .filter(isThreadClassifiableActivityItem)
        .map((item) => classifyThreadAgentActivityItem(item)?.grouping),
    ).toEqual(["standalone"]);
    expect(conversation.requests[0]).toMatchObject({
      type: "userInput",
      questions: [{ id: "Which target?", multiSelect: true }],
    });
    expect(conversation.latestThreadSettings).toMatchObject({
      model: "sonnet",
      collaborationMode: { mode: "plan" },
    });
  });

  test("keeps item identity through completion and exposes only supported history actions", () => {
    const before = presentation(backend);
    const after: AgentBackendSessionPresentation = {
      ...before,
      snapshot: {
        ...before.snapshot,
        status: "idle",
        requests: [],
        revision: 2,
        turns: before.snapshot.turns.map((turn) => ({
          ...turn,
          stopReason: "end_turn",
          updates: turn.updates.map((update) =>
            update.kind === "tool-call"
              ? { ...update, status: "completed", detail: "Done" }
              : update,
          ),
        })),
      },
    };
    const live = projectAgentConversation(before, summary);
    const completed = projectAgentConversation(after, summary);
    expect(completed.turns[0]?.itemIds).toEqual(live.turns[0]?.itemIds);
    expect(completed.turns[0]?.status).toBe("completed");
    expect(completed.requests).toEqual([]);
    expect(completed.capabilityFlags).toEqual({
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    });
  });
});
