import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, type TestContext } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { REDUCED_MOTION_STORAGE_KEY } from "@/lib/reduced-motion";
import { ReducedMotionProvider } from "@/lib/use-reduced-motion";
import type { CodexConversationItem } from "@/lib/types";
import type { VisibleConversationTurnEntry } from "../selectors";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { LocalConversationVirtualizedTurnList } from "./local-conversation-virtualized-turn-list";
import "../../../globals.css";

const originalApi = window.api;
beforeEach(() => {
  // Geometry runs real transcript components against an inert synthetic transport.
  window.api = {
    on: () => () => {},
    invoke: async (channel, ...args) =>
      channel === "persisted-atom:sync-request"
        ? { revision: 0, values: {} }
        : channel === "codex:app-server:request"
          ? { type: "result", result: undefined }
          : channel === "workspace-paths-exist"
            ? { existingPaths: (args[0] as { paths: string[] }).paths }
            : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
});

function entry(index: number, pending = false): VisibleConversationTurnEntry {
  const turnId = `viewport-turn-${index}`;
  const user: CodexConversationItem = {
    threadId: "viewport-thread",
    turnId,
    itemId: `${turnId}:input`,
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: `Viewport request ${index}`,
    createdAt: 1,
    updatedAt: 1,
  };
  const assistant: CodexConversationItem = {
    threadId: "viewport-thread",
    turnId,
    itemId: `${turnId}:answer`,
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    markdownText:
      `Viewport answer ${index}.\n\n` +
      "A bounded line of readable transcript content. ".repeat(12),
    createdAt: 2,
    updatedAt: 2,
  };
  return {
    turnKey: turnId,
    turnSearchKey: turnId,
    turnId,
    requests: [],
    isMostRecentTurn: true,
    turn: {
      threadId: "viewport-thread",
      turnId,
      status: pending ? "inProgress" : "completed",
      itemIds: pending ? [] : [assistant.itemId],
      items: pending ? [user] : [user, assistant],
    },
  };
}

function renderThread(initial: VisibleConversationTurnEntry[], reducedMotion: boolean) {
  localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, reducedMotion ? "on" : "off");
  const store = createMaitaiStore();
  let controller: LocalConversationThreadScrollControllerValue | null = null;
  function Thread({
    entries,
    footerHeight = 60,
  }: {
    readonly entries: VisibleConversationTurnEntry[];
    readonly footerHeight?: number;
  }) {
    const scroll = useLocalConversationThreadScrollController();
    useLayoutEffect(() => {
      controller = scroll;
    });
    return (
      <div style={{ width: 700, height: 600 }}>
        <LocalConversationThreadScrollLayout footer={<div style={{ height: footerHeight }} />}>
          <LocalConversationVirtualizedTurnList
            entries={entries.map((value, index) => ({
              ...value,
              isMostRecentTurn: index === entries.length - 1,
            }))}
            conversationId="viewport-thread"
            threadCwd={null}
            editableTurnId={null}
            canForkFromTurn={false}
            initialScrollOffset={0}
            latestTurnSynchronousMeasurementKey={entries.at(-1)?.turnKey}
            scrollElement={scroll.scrollElement}
          />
        </LocalConversationThreadScrollLayout>
      </div>
    );
  }
  function Providers({ children }: { readonly children: ReactNode }) {
    return (
      <MaitaiProvider store={store}>
        <ReducedMotionProvider>
          <LocalConversationTestQueryProvider>
            <NodexTooltipProvider>
              <EnsureLocalConversationThreadScrollController>
                {children}
              </EnsureLocalConversationThreadScrollController>
            </NodexTooltipProvider>
          </LocalConversationTestQueryProvider>
        </ReducedMotionProvider>
      </MaitaiProvider>
    );
  }
  const view = render(
    <Providers>
      <Thread entries={initial} />
    </Providers>,
  );
  return {
    ...view,
    readController: () => {
      if (!controller) throw new Error("missing scroll controller");
      return controller;
    },
    update: (entries: VisibleConversationTurnEntry[], footerHeight = 60) =>
      view.rerender(
        <Providers>
          <Thread entries={entries} footerHeight={footerHeight} />
        </Providers>,
      ),
    dispose: () => {
      view.unmount();
      disposeMaitaiStore(store);
    },
  };
}

