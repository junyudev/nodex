import type { Thread, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import { describe, expect, it } from "@effect/vitest";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  projectCodexConversationHistoryItemWindows,
  projectCodexConversationOlderTurns,
} from "./CodexConversationHistoryProjection";

const turn = (id: string): Turn =>
  ({
    id,
    items: [],
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    itemsView: "full",
  }) as Turn;

describe("projectCodexConversationOlderTurns", () => {
  it("preserves the current permission profile and runtime workspace roots", () => {
    const current = createCodexCanonicalHydratedConversationState(
      {
        id: "thread-history-permissions",
        turns: [turn("turn-new")],
      } as Thread,
      {
        model: "gpt-5.6",
        reasoningEffort: "high",
        cwd: "/workspace/project",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace/project"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: { id: "team-profile", extends: ":workspace" },
        runtimeWorkspaceRoots: ["/workspace/project", "/workspace/shared"],
        pendingRequests: [],
        hasUnreadTurn: false,
      },
    );

    const projected = projectCodexConversationOlderTurns({
      current,
      olderTurns: [turn("turn-old")],
      oldestLoadedTurnId: "turn-new",
    });

    expect(projected.sidecar.hydrationContext?.currentPermissions).toEqual(
      current.sidecar.hydrationContext?.currentPermissions,
    );
  });

  it("preserves the exact cursor pair for every cold physical item page", () => {
    const items: ThreadItem[] = ["a", "b", "c", "d"].map((id) => ({
      type: "agentMessage",
      id,
      text: id,
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    }));
    const hydratedTurn: Turn = { ...turn("turn-cursors"), items, itemsView: "summary" };
    const itemsPagination = {
      olderCursor: "cursor:older-2",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      oldestUserInput: null,
      openingUserMessageId: null,
      itemsView: "summary" as const,
    };
    const canonical = createCodexCanonicalHydratedConversationState(
      { id: "thread-cursors", turns: [hydratedTurn] } as Thread,
      {
        model: "gpt-5.6",
        reasoningEffort: "high",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace"],
        turnItemsPaginationById: { [hydratedTurn.id]: itemsPagination },
      },
    );
    const snapshot = {
      turns: [
        {
          turnId: hydratedTurn.id,
          items: items.map((item) => ({ itemId: item.id })),
        },
      ],
    } as unknown as CodexConversationSnapshot;

    const windows = projectCodexConversationHistoryItemWindows({
      canonical,
      snapshot,
      itemsPaginationByTurnId: {
        [hydratedTurn.id]: itemsPagination,
      },
      itemSegmentsByTurnId: {
        [hydratedTurn.id]: [
          {
            itemIds: ["a", "b"],
            approximateBytes: 2,
            olderCursor: "cursor:older-1",
            newerCursor: "cursor:newer-1",
          },
          {
            itemIds: ["c", "d"],
            approximateBytes: 2,
            olderCursor: "cursor:older-2",
            newerCursor: null,
          },
        ],
      },
    });

    expect(
      windows[hydratedTurn.id]?.segments.map((segment) => ({
        itemIds: segment.items.itemIds,
        olderCursor: segment.olderCursor,
        newerCursor: segment.newerCursor,
      })),
    ).toEqual([
      { itemIds: ["a", "b"], olderCursor: "cursor:older-1", newerCursor: "cursor:newer-1" },
      { itemIds: ["c", "d"], olderCursor: "cursor:older-2", newerCursor: null },
    ]);
  });
});
