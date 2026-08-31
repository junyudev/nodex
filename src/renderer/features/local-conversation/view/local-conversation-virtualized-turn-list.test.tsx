import { afterEach, describe, expect, test } from "vite-plus/test";
import { useState, type ReactNode } from "react";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import { createMaitaiStore, MaitaiProvider } from "../../../lib/maitai";
import { render } from "../../../test/dom";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import type { CodexHistoryRow } from "../../../../shared/codex-conversation-state/codex-history-topology";
import { EnsureLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import {
  LocalConversationVirtualizedTurnList,
  type LocalConversationVirtualizedTurnListEntry,
} from "./local-conversation-virtualized-turn-list";
import type {
  VirtualizedLatestTurnRestoreState,
  VirtualizedTurnListRestoreState,
} from "./local-conversation-turn-virtualization";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

function TooltipProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => createMaitaiStore());
  return (
    <MaitaiProvider store={store}>
      <LocalConversationTestQueryProvider>
        <NodexTooltipProvider>{children}</NodexTooltipProvider>
      </LocalConversationTestQueryProvider>
    </MaitaiProvider>
  );
}

function makeRect(input: Partial<DOMRectReadOnly>): DOMRect {
  const left = input.left ?? 0;
  const top = input.top ?? 0;
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function installQueuedRequestAnimationFrame(): void {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    }) as typeof globalThis.requestAnimationFrame,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: ((frameId: number) => {
      callbacks.delete(frameId);
    }) as typeof globalThis.cancelAnimationFrame,
  });
}

function installTurnBlockSizes(heightsByTurnKey: Readonly<Record<string, number>>): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const turnKey = this.getAttribute("data-turn-key");
      if (turnKey && Object.prototype.hasOwnProperty.call(heightsByTurnKey, turnKey)) {
        return makeRect({
          height: heightsByTurnKey[turnKey],
          width: 640,
        });
      }
      return originalGetBoundingClientRect.call(this);
    },
  });
}

function restoreBrowserGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: originalGetBoundingClientRect,
  });
  if (originalRequestAnimationFrame) {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
  } else {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { requestAnimationFrame?: typeof requestAnimationFrame },
      "requestAnimationFrame",
    );
  }
  if (originalCancelAnimationFrame) {
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
  } else {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { cancelAnimationFrame?: typeof cancelAnimationFrame },
      "cancelAnimationFrame",
    );
  }
}

function buildAssistantEntry(input: {
  itemId: string;
  markdownText: string;
  turnId: string;
}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: input.turnId,
    itemId: input.itemId,
    entryId: input.itemId,
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    markdownText: input.markdownText,
    createdAt: 2,
    updatedAt: 2,
  };
}

