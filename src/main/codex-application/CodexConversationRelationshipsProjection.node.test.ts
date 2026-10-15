import { describe, expect, test } from "vite-plus/test";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
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
  projectId: "project-1",
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
      ...{ id: "parent" },
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

  test("projects canonical order, pending question role, friendly metadata, and archive filtering", () => {
    const childWithQuestion = conversation("child-b", {
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
          type: "userInput",
          requestId: "approval-1",
          projectId: "project-1",
          threadId: "child-b",
          turnId: "turn-1",
          itemId: "item-1",
          isBlocking: true,
          questions: [],
          createdAt: 4,
        },
      ],
    });
    const memberships = projectCodexConversationRelationships({
      parent: conversationFixture("parent"),
      canonicalChildThreadIds: ["child-b"],
      children: [
        {
          thread: durableChild("child-a", { createdAt: 1 }),
          conversation: null,
          canonicalState: null,
        },
        {
          thread: durableChild("child-b", { createdAt: 2 }),
          conversation: childWithQuestion,
          canonicalState: null,
        },
        {
          thread: durableChild("child-archived", { archived: true }),
          conversation: null,
          canonicalState: null,
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

  test("reads inline membership and questions from resident islands while durable archive state wins", () => {
    const parent = produce(
      conversationFixture("parent", [
        {
          ...turnFixture("parent-turn"),
          items: [
            {
              type: "subAgentActivity",
              id: "activity",
              kind: "started",
              agentThreadId: "child",
              agentPath: "/root/child",
            },
          ],
        },
      ]),
      (draft) => {
        replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
      },
    );
    const canonicalState = produce(
      {
        ...conversationFixture("child", [turnFixture("child-turn", "inProgress")]),
        title: "Current child",
        threadRuntimeStatus: { type: "active" as const, activeFlags: [] },
      },
      (draft) => {
        replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
      },
    );
    const stale = conversation("child", {
      archived: true,
      threadName: "Old title",
      requests: [
        {
          type: "userInput",
          requestId: "old",
          projectId: "project-1",
          threadId: "child",
          turnId: "child-turn",
          itemId: "command",
          isBlocking: true,
          questions: [],
          createdAt: 1,
        },
      ],
    });
    const project = (state: CodexCanonicalConversationState) =>
      projectCodexConversationRelationships({
        parent,
        canonicalChildThreadIds: extractCodexConversationRelationshipThreadIds(parent),
        children: [{ thread: durableChild("child"), canonicalState: state, conversation: stale }],
      });
    expect(project(canonicalState)[0]).toMatchObject({
      actorName: "Current child",
      statusType: "active",
      role: "backgroundChild",
      showInlineActivity: true,
    });
    expect(
      project({
        ...canonicalState,
        requests: [
          {
            id: 9,
            method: "item/tool/requestUserInput",
            params: {
              threadId: "child",
              turnId: "child-turn",
              itemId: "command",
              isBlocking: true,
              autoResolutionMs: null,
              questions: [],
            },
          },
        ],
      })[0]?.role,
    ).toBe("childApproval");
  });

  test("keeps live child references alongside resident canonical history", () => {
    const resident = conversationFixture("parent", [
      {
        ...turnFixture("resident-turn"),
        items: [
          {
            type: "subAgentActivity",
            id: "resident-activity",
            kind: "started",
            agentThreadId: "resident-child",
            agentPath: "/root/resident",
          },
        ],
      },
    ]);
    const live = conversationFixture("parent", [
      {
        ...turnFixture("live-turn", "inProgress"),
        items: [
          {
            type: "subAgentActivity",
            id: "live-activity",
            kind: "started",
            agentThreadId: "live-child",
            agentPath: "/root/live",
          },
        ],
      },
    ]);
    const history = produce(resident, (draft) => {
      replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
    });
    const parent = { ...history, turns: live.turns };
    const ids = extractCodexConversationRelationshipThreadIds(parent);
    expect(ids).toEqual(["resident-child", "live-child"]);
    const rows = projectCodexConversationRelationships({
      parent,
      canonicalChildThreadIds: ids,
      children: ids.map((threadId) => ({
        thread: durableChild(threadId),
        canonicalState: null,
        conversation: null,
      })),
    });
    expect(
      rows.map(({ threadId, showInlineActivity }) => ({ threadId, showInlineActivity })),
    ).toEqual([
      { threadId: "resident-child", showInlineActivity: true },
      { threadId: "live-child", showInlineActivity: true },
    ]);
  });

  test.each(["legacy", "resident", "overlay"])(
    "keeps a child question visible from %s metadata without projecting item bodies",
    (storage) => {
      const initial: CodexCanonicalConversationState = {
        ...conversationFixture("child", [turnFixture("child-turn", "inProgress")]),
        requests: [
          {
            id: "child-question",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "child",
              turnId: "child-turn",
              itemId: "question",
              isBlocking: true,
              autoResolutionMs: null,
              questions: [],
            },
          },
        ],
      };
      const canonicalState =
        storage === "legacy"
          ? initial
          : produce(initial, (draft) => {
              const turns = draft.turns;
              replaceCanonicalHistoryDraft(draft, storage === "overlay" ? [] : turns, true, null);
              if (storage === "overlay") draft.turns = turns;
            });
      const projected = projectCodexConversationRelationships({
        parent: conversationFixture("parent"),
        canonicalChildThreadIds: ["child"],
        children: [{ thread: durableChild("child"), canonicalState, conversation: null }],
      });
      expect(projected[0]?.role).toBe("childApproval");
      expect(projected[0]?.pendingRequest?.request.requestId).toBe("child-question");
      expect(projected[0]?.pendingRequest?.requestItem).toBeNull();
    },
  );
});

test("all lifecycle activity establishes membership while messages never do", () => {
  const state = {
    id: "parent",
    turns: [
      {
        items: ["started", "completed", "interrupted", "interacted"].map((kind) => ({
          type: "subAgentActivity",
          kind,
          agentThreadId: kind,
        })),
      },
    ],
  } as unknown as CodexCanonicalConversationState;
  expect(extractCodexConversationRelationshipThreadIds(state)).toEqual([
    "started",
    "completed",
    "interrupted",
  ]);
});
