import { act } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";
import {
  appScope,
  createMaitaiStore,
  MaitaiProvider,
  useScopeHandle,
  type ScopeHandle,
} from "@/lib/maitai";
import { render } from "@/test/dom";
import { dispatchCodexAppServerMessage } from "../app-server-message-bus";
import { LocalConversationViewStateCleanupController } from "./local-conversation-view-state-cleanup-controller";
import {
  EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
  localConversationThreadRestoreSnapshotFamily,
  localConversationTurnCollapseOverrideFamily,
  normalizeThreadRestoreDistanceFromBottomPx,
  removeLocalConversationViewState,
  resolveLatestTurnCollapseTransition,
  setLocalConversationTurnCollapseOverride,
  type LocalConversationThreadRestoreSnapshot,
  updateLocalConversationThreadRestoreSnapshot,
} from "./local-conversation-thread-view-state";

function HandleProbe({ onHandle }: { readonly onHandle: (handle: ScopeHandle) => void }) {
  onHandle(useScopeHandle(appScope));
  return null;
}

function TestStateRoot({
  children,
  onHandle,
}: {
  readonly children?: ReactNode;
  readonly onHandle: (handle: ScopeHandle) => void;
}) {
  const [store] = useState(createMaitaiStore);
  return (
    <MaitaiProvider store={store}>
      <HandleProbe onHandle={onHandle} />
      {children}
    </MaitaiProvider>
  );
}

function completeSnapshot(distanceFromBottomPx: number): LocalConversationThreadRestoreSnapshot {
  return {
    distanceFromBottomPx,
    latestTurn: {
      followMode: "prework_watch",
      isLatestTurnInProgress: true,
      latestTurnFollowContentHeightPx: 320,
      latestTurnHeightPx: 480,
      latestTurnPhase: "prework",
      turnKey: "turn_latest",
    },
    virtualizedTurnList: {
      renderedWindow: { anchorKey: "turn_4", count: 7 },
      turnHeightsByKey: { turn_4: 300, turn_latest: 480 },
    },
  };
}

