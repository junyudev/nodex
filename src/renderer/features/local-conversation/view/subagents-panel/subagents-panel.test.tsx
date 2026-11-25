import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { NativeChildWorkDetail } from "./native-child-work-detail";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { queryKeys } from "@/lib/query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexSubagentOverviewReadInput,
  CodexSubagentOverviewRow,
  CodexSubagentOverviewWindow,
  CodexEvent,
} from "../../../../../shared/types";
import { SubagentsPanelOverview, SubagentsPanelOverviewContent } from "./subagents-panel";

const overviewMocks = vi.hoisted(() => ({
  read: vi.fn(),
  subscribe: vi.fn<(listener: (event: CodexEvent) => void) => () => void>(() => () => undefined),
}));

vi.mock("@/lib/api", () => ({
  subscribeCodexEvents: overviewMocks.subscribe,
}));

const viewMock = vi.hoisted(() => ({
  view: "list" as "map" | "list",
  setView: vi.fn<(view: "map" | "list") => void>(),
}));

vi.mock("./subagents-overview-view", () => ({
  useSubagentsOverviewView: () => viewMock,
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
    identityThreadId: `${status}-${index}`,
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
  viewMock.view = "list";
  viewMock.setView.mockReset();
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

test("switching roots discards the previous root’s pending overview", async () => {
  let finishOld: ((overview: CodexSubagentOverviewWindow) => void) | undefined;
  const fresh = {
    ...buildOverview({ active: [], done: [buildRow(2, "done")] }),
    rootThreadId: "next-root",
  };
  overviewMocks.read
    .mockImplementationOnce(
      () =>
        new Promise<CodexSubagentOverviewWindow>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue(fresh);
  const onError = vi.fn();
  const panel = (rootThreadId: string) => (
    <SubagentsPanelOverview
      projectId="project"
      rootThreadId={rootThreadId}
      onError={onError}
      onSelect={() => {}}
    />
  );
  const view = render(panel("root"));
  await act(async () => {
    view.rerender(panel("next-root"));
  });
  expect(await view.findByText("Done · 1")).toBeTruthy();
  await act(async () => {
    finishOld?.(buildOverview({ active: [buildRow(1, "active")], done: [] }));
  });
  expect(view.queryByText("active 1")).toBeNull();
  expect(view.getByText("done 2")).toBeTruthy();
  expect(overviewMocks.read).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
});

test("reads only the opened native batch and keeps unavailable child history distinct from truncation", async () => {
  const read = vi
    .spyOn(agentRuntimeRuntime, "nativeChildWork")
    .mockResolvedValueOnce({ children: [] })
    .mockResolvedValueOnce({
      children: [
        {
          conversationId: "child",
          role: "Reviewer",
          prompt: "Review the proposed change.",
          steps: null,
          truncated: false,
        },
        {
          conversationId: "child-2",
          role: "Researcher",
          prompt: "Check the reported behavior.",
          steps: [
            {
              index: 6,
              type: "tool_call",
              status: "running",
              text: "Checking source",
              toolCalls: [{ name: "read_file", input: "src/main.ts" }],
            },
          ],
          truncated: true,
        },
      ],
    });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (threadId: string) => (
    <QueryClientProvider client={query}>
      <NativeChildWorkDetail sessionId="chat" threadId={threadId} />
    </QueryClientProvider>
  );
  try {
    const { rerender } = render(view("batch-without-records"));
    await screen.findByText("Antigravity has no record of which subagents this call started.");
    await act(async () => rerender(view("batch-with-children")));
    await screen.findByRole("heading", { name: "Reviewer" });
    expect(screen.getByText("Review the proposed change.")).toBeTruthy();
    expect(screen.getByText("No transcript yet.")).toBeTruthy();
    expect(screen.getByText("Earlier steps were omitted.")).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(read.mock.calls).toEqual([
      [{ sessionId: "chat", threadId: "batch-without-records" }],
      [{ sessionId: "chat", threadId: "batch-with-children" }],
    ]);
  } finally {
    read.mockRestore();
  }
});

describe("the overview as a map", () => {
  function renderMap(
    overview: CodexSubagentOverviewWindow,
    props: Partial<Parameters<typeof SubagentsPanelOverviewContent>[0]> = {},
  ) {
    viewMock.view = "map";
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.conversationIdentity.thread("root"), {
      threadId: "root",
      sessionId: "session",
      title: "Passkey sign-in",
      role: "chat",
      agent: {
        kind: "claudeAgent",
        providerInstanceId: null,
        model: "claude-opus-5-5",
        effort: "high",
      },
      archived: false,
      host: null,
    });
    return render(
      <TestQueryProvider client={client}>
        <SubagentsPanelOverviewContent
          rootThreadId="root"
          overview={overview}
          onSelect={() => undefined}
          {...props}
        />
      </TestQueryProvider>,
    );
  }

  test("stops a live subagent from its card", () => {
    const onStop = vi.fn();
    const live = { ...buildRow(1, "active"), displayName: "Sign-in tests", canStop: true };
    const view = renderMap(buildOverview({ active: [live], done: [buildRow(2, "done")] }), {
      onStop,
      isStopping: () => false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop Sign-in tests" }));
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ threadId: "active-1" }));
    expect(screen.queryByRole("button", { name: "Stop done 2" })).toBeNull();
    view.unmount();
  });

  test("brings in the subagents either section still holds with one control", () => {
    const onLoadMore = vi.fn();
    const overview = buildOverview({
      active: [buildRow(1, "active")],
      done: [buildRow(1, "done"), buildRow(2, "done")],
      doneTotal: 5,
    });
    const view = renderMap(
      { ...overview, done: { ...overview.done, continuation: "next" } },
      { onLoadMore },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(onLoadMore.mock.calls).toEqual([["done"]]);
    view.unmount();
  });
});
