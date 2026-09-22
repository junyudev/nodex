import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexSubagentOverviewReadInput,
  CodexSubagentOverviewRow,
  CodexSubagentOverviewWindow,
  CodexEvent,
} from "../../../../../shared/types";
import {
  formatSubagentElapsedTime,
  formatSubagentObjective,
  formatSubagentRelativeTime,
  SubagentsPanelOverview,
  SubagentsPanelOverviewContent,
} from "./subagents-panel";

const overviewMocks = vi.hoisted(() => ({
  read: vi.fn(),
  subscribe: vi.fn<(listener: (event: CodexEvent) => void) => () => void>(() => () => undefined),
}));

vi.mock("@/lib/api", () => ({
  subscribeCodexEvents: overviewMocks.subscribe,
}));

vi.mock("../../local-conversation-store", () => ({
  useCodexAppServerControl: () => ({ readSubagentOverview: overviewMocks.read }),
}));

function buildRow(
  index: number,
  status: CodexSubagentOverviewRow["status"],
): CodexSubagentOverviewRow {
  return {
    threadId: `${status}-${index}`,
    parentThreadId: "root",
    displayName: `${status} ${index}`,
    actorName: `Agent ${index}`,
    agentRole: null,
    spawnModel: null,
    objective: status === "active" ? `Inspect target ${index}` : null,
    status,
    statusSummary: status === "waiting" ? "Queued behind another agent" : null,
    startedAtMs: status === "done" ? null : 1_000,
    lastActivityAtMs: status === "done" ? 2_000 : 1_000,
    completedAtMs: status === "done" ? 2_000 : null,
    lastAssistantMessageAtMs: status === "done" ? 2_000 : null,
    recencyAtMs: 1_000,
    diffStats: null,
    canOpen: true,
    canInteract: true,
  };
}

function buildOverview(input: {
  active: CodexSubagentOverviewRow[];
  done: CodexSubagentOverviewRow[];
  activeTotal?: number | null;
  doneTotal?: number | null;
  completeness?: CodexSubagentOverviewWindow["completeness"];
}): CodexSubagentOverviewWindow {
  return {
    rootThreadId: "root",
    revision: 7,
    generation: 2,
    completeness: input.completeness ?? "complete",
    active: {
      rows: input.active,
      knownCount: input.active.length,
      totalCount: input.activeTotal === undefined ? input.active.length : input.activeTotal,
      continuation: null,
    },
    done: {
      rows: input.done,
      knownCount: input.done.length,
      totalCount: input.doneTotal === undefined ? input.done.length : input.doneTotal,
      continuation: null,
    },
  };
}

beforeEach(() => {
  overviewMocks.read.mockReset();
  overviewMocks.subscribe.mockClear();
});

