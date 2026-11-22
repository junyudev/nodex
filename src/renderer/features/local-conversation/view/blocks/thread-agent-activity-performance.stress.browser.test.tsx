import { Profiler, type ProfilerOnRenderCallback, type ReactElement } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import type { CodexConversationItem } from "@/lib/types";
import type {
  ThreadAgentActivityGroupBlockModel,
  ThreadAgentActivityGroupEntryModel,
} from "../../thread-stage-types";
import { THREAD_TOOL_CALL_FIXTURE_ITEMS } from "@/test/thread-tool-call-fixture";
import { CodexShimmerText } from "../shared/codex-shimmer-text";
import { ThreadAgentActivityGroupBlock } from "./local-conversation-block-leaves";
import { buildV2AgentActivityGroupBlock } from "../../projection/agent-activity-group";
import { isThreadClassifiableActivityItem } from "../../projection/agent-activity-v2";
import "../../../../globals.css";

const LARGE_MIXED_GROUP_CYCLES = 30;
const OPEN_TRACE_NAME = "thread-agent-activity:open-120";
const COLLAPSED_STREAM_TRACE_NAME = "thread-agent-activity:collapsed-stream-120";
const EXPANDED_STREAM_TRACE_NAME = "thread-agent-activity:expanded-stream-120";

type ReducedMotionPreference = "no-preference" | "reduce";

interface ChromiumMediaEmulationSession {
  send(
    method: "Emulation.setEmulatedMedia",
    params: {
      features: Array<{
        name: "prefers-reduced-motion";
        value: ReducedMotionPreference;
      }>;
    },
  ): Promise<unknown>;
}

type TraceStage = "mount" | "collapsed-stream" | "open" | "expanded-stream" | "close";

interface ProfileCommit {
  actualDurationMs: number;
  phase: "mount" | "update" | "nested-update";
  stage: TraceStage;
}