const settleFrames = async (count = 2) => {
  for (let index = 0; index < count; index += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

async function recordGeometry(
  context: TestContext,
  scenario: string,
  values: Record<string, number | undefined>,
) {
  Object.assign(context.task.meta, { viewportGeometry: { scenario, ...values } });
  await act(async () => {
    await context.annotate(scenario, "viewport geometry", {
      body: JSON.stringify({ scenario, ...values }),
      bodyEncoding: "utf-8",
      contentType: "application/json",
    });
    await settleFrames(3);
  });
}

describe("transcript viewport motion in Chromium", () => {
  test("resource expansion retains bottom follow and the current history anchor", async (context) => {
    const withResources = (index: number): VisibleConversationTurnEntry => {
      const value = entry(index);
      const items = value.turn.items.map((item) =>
        item.kind === "assistantMessage"
          ? {
              ...item,
              markdownText: `${item.markdownText}\n\n${Array.from({ length: 5 }, (_, number) => `[file](output-${number}.pdf)`).join(" ")}`,
            }
          : item,
      );
      return { ...value, turn: { ...value.turn, items } };
    };
    const bottomView = renderThread(
      Array.from({ length: 10 }, (_, index) => (index === 9 ? withResources(index) : entry(index))),
      true,
    );
    let heightGrowth = 0;
    let bottomTopDelta = 0;
    try {
      await bottomView.findByRole("button", { name: "Show 2 more" });
      await act(async () => {
        await settleFrames(6);
      });
      const row = bottomView.container.querySelector<HTMLElement>(
        '[data-turn-key="viewport-turn-9"]',
      )!;
      const before = row.getBoundingClientRect();
      await act(async () => {
        fireEvent.click(bottomView.getByRole("button", { name: "Show 2 more" }));
        await settleFrames(6);
      });
      const after = row.getBoundingClientRect();
      heightGrowth = after.height - before.height;
      bottomTopDelta = after.top - before.top;
      expect(heightGrowth).toBeGreaterThan(30);
      expect(
        Math.abs(bottomView.readController().getLastScrollDistanceFromBottomPx()),
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(bottomTopDelta + heightGrowth)).toBeLessThanOrEqual(1);
    } finally {
      bottomView.dispose();
    }
    const historyView = renderThread(
      Array.from({ length: 12 }, (_, index) => (index === 7 ? withResources(index) : entry(index))),
      true,
    );
    try {
      await act(async () => {
        await settleFrames(6);
        historyView.readController().holdViewport();
        historyView.readController().scrollToDistanceFromBottomPx(650, "instant");
        await settleFrames(6);
      });
      const button = await historyView.findByRole("button", { name: "Show 2 more" });
      const scroll = historyView.readController().getScrollElement()!;
      const anchor = [
        ...historyView.container.querySelectorAll<HTMLElement>("[data-turn-key]"),
      ].find((row) => {
        const rectangle = row.getBoundingClientRect();
        return (
          rectangle.top > scroll.getBoundingClientRect().top &&
          rectangle.bottom < scroll.getBoundingClientRect().bottom
        );
      })!;
      expect(anchor).toBeDefined();
      const before = anchor.getBoundingClientRect().top;
      await act(async () => {
        fireEvent.click(button);
        await settleFrames(6);
      });
      const anchorError = Math.abs(anchor.getBoundingClientRect().top - before);
      expect(anchorError).toBeLessThanOrEqual(1);
      await recordGeometry(context, "resource expansion", {
        heightGrowth,
        bottomTopDelta,
        historyAnchorError: anchorError,
      });
    } finally {
      historyView.dispose();
    }
  });
  test("animates real viewport placement while both bubbles stay in the document flow", async (context) => {
    const turns = Array.from({ length: 10 }, (_, index) => entry(index));
    const view = renderThread(turns, false);
    try {
      await waitFor(() => expect(view.readController().getScrollElement()?.clientHeight).toBe(600));
      await act(async () => {
        await settleFrames();
      });
      await act(async () => {
        view.readController().prepareLatestTurnSubmitPlacement();
        view.update([...turns, entry(10, true)]);
      });
      const scroll = view.readController().getScrollElement()!;
      const initialDistance = -scroll.scrollTop;
      const latest = view.container.querySelector<HTMLElement>(
        '[data-turn-key="viewport-turn-10"]',
      )!;
      const initialTop = latest.getBoundingClientRect().top;
      expect(initialDistance).toBeGreaterThan(50);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(-scroll.scrollTop).toBeLessThan(initialDistance);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 650));
      });
      expect(-scroll.scrollTop).toBeLessThanOrEqual(2);
      expect(latest.getBoundingClientRect().top).toBeLessThan(initialTop - 50);
      expect(latest.getBoundingClientRect().height).toBeGreaterThan(0);
      await recordGeometry(context, "submit placement", {
        initialDistance,
        finalDistance: -scroll.scrollTop,
        initialTop,
        finalTop: latest.getBoundingClientRect().top,
      });
    } finally {
      view.dispose();
    }
  });
  test("peer append preserves an older reading position and does not create submit space", async (context) => {
    const turns = Array.from({ length: 10 }, (_, index) => entry(index));
    const view = renderThread(turns, true);
    try {
      await act(async () => {
        await settleFrames();
        view.readController().holdViewport();
        view.readController().scrollToDistanceFromBottomPx(400, "instant");
        await settleFrames();
      });
      const scroll = view.readController().getScrollElement()!;
      const viewport = scroll.getBoundingClientRect();
      const anchor = [...view.container.querySelectorAll<HTMLElement>("[data-turn-key]")].find(
        (row) =>
          row.getBoundingClientRect().top > viewport.top &&
          row.getBoundingClientRect().bottom < viewport.bottom,
      )!;
      expect(anchor).toBeDefined();
      const before = anchor.getBoundingClientRect().top;
      await act(async () => {
        view.update([...turns, entry(10, true)]);
        await settleFrames();
      });
      expect(view.readController().responseSpacerState?.getHeightPx()).toBe(0);
      expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
      await recordGeometry(context, "peer append", {
        anchorBefore: before,
        anchorAfter: anchor.getBoundingClientRect().top,
        responseSpace: view.readController().responseSpacerState?.getHeightPx(),
      });
    } finally {
      view.dispose();
    }
  });
  test("a content interaction stops placement without marking layout compensation as user scroll", async () => {
    const turns = Array.from({ length: 10 }, (_, index) => entry(index));
    const view = renderThread(turns, false);
    try {
      await act(async () => {
        await settleFrames();
        view.readController().prepareLatestTurnSubmitPlacement();
        view.update([...turns, entry(10, true)]);
        await settleFrames();
      });
      const userDeltas: number[] = [];
      const release = view
        .readController()
        .addUserScrollListener((distance) => userDeltas.push(distance));
      const latest = view.container.querySelector<HTMLElement>(
        '[data-turn-key="viewport-turn-10"]',
      )!;
      await act(async () => {
        fireEvent.pointerDown(latest, { pointerType: "mouse" });
        await settleFrames();
      });
      const stopped = view.readController().getScrollDistanceFromBottomPx();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      expect(view.readController().getScrollDistanceFromBottomPx()).toBeCloseTo(stopped, 0);
      expect(userDeltas).toEqual([]);
      release();
    } finally {
      view.dispose();
    }
  });
  test("expanding completed tool work preserves an older visible anchor through every measured frame", async (context) => {
    const turns = Array.from({ length: 10 }, (_, index) => entry(index));
    const latest = turns.at(-2)!;
    const command: CodexConversationItem = {
      threadId: "viewport-thread",
      turnId: latest.turnId,
      itemId: "geometry-command",
      type: "command_execution",
      kind: "commandExecution",
      semanticKind: "exec",
      createdAt: 1_000,
      updatedAt: 3_000,
      status: "completed",
      command: "printf 'viewport output'",
      commandActions: [{ type: "unknown", command: "printf 'viewport output'" }],
      aggregatedOutput: "A measured command output line.\n".repeat(80),
      exitCode: 0,
      toolCall: { subtype: "command", toolName: "exec_command", args: {} },
    };
    latest.turn = {
      ...latest.turn,
      durationMs: 2_000,
      firstTurnWorkItemStartedAtMs: 1_000,
      completedAt: 3_000,
      items: [latest.turn.items[0]!, command, latest.turn.items[1]!],
      itemIds: [command.itemId, latest.turn.items[1]!.itemId],
    };
    const view = renderThread(turns, false);
    try {
      await act(async () => {
        await settleFrames(4);
        view.readController().holdViewport();
        view.readController().scrollToDistanceFromBottomPx(500, "instant");
        await settleFrames(3);
      });
      const scroll = view.readController().getScrollElement()!;
      const viewport = scroll.getBoundingClientRect();
      const anchor = [...view.container.querySelectorAll<HTMLElement>("[data-turn-key]")].find(
        (row) =>
          row.getBoundingClientRect().top > viewport.top &&
          row.getBoundingClientRect().bottom < viewport.bottom,
      )!;
      expect(anchor).toBeDefined();
      const before = anchor.getBoundingClientRect().top;
      const work = view.getByRole("button", { name: "Ran printf 'viewport output'" });
      const samples: number[] = [];
      await act(async () => {
        fireEvent.click(work);
        for (let index = 0; index < 25; index += 1) {
          await settleFrames(1);
          samples.push(anchor.getBoundingClientRect().top);
        }
      });
      expect(work.getAttribute("aria-expanded")).toBe("true");
      expect(Math.max(...samples.map((top) => Math.abs(top - before)))).toBeLessThanOrEqual(1);
      await recordGeometry(context, "tool expansion", {
        anchorBefore: before,
        sampledFrames: samples.length,
        maxAnchorError: Math.max(...samples.map((top) => Math.abs(top - before))),
      });
    } finally {
      view.dispose();
    }
  });
  test("composer resize preserves old content while its controls stay outside the scrolling content", async (context) => {
    const turns = Array.from({ length: 10 }, (_, index) => entry(index));
    const view = renderThread(turns, true);
    try {
      await act(async () => {
        await settleFrames(4);
        view.readController().holdViewport();
        view.readController().scrollToDistanceFromBottomPx(450, "instant");
        await settleFrames(3);
      });
      const scroll = view.readController().getScrollElement()!;
      const viewport = scroll.getBoundingClientRect();
      const anchor = [...view.container.querySelectorAll<HTMLElement>("[data-turn-key]")].find(
        (row) =>
          row.getBoundingClientRect().top > viewport.top &&
          row.getBoundingClientRect().bottom < viewport.bottom,
      )!;
      const before = anchor.getBoundingClientRect().top;
      const footer = view.container.querySelector<HTMLElement>("[data-thread-scroll-footer]")!;
      expect(scroll.contains(footer)).toBe(false);
      await act(async () => {
        view.update(turns, 180);
        await settleFrames(5);
      });
      expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
      expect(
        Number.parseFloat(scroll.style.getPropertyValue("--thread-scroll-padding-bottom")),
      ).toBe(212);
      await recordGeometry(context, "composer resize", {
        anchorBefore: before,
        anchorAfter: anchor.getBoundingClientRect().top,
        footerPadding: Number.parseFloat(
          scroll.style.getPropertyValue("--thread-scroll-padding-bottom"),
        ),
      });
    } finally {
      view.dispose();
    }
  });
  test("local steering re-places the same Turn using its steering identity", async (context) => {
    const turns = Array.from({ length: 10 }, (_, index) => entry(index));
    const view = renderThread(turns, true);
    try {
      await act(async () => {
        await settleFrames(4);
        view.readController().prepareLatestTurnSubmitPlacement();
        view.update([...turns, entry(10, true)]);
        await settleFrames(3);
      });
      const active = entry(10, true);
      const steer: CodexConversationItem = {
        threadId: "viewport-thread",
        turnId: active.turnId,
        itemId: "native-steer",
        rawItemId: "native-steer",
        rawItemType: "steeringUserMessage",
        type: "steeringUserMessage",
        kind: "userMessage",
        semanticKind: "userMessage",
        role: "user",
        markdownText: "A steering request in the same Turn",
        steeringStatus: "pending",
        createdAt: 3,
        updatedAt: 3,
      };
      active.turn = {
        ...active.turn,
        items: [...active.turn.items, steer],
        itemIds: [steer.itemId],
      };
      await act(async () => {
        view.readController().prepareLatestTurnSubmitPlacement();
        view.update([...turns, active]);
        await settleFrames(3);
      });
      const scroll = view.readController().getScrollElement()!;
      const available =
        scroll.clientHeight -
        Number.parseFloat(scroll.style.getPropertyValue("--thread-scroll-padding-bottom"));
      expect(view.readController().responseSpacerState?.getHeightPx()).toBe(
        Math.max(0, Math.min((available * 2) / 3, available - 240)),
      );
      expect(-scroll.scrollTop).toBeLessThanOrEqual(2);
      const latest = view.container.querySelector<HTMLElement>(
        '[data-turn-key="viewport-turn-10"]',
      )!;
      const beforeGrowth = latest.getBoundingClientRect().height;
      const placedSpace = view.readController().responseSpacerState!.getHeightPx();
      const response: CodexConversationItem = {
        ...entry(10).turn.items[1]!,
        rawItemType: "agentMessage",
        assistantPhase: "commentary",
        markdownText: "Continuing after this steering request.",
      };
      active.turn = {
        ...active.turn,
        items: [...active.turn.items, response],
        itemIds: [steer.itemId, response.itemId],
      };
      await act(async () => {
        view.update([...turns, active]);
        await settleFrames(3);
      });
      await act(async () => {
        await settleFrames(3);
      });
      const measuredHeight = latest.getBoundingClientRect().height;
      const scale = window.devicePixelRatio;
      const growth =
        Math.round(measuredHeight * scale) / scale - Math.round(beforeGrowth * scale) / scale;
      expect(growth).toBeGreaterThan(0);
      expect(view.readController().responseSpacerState?.getHeightPx()).toBe(
        Math.max(0, placedSpace - growth),
      );
      await recordGeometry(context, "steering re-placement and subsequent response growth", {
        placedSpace,
        latestHeightBeforeGrowth: beforeGrowth,
        latestHeightAfterGrowth: measuredHeight,
        responseGrowth: growth,
        responseSpaceAfterGrowth: view.readController().responseSpacerState?.getHeightPx(),
      });
    } finally {
      view.dispose();
    }
  });
});
