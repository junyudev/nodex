import { describe, expect, test, vi } from "vite-plus/test";
import type { CodexConversationSnapshot } from "@/lib/types";
import { connectedReviewDiffPanelTestHelpers } from "./connected-review-diff-panel";
import {
  areReviewConversationProjectionsEqual,
  buildReviewConversationProjection,
  createReviewConversationProjectionSelector,
} from "@/features/review/model/review-conversation-projection";
import { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import type { ConversationRuntime } from "../conversation-runtime";
import { createCodexCanonicalHydratedConversationState } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";

function buildConversation(unifiedDiff: string): CodexConversationSnapshot {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    source: null,
    resumeState: "resumed",
    threadName: "Thread",
    threadPreview: "",
    modelProvider: "openai",
    cwd: "/workspace/nodex",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "",
    turns: [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        status: "inProgress",
        itemIds: ["turn-diff:turn-1"],
        items: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "turn-diff:turn-1",
            entryId: "turn-diff:turn-1",
            type: "turn-diff",
            kind: "systemEvent",
            semanticKind: "diff",
            status: "inProgress",
            rawItem: {
              type: "turn-diff",
              unifiedDiff,
              cwd: "/workspace/nodex",
              showRevertButton: true,
            },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    ],
    requests: [],
    pendingSteers: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: false,
      canForkFromTurn: false,
      canSearch: false,
      canCollapseTurns: false,
    },
  };
}