function cloneActivityItem(base: CodexConversationItem, id: string): CodexConversationItem {
  return {
    ...base,
    threadId: "thread-performance",
    turnId: "turn-performance",
    itemId: id,
    entryId: id,
    mcpToolCall: base.mcpToolCall
      ? {
          ...base.mcpToolCall,
          callId: id,
        }
      : base.mcpToolCall,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildActivityEntry(
  base: CodexConversationItem,
  type: ThreadAgentActivityGroupEntryModel["type"],
  id: string,
): ThreadAgentActivityGroupEntryModel {
  const entry = cloneActivityItem(base, id);
  return {
    id,
    turnId: entry.turnId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    searchableText: `${type} ${id}`,
    type,
    entry,
    status: entry.status,
  } as ThreadAgentActivityGroupEntryModel;
}

function buildLargeMixedGroup(): ThreadAgentActivityGroupBlockModel {
  const families = [
    { base: THREAD_TOOL_CALL_FIXTURE_ITEMS.fileChange, type: "fileChange" },
    { base: THREAD_TOOL_CALL_FIXTURE_ITEMS.webSearch, type: "webSearch" },
    { base: THREAD_TOOL_CALL_FIXTURE_ITEMS.mcp, type: "mcpToolCall" },
    { base: THREAD_TOOL_CALL_FIXTURE_ITEMS.command, type: "exec" },
  ] as const;
  const entries = Array.from({ length: LARGE_MIXED_GROUP_CYCLES }, (_, cycle) =>
    families.map(({ base, type }) => buildActivityEntry(base, type, `${type}-${cycle}`)),
  ).flat();

  return buildV2AgentActivityGroupBlock(entries, "agent-activity-performance", {
    bodyEntries: entries,
    canExpand: true,
    state: { kind: "summary" },
  });
}

function buildStreamingUpdate(
  block: ThreadAgentActivityGroupBlockModel,
  revision: number,
): ThreadAgentActivityGroupBlockModel {
  const lastEntry = block.entries.at(-1);
  if (!lastEntry) return block;

  const activeEntry: ThreadAgentActivityGroupEntryModel = {
    ...lastEntry,
    updatedAt: lastEntry.updatedAt + 1,
    status: "inProgress",
    entry: {
      ...lastEntry.entry,
      aggregatedOutput: `${lastEntry.entry.aggregatedOutput ?? ""}\nstream revision ${revision}`,
      exitCode: undefined,
      status: "inProgress",
      updatedAt: lastEntry.entry.updatedAt + 1,
    },
  };
  if (!isThreadClassifiableActivityItem(activeEntry)) {
    throw new Error("The performance activity fixture must end in a classifiable tool item.");
  }
  const entries = [...block.entries.slice(0, -1), activeEntry];
  return buildV2AgentActivityGroupBlock(entries, "agent-activity-performance", {
    bodyEntries: entries,
    canExpand: true,
    state: {
      kind: "active",
      item: {
        item: activeEntry,
        grouping: "groupable",
      },
    },
  });
}

function sumCommitDuration(commits: readonly ProfileCommit[], stage: TraceStage): number {
  return commits
    .filter((commit) => commit.stage === stage)
    .reduce((total, commit) => total + commit.actualDurationMs, 0);
}

function groupSteps(body: HTMLElement): HTMLElement {
  const steps = body.querySelector("[data-activity-steps]");
  if (!(steps instanceof HTMLElement)) throw new Error("Expected the activity steps list.");
  return steps;
}

function countGroupRows(body: HTMLElement): number {
  return groupSteps(body).children.length;
}

async function renderAndSettle(ui: ReactElement): Promise<ReturnType<typeof render>> {
  let view: ReturnType<typeof render> | null = null;
  await act(async () => {
    view = render(ui);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  if (!view) throw new Error("Expected the browser renderer to mount.");
  return view;
}

describe("ThreadAgentActivityGroupBlock Chromium behavior", () => {
  test("traces collapsed, open, and streaming ownership for a large mixed group", async () => {
    const initialBlock = buildLargeMixedGroup();
    performance.clearMeasures(OPEN_TRACE_NAME);
    performance.clearMeasures(COLLAPSED_STREAM_TRACE_NAME);
    performance.clearMeasures(EXPANDED_STREAM_TRACE_NAME);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const maitaiStore = createMaitaiStore();
    const commits: ProfileCommit[] = [];
    let stage: TraceStage = "mount";
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
      commits.push({ actualDurationMs: actualDuration, phase, stage });
    };
    const renderGroup = (block: ThreadAgentActivityGroupBlockModel) => (
      <MaitaiProvider store={maitaiStore}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Profiler id="large-thread-agent-activity" onRender={onRender}>
              <ThreadAgentActivityGroupBlock
                block={block}
                isLatestTurn
                isStreamingTurn={block.status === "inProgress"}
              />
            </Profiler>
          </TooltipProvider>
        </QueryClientProvider>
      </MaitaiProvider>
    );
    const view = await renderAndSettle(renderGroup(initialBlock));
    const disclosure = view.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!disclosure) throw new Error("Expected the activity disclosure button.");
    // A closed group keeps none of its rows mounted.
    expect(view.queryByTestId("agent-activity-group-body")).toBe(null);

    stage = "collapsed-stream";
    const collapsedStreamStartedAt = performance.now();
    let currentBlock = initialBlock;
    for (let revision = 1; revision <= 3; revision += 1) {
      currentBlock = buildStreamingUpdate(currentBlock, revision);
      await act(async () => {
        view.rerender(renderGroup(currentBlock));
        await Promise.resolve();
      });
      expect(view.queryByTestId("agent-activity-group-body")).toBe(null);
    }
    const collapsedStreamLatencyMs = performance.now() - collapsedStreamStartedAt;
    const collapsedStreamCommitMs = sumCommitDuration(commits, "collapsed-stream");

    stage = "open";
    const openStartedAt = performance.now();
    await act(async () => {
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    await waitFor(() => {
      const body = view.getByTestId("agent-activity-group-body");
      expect(body.getAttribute("aria-hidden")).toBe("false");
      expect(body.hasAttribute("inert")).toBe(false);
      expect(countGroupRows(body)).toBe(currentBlock.entries.length);
    });
    const openLatencyMs = performance.now() - openStartedAt;
    const openCommitMs = sumCommitDuration(commits, "open");
    const body = view.getByTestId("agent-activity-group-body");
    const steps = groupSteps(body);
    const rowWrappersBeforeStream = [...steps.children];
    const childListMutations: MutationRecord[] = [];
    const mutationObserver = new MutationObserver((records) => {
      childListMutations.push(...records.filter((record) => record.type === "childList"));
    });
    mutationObserver.observe(steps, { childList: true });

    stage = "expanded-stream";
    const expandedStreamingBlock = buildStreamingUpdate(currentBlock, 4);
    const expandedStreamStartedAt = performance.now();
    await act(async () => {
      view.rerender(renderGroup(expandedStreamingBlock));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    mutationObserver.disconnect();
    const expandedStreamLatencyMs = performance.now() - expandedStreamStartedAt;
    const expandedStreamCommitMs = sumCommitDuration(commits, "expanded-stream");
    const rowWrappersAfterStream = [...steps.children];

    performance.measure(OPEN_TRACE_NAME, {
      start: openStartedAt,
      duration: openLatencyMs,
      detail: { commitMs: openCommitMs, rows: currentBlock.entries.length },
    });
    performance.measure(COLLAPSED_STREAM_TRACE_NAME, {
      start: collapsedStreamStartedAt,
      duration: collapsedStreamLatencyMs,
      detail: { commitMs: collapsedStreamCommitMs, updates: 3 },
    });
    performance.measure(EXPANDED_STREAM_TRACE_NAME, {
      start: expandedStreamStartedAt,
      duration: expandedStreamLatencyMs,
      detail: { commitMs: expandedStreamCommitMs, rows: expandedStreamingBlock.entries.length },
    });

    expect(openCommitMs).toBeGreaterThan(0);
    expect(collapsedStreamCommitMs).toBeGreaterThan(0);
    expect(expandedStreamCommitMs).toBeGreaterThan(0);
    expect(performance.getEntriesByName(OPEN_TRACE_NAME, "measure").length).toBe(1);
    expect(performance.getEntriesByName(COLLAPSED_STREAM_TRACE_NAME, "measure").length).toBe(1);
    expect(performance.getEntriesByName(EXPANDED_STREAM_TRACE_NAME, "measure").length).toBe(1);
    expect(childListMutations).toEqual([]);
    expect(rowWrappersAfterStream.length).toBe(rowWrappersBeforeStream.length);
    for (let index = 0; index < rowWrappersBeforeStream.length - 1; index += 1) {
      expect(rowWrappersAfterStream[index]).toBe(rowWrappersBeforeStream[index]);
    }
    expect(countGroupRows(view.getByTestId("agent-activity-group-body"))).toBe(
      expandedStreamingBlock.entries.length,
    );

    stage = "close";
    await act(async () => {
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.queryByTestId("agent-activity-group-body")).toBe(null);
    });
  });

  test("preserves narrow truncation and native disclosure keyboard behavior", async () => {
    const block = buildLargeMixedGroup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const maitaiStore = createMaitaiStore();
    const view = await renderAndSettle(
      <MaitaiProvider store={maitaiStore}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <div data-testid="narrow-activity-host" style={{ width: 220 }}>
              <ThreadAgentActivityGroupBlock
                block={block}
                isLatestTurn={false}
                isStreamingTurn={false}
                threadCwd="/workspace/nodex"
              />
            </div>
          </TooltipProvider>
        </QueryClientProvider>
      </MaitaiProvider>,
    );
    const host = view.getByTestId("narrow-activity-host");
    const disclosure = view.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!disclosure) throw new Error("Expected the activity disclosure button.");
    const hostRect = host.getBoundingClientRect();
    const disclosureRect = disclosure.getBoundingClientRect();

    expect(disclosureRect.width).toBeGreaterThan(0);
    expect(disclosureRect.right).toBeLessThanOrEqual(hostRect.right + 0.5);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);

    disclosure.focus();
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    await waitFor(() => {
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      const body = view.getByTestId("agent-activity-group-body");
      expect(body.getAttribute("aria-hidden")).toBe("false");
      expect(body.hasAttribute("inert")).toBe(false);
    });

    await act(async () => {
      await userEvent.keyboard("{Space}");
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => {
      expect(view.queryByTestId("agent-activity-group-body")).toBe(null);
    });
  });

  test("keeps the activity shimmer static under reduced motion", async () => {
    // Vitest keeps this provider-neutral type empty; Chromium supplies `send` at runtime.
    const session = cdp() as unknown as ChromiumMediaEmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const view = render(
        <CodexShimmerText data-testid="reduced-motion-activity-summary">
          Running checks
        </CodexShimmerText>,
      );
      const shimmer = view.getByTestId("reduced-motion-activity-summary");
      const sweep = shimmer.lastElementChild;
      const highlight = sweep?.firstElementChild;
      if (!(sweep instanceof HTMLElement) || !(highlight instanceof HTMLElement)) {
        throw new Error("Expected the retained cadenced shimmer overlay.");
      }

      expect(getComputedStyle(shimmer).animationName).toBe("none");
      expect(getComputedStyle(sweep).animationName).toBe("none");
      expect(getComputedStyle(highlight).animationName).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });

  test("grows a long group to its natural height under one hairline", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const maitaiStore = createMaitaiStore();
    const view = await renderAndSettle(
      <MaitaiProvider store={maitaiStore}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <div style={{ width: 320 }}>
              <ThreadAgentActivityGroupBlock
                block={buildLargeMixedGroup()}
                isLatestTurn={false}
                isStreamingTurn={false}
              />
            </div>
          </TooltipProvider>
        </QueryClientProvider>
      </MaitaiProvider>,
    );
    const disclosure = view.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!disclosure) throw new Error("Expected the activity disclosure button.");

    await act(async () => {
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    const body = await waitFor(() => view.getByTestId("agent-activity-group-body"));
    await waitFor(() => {
      expect(getComputedStyle(body).overflow).toBe("visible");
    });
    const steps = groupSteps(body);
    const stepsStyle = getComputedStyle(steps);
    const rule = getComputedStyle(steps, "::before");

    expect(stepsStyle.maxHeight).toBe("none");
    expect(stepsStyle.overflowY).toBe("visible");
    expect(stepsStyle.rowGap).toBe("12px");
    expect(stepsStyle.paddingInlineStart).toBe("24px");
    expect(steps.scrollHeight).toBe(steps.clientHeight);
    expect(body.getBoundingClientRect().height).toBeGreaterThanOrEqual(steps.scrollHeight);
    expect(rule.borderInlineStartWidth).toBe("1px");
    expect(rule.insetInlineStart).toBe("8px");
  });
});