describe("local conversation thread restore atoms", () => {
  test("restores isolated complete snapshots across fresh A/B/A readers", () => {
    let handle: ScopeHandle | null = null;
    render(
      <TestStateRoot
        onHandle={(next) => {
          handle = next;
        }}
      />,
    );
    const appHandle = handle as ScopeHandle | null;
    if (!appHandle) throw new Error("expected app scope handle");

    const snapshotA = completeSnapshot(5_365);
    const snapshotB = completeSnapshot(812);
    appHandle.set(localConversationThreadRestoreSnapshotFamily("thread_a"), snapshotA);
    appHandle.set(localConversationThreadRestoreSnapshotFamily("thread_b"), snapshotB);

    const firstAReader = appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_a"));
    const freshBReader = appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_b"));
    const freshAReader = appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_a"));

    expect(firstAReader).toBe(snapshotA);
    expect(freshBReader).toBe(snapshotB);
    expect(freshAReader).toBe(snapshotA);
    expect(freshAReader.latestTurn).toEqual(snapshotA.latestTurn);
    expect(freshAReader.virtualizedTurnList).toEqual(snapshotA.virtualizedTurnList);
  });

  test.each([
    [-8, 0],
    [0, 0],
    [0.125, 0],
    [24, 0],
    [24.01, 24.01],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("normalizes native restore distance %s to %s", (distance, expected) => {
    expect(normalizeThreadRestoreDistanceFromBottomPx(distance)).toBe(expected);
  });

  test("collapses the old latest turn while preserving the MCP App exception window", () => {
    const regularTransition = resolveLatestTurnCollapseTransition({
      entries: [
        { turnSearchKey: "turn_1", hasMcpApp: false },
        { turnSearchKey: "turn_2", hasMcpApp: false },
      ],
      latestTurnSearchKey: "turn_2",
      previousLatestTurnSearchKey: "turn_1",
    });
    expect(regularTransition).toEqual(["turn_1"]);

    const immediateMcpAppTransition = resolveLatestTurnCollapseTransition({
      entries: [
        { turnSearchKey: "mcp_turn", hasMcpApp: true },
        { turnSearchKey: "turn_2", hasMcpApp: false },
      ],
      latestTurnSearchKey: "turn_2",
      previousLatestTurnSearchKey: "mcp_turn",
    });
    expect(immediateMcpAppTransition).toEqual([]);

    const agedMcpAppTransition = resolveLatestTurnCollapseTransition({
      entries: [
        { turnSearchKey: "mcp_turn", hasMcpApp: true },
        { turnSearchKey: "turn_2", hasMcpApp: false },
        { turnSearchKey: "turn_3", hasMcpApp: false },
        { turnSearchKey: "turn_4", hasMcpApp: false },
      ],
      latestTurnSearchKey: "turn_4",
      previousLatestTurnSearchKey: "turn_3",
    });
    expect(agedMcpAppTransition).toEqual(["turn_3", "mcp_turn"]);
  });

  test("does not evict an earlier snapshot after more than fifty conversations", () => {
    let handle: ScopeHandle | null = null;
    render(
      <TestStateRoot
        onHandle={(next) => {
          handle = next;
        }}
      />,
    );
    const appHandle = handle as ScopeHandle | null;
    if (!appHandle) throw new Error("expected app scope handle");

    for (let index = 1; index <= 75; index += 1) {
      appHandle.set(localConversationThreadRestoreSnapshotFamily(`thread_${index}`), {
        ...EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
        distanceFromBottomPx: index,
      });
    }

    expect(
      appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_1")).distanceFromBottomPx,
    ).toBe(1);
    expect(
      appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_75")).distanceFromBottomPx,
    ).toBe(75);
  });

  test("explicit cleanup removes snapshot and every indexed collapse override idempotently", () => {
    let handle: ScopeHandle | null = null;
    render(
      <TestStateRoot
        onHandle={(next) => {
          handle = next;
        }}
      />,
    );
    const appHandle = handle as ScopeHandle | null;
    if (!appHandle) throw new Error("expected app scope handle");

    appHandle.set(localConversationThreadRestoreSnapshotFamily("thread_a"), completeSnapshot(400));
    setLocalConversationTurnCollapseOverride(
      appHandle,
      {
        conversationId: "thread_a",
        turnSearchKey: "turn_1",
      },
      true,
    );
    setLocalConversationTurnCollapseOverride(
      appHandle,
      {
        conversationId: "thread_a",
        turnSearchKey: "turn_2",
      },
      false,
    );

    expect(removeLocalConversationViewState(appHandle, "thread_a")).toBe(true);
    expect(removeLocalConversationViewState(appHandle, "thread_a")).toBe(false);
    expect(appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_a"))).toBe(
      EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
    );
    expect(
      appHandle.get(
        localConversationTurnCollapseOverrideFamily({
          conversationId: "thread_a",
          turnSearchKey: "turn_1",
        }),
      ),
    ).toBe(null);
  });

  test("cleanup tombstone prevents late layout cleanup from resurrecting deleted state", () => {
    let handle: ScopeHandle | null = null;
    render(
      <TestStateRoot
        onHandle={(next) => {
          handle = next;
        }}
      />,
    );
    const appHandle = handle as ScopeHandle | null;
    if (!appHandle) throw new Error("expected app scope handle");

    expect(
      updateLocalConversationThreadRestoreSnapshot(appHandle, "thread_race", () =>
        completeSnapshot(500),
      ),
    ).toBe(true);
    expect(removeLocalConversationViewState(appHandle, "thread_race")).toBe(true);
    expect(
      updateLocalConversationThreadRestoreSnapshot(appHandle, "thread_race", () =>
        completeSnapshot(900),
      ),
    ).toBe(false);
    expect(appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_race"))).toBe(
      EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
    );
  });

  test("canonical deletion cleans view state while no conversation view is mounted", () => {
    let handle: ScopeHandle | null = null;
    render(
      <TestStateRoot
        onHandle={(next) => {
          handle = next;
        }}
      >
        <LocalConversationViewStateCleanupController />
      </TestStateRoot>,
    );
    const appHandle = handle as ScopeHandle | null;
    if (!appHandle) throw new Error("expected app scope handle");

    appHandle.set(
      localConversationThreadRestoreSnapshotFamily("thread_deleted"),
      completeSnapshot(700),
    );
    setLocalConversationTurnCollapseOverride(
      appHandle,
      {
        conversationId: "thread_deleted",
        turnSearchKey: "turn_1",
      },
      true,
    );

    act(() => {
      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "local",
        threadId: "thread_deleted",
      });
      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "local",
        threadId: "thread_deleted",
      });
    });

    expect(appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_deleted"))).toBe(
      EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
    );
    expect(
      appHandle.get(
        localConversationTurnCollapseOverrideFamily({
          conversationId: "thread_deleted",
          turnSearchKey: "turn_1",
        }),
      ),
    ).toBe(null);
  });
});