describe("connected review diff panel", () => {
  test("reads the current diff from resident keyed Turns when Runtime metadata contains no bodies", () => {
    const patch = "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new";
    const state = createCodexCanonicalHydratedConversationState(
      {
        ...buildAgentActivityV2CorpusThread([]),
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            rootTurnId: null,
            status: "completed",
            items: [],
            itemsView: "full",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        ],
      },
      {
        hostId: "local",
        model: "model",
        reasoningEffort: null,
        cwd: "/workspace/nodex",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace/nodex"],
      },
    );
    const reader = new CodexTranscriptReadOwner({ hostId: "local", threadId: "thread-1" });
    const fullRead = vi.spyOn(reader, "readTurn");
    reader.applyEvent({
      type: "reset",
      value: projectCodexTranscript({ ...state, turns: [{ ...state.turns[0]!, diff: patch }] }),
    });
    const metadata = { ...buildConversation(""), turns: [] };
    const runtime = {
      read: (id: string | null) => (id === "thread-1" ? metadata : null),
      transcriptReadOwner: () => reader,
    } as unknown as ConversationRuntime;
    const read = () =>
      buildReviewConversationProjection(
        connectedReviewDiffPanelTestHelpers.readReviewConversation(runtime, "thread-1"),
      );
    expect(read()).toMatchObject({
      threadId: "thread-1",
      lastTurnId: "turn-1",
      lastTurnPatch: patch,
    });
    const key = reader.readStructure()!.turnEntityKeys[0]!;
    const details = reader.readTurnDetails(key)!;
    const changed = patch.replace("+new", "+changed");
    reader.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...reader.key, entityKey: key },
          details: { ...details, diff: changed },
          hasSubagentActivity: false,
        },
      ],
    });
    expect(read().lastTurnPatch).toBe(changed);
    expect(
      connectedReviewDiffPanelTestHelpers.readReviewConversation(runtime, "other-thread"),
    ).toBeNull();
    reader.applyEvent({
      type: "reset",
      value: projectCodexTranscript({
        ...state,
        turns: [
          {
            ...state.turns[0]!,
            diff: null,
            items: [
              {
                type: "agentMessage",
                id: "prose",
                text: "Unrelated prose".repeat(4096),
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
              {
                type: "fileChange",
                id: "file-change",
                status: "completed",
                changes: [
                  {
                    path: "/workspace/nodex/app.ts",
                    kind: { type: "update", move_path: null },
                    diff: changed,
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(read().lastTurnPatch).toContain("+changed");
    const resident = connectedReviewDiffPanelTestHelpers.readReviewConversation(
      runtime,
      "thread-1",
    )!;
    expect(resident.turns[0]!.items).toHaveLength(1);
    const item = resident.turns[0]!.items[0]!;
    const selected = connectedReviewDiffPanelTestHelpers.refreshSelectedTurnDiffTarget(
      { threadId: "thread-1", turnId: "turn-1", entryId: item.entryId ?? item.itemId },
      resident,
      null,
    );
    expect(selected?.patch).toContain("+changed");
    expect(metadata.turns).toHaveLength(0);
    expect(fullRead).not.toHaveBeenCalled();
    reader.dispose();
  });

  test("keeps the Review projection stable across unrelated agent prose", () => {
    const patch = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new";
    const before = buildConversation(patch);
    const after = structuredClone(before);
    const existingItem = after.turns[0]?.items[0];
    if (!existingItem) throw new Error("Expected a diff item.");
    after.turns[0]?.items.push({
      ...existingItem,
      itemId: "message-2",
      entryId: "message-2",
      rawItem: { text: "Still editing unrelated files." },
      markdownText: "Still editing unrelated files.",
      createdAt: 3,
      updatedAt: 3,
    });

    expect(
      areReviewConversationProjectionsEqual(
        buildReviewConversationProjection(before),
        buildReviewConversationProjection(after),
      ),
    ).toBe(true);

    const changedDiff = buildConversation(patch.replace("+new", "+newer"));
    expect(
      areReviewConversationProjectionsEqual(
        buildReviewConversationProjection(before),
        buildReviewConversationProjection(changedDiff),
      ),
    ).toBe(false);
  });

  test("returns the same projection object across 100 prose-only appends", () => {
    const selector = createReviewConversationProjectionSelector();
    let conversation = buildConversation(
      "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
    );
    const initial = selector(conversation);

    for (let index = 0; index < 100; index += 1) {
      const turn = conversation.turns[0];
      const template = turn?.items[0];
      if (!template) throw new Error("Expected a template item.");
      const proseItem = {
        ...template,
        itemId: `message-${index}`,
        entryId: `message-${index}`,
        rawItem: { text: `Editing progress ${index}` },
        markdownText: `Editing progress ${index}`,
      };
      conversation = {
        ...conversation,
        turns: [...conversation.turns.slice(0, -1), { ...turn, items: [...turn.items, proseItem] }],
      };
      expect(selector(conversation)).toBe(initial);
    }
  });

  test("keeps the previous completed diff when a new prose-only turn starts", () => {
    const selector = createReviewConversationProjectionSelector();
    const conversation = buildConversation(
      "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
    );
    const initial = selector(conversation);
    const priorTurn = conversation.turns[0];
    const template = priorTurn?.items[0];
    if (!priorTurn || !template) throw new Error("Expected a prior turn.");
    const nextConversation: CodexConversationSnapshot = {
      ...conversation,
      turns: [
        priorTurn,
        {
          ...priorTurn,
          turnId: "turn-2",
          status: "inProgress",
          itemIds: ["message-next"],
          items: [
            {
              ...template,
              turnId: "turn-2",
              itemId: "message-next",
              entryId: "message-next",
              type: "message",
              kind: "assistantMessage",
              semanticKind: "assistantMessage",
              rawItem: { text: "Starting another edit." },
              markdownText: "Starting another edit.",
            },
          ],
        },
      ],
    };

    expect(selector(nextConversation)).toBe(initial);
    expect(initial.lastTurnId).toBe("turn-1");
    expect(initial.lastTurnPatch).toContain("+new");
  });

  test("refreshes the selected turn diff when the underlying patch changes", () => {
    const selected = {
      threadId: "thread-1",
      turnId: "turn-1",
      entryId: "turn-diff:turn-1",
    };

    const refreshed = connectedReviewDiffPanelTestHelpers.refreshSelectedTurnDiffTarget(
      selected,
      buildConversation("--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new"),
      null,
    );

    expect(refreshed?.patch.includes("+new") ?? false).toBe(true);
    expect(refreshed?.showRevertButton ?? false).toBe(true);
  });

  test("applies the projectless output scope to the Review projection", () => {
    const mixed = [
      "diff --git a/output/inside.ts b/output/inside.ts",
      "--- a/output/inside.ts",
      "+++ b/output/inside.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/outside.ts b/src/outside.ts",
      "--- a/src/outside.ts",
      "+++ b/src/outside.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const projection = buildReviewConversationProjection({
      ...buildConversation(mixed),
      projectId: null,
      projectlessOutputDirectory: "/workspace/nodex/output",
    });

    expect(projection.lastTurnPatch).toContain("output/inside.ts");
    expect(projection.lastTurnPatch).not.toContain("src/outside.ts");
  });

  test("resolves a selected derived turn diff when no transcript item exists", () => {
    const base = buildConversation("");
    const turn = base.turns[0];
    if (!turn) throw new Error("Expected a turn");
    const conversation: CodexConversationSnapshot = {
      ...base,
      turns: [
        {
          ...turn,
          itemIds: [],
          items: [],
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      ],
    };
    const refreshed = connectedReviewDiffPanelTestHelpers.refreshSelectedTurnDiffTarget(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        entryId: "turn-diff:turn-1",
      },
      conversation,
      null,
    );

    expect(refreshed?.patch).toContain("+new");
  });

  test("falls back to the derived turn diff when a matching item is empty", () => {
    const base = buildConversation("");
    const turn = base.turns[0];
    if (!turn) throw new Error("Expected a turn");
    const conversation: CodexConversationSnapshot = {
      ...base,
      turns: [
        {
          ...turn,
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
          items: [
            {
              ...turn.items[0],
              rawItem: {
                type: "turn-diff",
                unifiedDiff: "",
              },
            },
          ],
        },
      ],
    };

    const refreshed = connectedReviewDiffPanelTestHelpers.refreshSelectedTurnDiffTarget(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        entryId: "turn-diff:turn-1",
      },
      conversation,
      null,
    );

    expect(refreshed?.patch).toContain("+new");
  });
});