describe("SubagentsPanelOverview", () => {
  test("reads only the initial metadata window until explicit expansion, then releases it", async () => {
    const active = Array.from({ length: 5 }, (_, index) => buildRow(index + 1, "active"));
    const initial = buildOverview({ active: active.slice(0, 4), done: [], activeTotal: 5 });
    initial.active.continuation = "active:4";
    const expanded = buildOverview({ active, done: [], activeTotal: 5 });
    overviewMocks.read.mockImplementation(async (input: CodexSubagentOverviewReadInput) =>
      input.mode === "initial" ? initial : expanded,
    );

    render(
      <SubagentsPanelOverview
        projectId="project"
        rootThreadId="root"
        onError={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(await screen.findByText("Active · 5")).toBeTruthy();
    expect(screen.queryByText("active 5")).toBeNull();
    expect(overviewMocks.read).toHaveBeenCalledTimes(1);
    expect(overviewMocks.read).toHaveBeenLastCalledWith({ rootThreadId: "root", mode: "initial" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("active 5")).toBeTruthy();
    expect(overviewMocks.read).toHaveBeenLastCalledWith({
      rootThreadId: "root",
      mode: "expanded",
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(overviewMocks.read).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("active 5")).toBeNull();
    expect(overviewMocks.read).toHaveBeenLastCalledWith({ rootThreadId: "root", mode: "initial" });
  });

  test("rereads only the matching root after a Directory invalidation", async () => {
    let onEvent: ((event: CodexEvent) => void) | null = null;
    overviewMocks.subscribe.mockImplementation((listener) => {
      onEvent = listener;
      return () => undefined;
    });
    const initial = buildOverview({ active: [buildRow(1, "unknown")], done: [] });
    const settled = {
      ...buildOverview({ active: [], done: [buildRow(1, "done")] }),
      revision: initial.revision + 1,
    };
    overviewMocks.read.mockResolvedValueOnce(initial).mockResolvedValue(settled);

    render(
      <SubagentsPanelOverview
        projectId="project"
        rootThreadId="root"
        onError={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(await screen.findByText("Active · 1")).toBeTruthy();

    await act(async () => {
      onEvent?.({ type: "subagentOverviewInvalidated", rootThreadId: "another-root" });
      await new Promise((resolve) => setTimeout(resolve, 75));
    });
    expect(overviewMocks.read).toHaveBeenCalledTimes(1);

    await act(async () => {
      onEvent?.({ type: "subagentOverviewInvalidated", rootThreadId: "root" });
      await new Promise((resolve) => setTimeout(resolve, 75));
    });
    await waitFor(() => expect(overviewMocks.read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Done · 1")).toBeTruthy();
  });

  test("serializes invalidation refreshes behind an in-flight overview read", async () => {
    vi.useFakeTimers();
    let resolveInitial: ((value: CodexSubagentOverviewWindow) => void) | null = null;
    const initial = buildOverview({ active: [buildRow(1, "unknown")], done: [] });
    const refreshed = {
      ...buildOverview({ active: [], done: [buildRow(1, "done")] }),
      revision: initial.revision + 1,
    };
    overviewMocks.read
      .mockImplementationOnce(
        () =>
          new Promise<CodexSubagentOverviewWindow>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValue(refreshed);

    let onEvent: ((event: CodexEvent) => void) | null = null;
    overviewMocks.subscribe.mockImplementation((listener) => {
      onEvent = listener;
      return () => undefined;
    });

    try {
      render(
        <SubagentsPanelOverview
          projectId="project"
          rootThreadId="root"
          onError={() => undefined}
          onSelect={() => undefined}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(overviewMocks.read).toHaveBeenCalledTimes(1);
      await act(async () => {
        onEvent?.({ type: "subagentOverviewInvalidated", rootThreadId: "root" });
        await vi.runOnlyPendingTimersAsync();
      });
      expect(overviewMocks.read).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveInitial?.(initial);
        await Promise.resolve();
      });
      expect(overviewMocks.read).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Done · 1")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SubagentsPanelOverviewContent", () => {
  test("mounts 4 active and 10 done rows, then expands all and collapses again", async () => {
    const active = Array.from({ length: 5 }, (_, index) => buildRow(index + 1, "active"));
    const done = Array.from({ length: 11 }, (_, index) => buildRow(index + 1, "done"));
    const overview = buildOverview({ active, done });
    const onToggleExpanded = vi.fn();
    const view = render(
      <SubagentsPanelOverviewContent
        rootThreadId="root"
        overview={overview}
        onSelect={() => undefined}
        onToggleExpanded={onToggleExpanded}
      />,
    );

    expect(screen.getByText("Active · 5")).toBeTruthy();
    expect(screen.getByText("Done · 11")).toBeTruthy();
    expect(screen.queryByText("active 5")).toBeNull();
    expect(screen.queryByText("done 11")).toBeNull();
    expect(
      view.container.querySelectorAll('[data-slot="thread-summary-panel-item-group"]')[0]?.children,
    ).toHaveLength(4);
    expect(
      view.container.querySelectorAll('[data-slot="thread-summary-panel-item-group"]')[1]?.children,
    ).toHaveLength(10);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Show more" })[0]!);
      await Promise.resolve();
    });
    expect(onToggleExpanded).toHaveBeenCalledWith("active", true);

    view.rerender(
      <SubagentsPanelOverviewContent
        rootThreadId="root"
        overview={overview}
        expandedSections={new Set(["active"])}
        onSelect={() => undefined}
        onToggleExpanded={onToggleExpanded}
      />,
    );
    expect(screen.getByText("active 5")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      await Promise.resolve();
    });
    expect(onToggleExpanded).toHaveBeenCalledWith("active", false);
  });

  test("uses a working preview and elapsed clock for a waiting row without a summary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const waiting = { ...buildRow(2, "waiting"), statusSummary: null };
    const view = render(
      <SubagentsPanelOverviewContent
        rootThreadId="root"
        overview={buildOverview({ active: [waiting], done: [] })}
        onSelect={() => undefined}
      />,
    );

    try {
      expect(screen.getByText("Active · 1")).toBeTruthy();
      expect(screen.getByText("1 waiting")).toBeTruthy();
      expect(screen.getByText("Waiting")).toBeTruthy();
      const waitingRow = screen.getByRole("button", { name: "Open subagent waiting 2" });
      expect(waitingRow.textContent).toContain("Waiting");
      expect(waitingRow.textContent).toContain("Working");
      expect(waitingRow.textContent).toContain("9s");
      expect(screen.queryByText(/Done ·/u)).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  test("dates completed rows from the last assistant message, then activity recency", () => {
    vi.useFakeTimers();
    vi.setSystemTime(300_000);
    const done = {
      ...buildRow(1, "done"),
      completedAtMs: 60_000,
      lastActivityAtMs: 90_000,
      lastAssistantMessageAtMs: 240_000,
      recencyAtMs: 180_000,
    };
    const view = render(
      <SubagentsPanelOverviewContent
        rootThreadId="root"
        overview={buildOverview({ active: [], done: [done] })}
        onSelect={() => undefined}
      />,
    );
    try {
      expect(view.container.querySelector("time")?.dateTime).toBe(new Date(240_000).toISOString());
      view.rerender(
        <SubagentsPanelOverviewContent
          rootThreadId="root"
          overview={buildOverview({
            active: [],
            done: [{ ...done, lastAssistantMessageAtMs: null }],
          })}
          onSelect={() => undefined}
        />,
      );
      expect(view.container.querySelector("time")?.dateTime).toBe(new Date(180_000).toISOString());
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  test("does not create a no-op button for an unavailable row", async () => {
    const onSelect = vi.fn();
    const unavailable = { ...buildRow(1, "active"), canOpen: false };
    const view = render(
      <SubagentsPanelOverviewContent
        rootThreadId="root"
        overview={buildOverview({ active: [unavailable], done: [] })}
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByRole("button", { name: /Open subagent/u })).toBeNull();
    expect(
      view.container.querySelector('[data-subagent-overview-unavailable="true"]'),
    ).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("labels incomplete counts without claiming a total", () => {
    render(
      <SubagentsPanelOverviewContent
        rootThreadId="root"
        overview={buildOverview({
          active: [buildRow(1, "unknown")],
          done: [],
          activeTotal: null,
          doneTotal: null,
          completeness: "incomplete",
        })}
        onSelect={() => undefined}
      />,
    );

    expect(screen.getByText("Active · 1+")).toBeTruthy();
  });
});

describe("subagent overview formatting", () => {
  test("normalizes and bounds objective text", () => {
    expect(formatSubagentObjective("##  Inspect   the renderer ")).toBe("Inspect the renderer");
    const long = formatSubagentObjective("x".repeat(80));
    expect(long?.length).toBe(60);
    expect(long?.endsWith("…")).toBe(true);
  });

  test("uses compact elapsed and relative labels", () => {
    expect(formatSubagentElapsedTime(32_000)).toBe("32s");
    expect(formatSubagentElapsedTime(22 * 60_000)).toBe("22m");
    expect(formatSubagentRelativeTime(1_000, 1_500)).toBe("now");
    expect(formatSubagentRelativeTime(0, 3 * 3_600_000)).toBe("3h");
  });
});
