import { describe, expect, test } from "vite-plus/test";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
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
          conversation: childWithApproval,
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

  test("reads inline membership and approvals from resident islands while durable archive state wins", () => {
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
          type: "approval",
          kind: "command",
          requestId: "old",
          projectId: "project-1",
          threadId: "child",
          turnId: "child-turn",
          itemId: "command",
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
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "child",
              turnId: "child-turn",
              itemId: "command",
              kind: "command",
              environmentId: null,
              startedAtMs: 3,
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

  test.each(
    ["legacy", "resident", "overlay"].flatMap((storage) =>
      [false, true].map((hasChanges) => ({ storage, hasChanges })),
    ),
  )(
    "uses the file approval visibility contract for $storage changes=$hasChanges",
    ({ storage, hasChanges }) => {
      const changes: Extract<ThreadItem, { type: "fileChange" }>["changes"] = hasChanges
        ? [
            {
              path: "/repo/file.txt",
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@\n-before\n+after\n",
            },
          ]
        : [];
      const initial: CodexCanonicalConversationState = {
        ...conversationFixture("child", [
          {
            ...turnFixture("child-turn", "inProgress"),
            items: [
              {
                type: "fileChange",
                id: "file",
                status: "inProgress",
                changes,
              },
            ],
          },
        ]),
        requests: [
          {
            id: "file-approval",
            method: "item/fileChange/requestApproval",
            params: {
              threadId: "child",
              turnId: "child-turn",
              itemId: "file",
              startedAtMs: 5,
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
      expect(projected[0]?.role).toBe(hasChanges ? "childApproval" : "backgroundChild");
    },
  );
});