function buildUserEntry(input: {
  itemId: string;
  markdownText: string;
  turnId: string;
}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: input.turnId,
    itemId: input.itemId,
    entryId: input.itemId,
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: input.markdownText,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildTurnEntry(input: {
  assistantText: string;
  index: number;
  isMostRecentTurn: boolean;
}): LocalConversationVirtualizedTurnListEntry {
  const turnId = `turn_${input.index}`;
  const userItemId = `user_${input.index}`;
  const assistantItemId = `assistant_${input.index}`;
  const turn: CodexConversationTurn = {
    threadId: "thread_1",
    turnId,
    status: "completed",
    itemIds: [userItemId, assistantItemId],
    items: [
      buildUserEntry({
        itemId: userItemId,
        markdownText: `Request ${input.index}`,
        turnId,
      }),
      buildAssistantEntry({
        itemId: assistantItemId,
        markdownText: input.assistantText,
        turnId,
      }),
    ],
  };
  return {
    turn,
    turnId,
    turnKey: turnId,
    turnSearchKey: turnId,
    requests: [],
    isMostRecentTurn: input.isMostRecentTurn,
  };
}

function buildTurnEntries(texts: readonly string[]): LocalConversationVirtualizedTurnListEntry[] {
  return texts.map((assistantText, index) =>
    buildTurnEntry({
      assistantText,
      index: index + 1,
      isMostRecentTurn: index === texts.length - 1,
    }),
  );
}

function renderVirtualizedTurnList(input: {
  entries: LocalConversationVirtualizedTurnListEntry[];
  historyRows?: readonly CodexHistoryRow[];
  initialLatestTurnRestoreState?: VirtualizedLatestTurnRestoreState;
  onLatestTurnRestoreStateChange?: (
    state: VirtualizedLatestTurnRestoreState | null,
    distanceFromBottomPx: number,
  ) => void;
  onRestoreStateChange?: (state: VirtualizedTurnListRestoreState | null) => void;
}) {
  return render(
    <TooltipProvider>
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationVirtualizedTurnList
          entries={input.entries}
          historyRows={input.historyRows}
          conversationId="thread_1"
          threadCwd="/tmp/project"
          editableTurnId={null}
          canForkFromTurn={true}
          initialLatestTurnRestoreState={input.initialLatestTurnRestoreState}
          onLatestTurnRestoreStateChange={input.onLatestTurnRestoreStateChange}
          onRestoreStateChange={input.onRestoreStateChange}
          scrollElement={null}
        />
      </EnsureLocalConversationThreadScrollController>
    </TooltipProvider>,
  );
}

function hasFixedHeightClippingAncestor(element: Element): boolean {
  let current = element.parentElement;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.style.height === "280px" &&
      current.style.overflow === "hidden"
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

describe("LocalConversationVirtualizedTurnList", () => {
  afterEach(() => {
    restoreBrowserGeometry();
  });

  test("renders mounted older turns without fixed-height overflow clipping while unmeasured", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({});
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries([
        "Tall assistant answer that should remain fully visible before measurement.",
        "Second assistant answer.",
        "Latest assistant answer.",
      ]),
    });

    const tallContent = view.getByText(
      "Tall assistant answer that should remain fully visible before measurement.",
    );

    expect(hasFixedHeightClippingAncestor(tallContent)).toBe(false);
    view.unmount();
  });

  test("renders an inert 144px history row ahead of loaded turns", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({});
    const entries = buildTurnEntries(["Older loaded answer.", "Latest loaded answer."]);
    const gap: CodexHistoryRow = {
      kind: "gap",
      key: "history-gap:older",
      olderBoundary: null,
      newerBoundary: null,
      estimatedHeightPx: 144,
    };
    const view = renderVirtualizedTurnList({
      entries,
      historyRows: [
        gap,
        {
          kind: "content",
          key: "history-content:turn_1",
          turnKey: "turn_1",
          entityKey: "turn_1",
        },
        {
          kind: "content",
          key: "history-content:turn_2",
          turnKey: "turn_2",
          entityKey: "turn_2",
        },
      ],
    });

    const gapElement = [
      ...view.container.querySelectorAll<HTMLElement>("[aria-hidden='true']"),
    ].find((element) => element.style.height === "144px");
    const firstTurn = view.container.querySelector<HTMLElement>("[data-turn-key='turn_1']");

    expect(gapElement).toBeTruthy();
    expect(
      gapElement && firstTurn
        ? gapElement.compareDocumentPosition(firstTurn) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
    view.unmount();
  });

  test("commits initial mounted turn measurements before the animation frame", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({
      turn_1: 96,
      turn_2: 112,
      turn_3: 128,
    });
    const restoreStateRef: { current: VirtualizedTurnListRestoreState | null } = { current: null };
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries([
        "Short assistant answer.",
        "Another short assistant answer.",
        "Latest short assistant answer.",
      ]),
      onRestoreStateChange: (state) => {
        restoreStateRef.current = state;
      },
    });

    view.unmount();

    expect(restoreStateRef.current?.turnHeightsByKey.turn_1 ?? 0).toBe(96);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_2 ?? 0).toBe(112);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_3 ?? 0).toBe(128);
  });

  test("captures the complete running latest-turn restore state during layout cleanup", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({ turn_1: 480 });
    const entries = buildTurnEntries(["Working on the task."]);
    const latestEntry = entries[0];
    if (!latestEntry) throw new Error("expected latest entry");
    latestEntry.turn = {
      ...latestEntry.turn,
      status: "inProgress",
      firstTurnWorkItemStartedAtMs: 10,
      items: latestEntry.turn.items.map((item) =>
        item.kind === "assistantMessage" ? { ...item, assistantPhase: "commentary" } : item,
      ),
    };
    let captured: {
      state: VirtualizedLatestTurnRestoreState | null;
      distanceFromBottomPx: number;
    } | null = null;
    const view = renderVirtualizedTurnList({
      entries,
      initialLatestTurnRestoreState: {
        followMode: "prework_watch",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: "prework",
        turnKey: "turn_1",
      },
      onLatestTurnRestoreStateChange: (state, distanceFromBottomPx) => {
        captured = { state, distanceFromBottomPx };
      },
    });

    view.unmount();

    expect(captured).toEqual({
      distanceFromBottomPx: 0,
      state: {
        followMode: "prework_watch",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: "prework",
        turnKey: "turn_1",
      },
    });
  });

  test("ignores zero-height initial mounted measurements", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({
      turn_1: 0,
      turn_2: 0,
      turn_3: 0,
    });
    const restoreStateRef: { current: VirtualizedTurnListRestoreState | null } = { current: null };
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries([
        "Zero-height assistant answer.",
        "Second zero-height assistant answer.",
        "Latest zero-height assistant answer.",
      ]),
      onRestoreStateChange: (state) => {
        restoreStateRef.current = state;
      },
    });

    view.unmount();

    expect(restoreStateRef.current?.turnHeightsByKey.turn_1 ?? 0).toBe(0);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_2 ?? 0).toBe(0);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_3 ?? 0).toBe(0);
  });
});
