import { describe, expect, test } from "vite-plus/test";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import {
  extractCodexConversationRelationshipThreadIds,
  projectCodexConversationRelationships,
  type CodexConversationRelationshipThread,
} from "./CodexConversationRelationshipsProjection";

const conversation = (
  threadId: string,
  overrides: Partial<CodexConversationSnapshot> = {},
): CodexConversationSnapshot => ({
  threadId,
  projectId: "project-1",
  source: null,
  threadName: "Thread",
  threadPreview: "Preview",
  cwd: "/tmp/project",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-08-24T00:00:00.000Z",
  resumeState: "resumed",
  turns: [],
  requests: [],
  queuedFollowUps: {
    status: "ready",
    ledgerRevision: 0,
    projectionRevision: 0,
    entries: [],
    inFlightFollowUpId: null,
    editingFollowUpId: null,
    error: null,
  },
  pendingSteers: [],
  backgroundTerminalRows: [],
  capabilityFlags: {
    canEditLastUserTurn: true,
    canForkFromTurn: true,
    canSearch: true,
    canCollapseTurns: true,
  },
  ...overrides,
});

const durableChild = (
  threadId: string,
  overrides: Partial<CodexConversationRelationshipThread> = {},
): CodexConversationRelationshipThread => ({
  threadId,
  parentThreadId: "parent",
  threadName: threadId,
  threadPreview: "",
  model: null,
  agentNickname: null,
  agentRole: null,
  agentPath: null,
  statusType: "idle",
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

describe("CodexConversationRelationshipsProjection", () => {
  test("extracts unique child ids from canonical collaboration calls", () => {
    const state = {
      protocol: { id: "parent" },
      turns: [
        {
          items: [
            {
              type: "collabAgentToolCall",
              receiverThreadIds: [" child-b ", "parent", "child-a", "child-b"],
            },
            { type: "agentMessage" },
          ],
        },
      ],
    } as unknown as CodexCanonicalConversationState;

    expect(extractCodexConversationRelationshipThreadIds(state)).toEqual(["child-b", "child-a"]);
  });

  test("projects canonical order, approval role, friendly metadata, and archive filtering", () => {
    const childWithApproval = conversation("child-b", {
      source: { parentThreadId: "parent" },
      threadName: "Scout",
      agentNickname: "@Scout",
      agentRole: "reviewer",
      agentPath: "agents/scout",
      turns: [
        {
          threadId: "child-b",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
      requests: [
        {
          type: "approval",
          requestId: "approval-1",
          kind: "command",
          projectId: "project-1",
          threadId: "child-b",
          turnId: "turn-1",
          itemId: "item-1",
          createdAt: 4,
        },
      ],
    });
    const memberships = projectCodexConversationRelationships({
      parent: conversation("parent"),
      canonicalChildThreadIds: ["child-b"],
      children: [
        { thread: durableChild("child-a", { createdAt: 1 }), conversation: null },
        {
          thread: durableChild("child-b", { createdAt: 2 }),
          conversation: childWithApproval,
        },
        {
          thread: durableChild("child-archived", { archived: true }),
          conversation: null,
        },
      ],
    });

    expect(memberships.map(({ threadId }) => threadId)).toEqual(["child-b", "child-a"]);
    expect(memberships[0]).toMatchObject({
      role: "childApproval",
      actorName: "Scout",
      agentRole: "reviewer",
      agentPath: "agents/scout",
      showInlineActivity: true,
      thread: { nickname: "@Scout", agentRole: "reviewer" },
    });
    expect(memberships[1]).toMatchObject({
      role: "backgroundChild",
      actorName: "child-a",
      showInlineActivity: false,
    });
  });
});
