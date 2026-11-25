import type { AgentSubagentOverviewItem } from "@nodex/agent-runtime/contracts";
import { act } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { queryKeys } from "@/lib/query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import {
  AGENTS_MAP_MAX_RECENT_LIMIT,
  AGENTS_MAP_RECENT_PAGE,
  type AgentsMapChat,
  type AgentsMapReadInput,
  type AgentsMapSnapshot,
} from "../../../shared/agents-map";
import { AgentsSurface } from "./agents-surface";

const source = vi.hoisted(() => ({
  snapshot: null as AgentsMapSnapshot | null,
  reads: [] as AgentsMapReadInput[],
}));

vi.mock("./agents-map-source", () => ({
  useAgentsMap: (input: AgentsMapReadInput & { enabled: boolean }) => {
    source.reads.push({ scope: input.scope, recentLimit: input.recentLimit });
    return { snapshot: source.snapshot, error: null, retry: () => undefined };
  },
  useAgentsMapPulse: () => "idle",
}));

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({
    projects: [
      {
        id: "project-nodex",
        name: "nodex",
        lifecycle: "active",
        appearance: { color: "blue", marker: { kind: "icon", icon: "folder" } },
      },
    ],
  }),
}));

const NOW = Date.parse("2026-11-25T10:00:00Z");

const subagent = (
  id: string,
  overrides: Partial<AgentSubagentOverviewItem> = {},
): AgentSubagentOverviewItem => ({
  id,
  taskId: id,
  delegatedAt: "2026-11-25T09:50:00Z",
  threadId: "root-a",
  runId: "run-a",
  parentTaskId: null,
  parentTaskChildThreadId: null,
  origin: "app_owned",
  driver: "codex",
  providerInstanceId: "codex",
  providerThreadId: null,
  childThreadId: `child-${id}`,
  title: id,
  model: "gpt-6.2-sol",
  status: "running",
  startedAt: "2026-11-25T09:50:00Z",
  completedAt: null,
  updatedAt: "2026-11-25T09:55:00Z",
  attention: null,
  ...overrides,
});

const chat = (sessionId: string, overrides: Partial<AgentsMapChat> = {}): AgentsMapChat => ({
  sessionId,
  rootThreadId: `root-${sessionId}`,
  projectId: "project-nodex",
  agent: {
    kind: "claudeAgent",
    providerInstanceId: null,
    model: "claude-opus-5-5",
    effort: "high",
  },
  state: "working",
  attention: null,
  line: null,
  queuePosition: null,
  startedAt: "2026-11-25T09:46:00Z",
  settledAt: null,
  outcome: null,
  unread: false,
  page: null,
  managed: false,
  subagentCount: { total: 0, live: 0 },
  subagents: null,
  ...overrides,
});

const page = (items: readonly AgentSubagentOverviewItem[]) => ({
  items,
  nextCursor: null,
  hasMore: false,
  totalCount: items.length,
});

function renderSurface(snapshot: AgentsMapSnapshot) {
  source.snapshot = snapshot;
  const client = createTestQueryClient();
  for (const item of [...snapshot.active, ...snapshot.recent])
    client.setQueryData(queryKeys.conversationIdentity.thread(item.rootThreadId), {
      threadId: item.rootThreadId,
      sessionId: item.sessionId,
      title: `Chat ${item.sessionId}`,
      role: "chat",
      agent: item.agent,
      archived: false,
      host: null,
    });
  const onOpenChat = vi.fn();
  const onOpenThread = vi.fn();
  const onScopeChange = vi.fn();
  const view = render(
    <TestQueryProvider client={client}>
      <AgentsSurface
        scope={{ projectId: null }}
        onScopeChange={onScopeChange}
        onOpenChat={onOpenChat}
        onOpenThread={onOpenThread}
        visible
      />
    </TestQueryProvider>,
  );
  return { view, onOpenChat, onOpenThread, onScopeChange };
}

describe("Aerial view", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    source.reads = [];
  });

  test("draws each chat with its work tree, in the order its work started", () => {
    const { view, onOpenChat, onOpenThread } = renderSurface({
      scope: { projectId: null },
      revision: 1,
      complete: true,
      hasMoreRecent: false,
      recent: [],
      active: [
        chat("a", {
          page: { id: "page-912", key: "NODEX-912" },
          line: "Tracing the Inbox header tabs",
          subagentCount: { total: 2, live: 1 },
          subagents: {
            active: page([subagent("inventory")]),
            terminal: page([
              subagent("trace", { status: "completed", completedAt: "2026-11-25T09:58:00Z" }),
            ]),
          },
        }),
        chat("b", {
          state: "waiting",
          attention: "approval",
          line: "Run the board drag test?",
          startedAt: "2026-11-25T09:52:00Z",
        }),
      ],
    });

    const bands = [...view.container.querySelectorAll<HTMLElement>("[data-agents-chat]")];
    expect(bands.map((band) => band.dataset.agentsChat)).toEqual(["a", "b"]);

    const lead = screen.getByRole("button", { name: "Open Chat a" });
    expect(within(lead).getByText("14m")).toBeTruthy();
    expect(within(lead).getByText("Tracing the Inbox header tabs")).toBeTruthy();
    expect(within(lead).getByText("1/2 back")).toBeTruthy();
    expect(within(bands[0]!).getByText("NODEX-912")).toBeTruthy();
    expect(within(bands[0]!).getByText("nodex")).toBeTruthy();

    const waiting = screen.getByRole("button", { name: "Open Chat b" });
    expect(within(waiting).getByText("Needs approval")).toBeTruthy();

    fireEvent.click(lead);
    expect(onOpenChat).toHaveBeenCalledWith({ sessionId: "a", rootThreadId: "root-a" });
    fireEvent.click(screen.getByRole("button", { name: "Open subagent inventory" }));
    expect(onOpenThread).toHaveBeenCalledWith("child-inventory", { runtimeSessionId: "a" });
    view.unmount();
  });

  test("lists chats that finished lately and brings in more on request", async () => {
    const { view, onOpenChat } = renderSurface({
      scope: { projectId: null },
      revision: 1,
      complete: true,
      hasMoreRecent: true,
      active: [],
      recent: [
        chat("done", {
          state: "settled",
          outcome: "failed",
          settledAt: "2026-11-25T08:00:00Z",
          unread: true,
          subagentCount: { total: 4, live: 0 },
        }),
      ],
    });

    expect(screen.getByText("No Agent is working right now.")).toBeTruthy();
    const row = view.container.querySelector<HTMLElement>("[data-agents-recent-chat='done']")!;
    expect(within(row).getByText("4 subagents")).toBeTruthy();
    expect(within(row).getByText("Failed · 2h")).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenChat).toHaveBeenCalledWith({ sessionId: "done", rootThreadId: "root-done" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    expect(source.reads.at(-1)?.recentLimit).toBe(20);
    view.unmount();
  });

  test("stops offering more once the view holds as many finished chats as it can", () => {
    const { view } = renderSurface({
      scope: { projectId: null },
      revision: 1,
      complete: true,
      hasMoreRecent: true,
      active: [],
      recent: [chat("done", { state: "settled", settledAt: "2026-11-25T08:00:00Z" })],
    });
    const showMore = () => screen.queryByRole("button", { name: "Show more" });
    for (let page = 1; page < AGENTS_MAP_MAX_RECENT_LIMIT / AGENTS_MAP_RECENT_PAGE; page += 1)
      fireEvent.click(showMore()!);
    expect(source.reads.at(-1)?.recentLimit).toBe(AGENTS_MAP_MAX_RECENT_LIMIT);
    expect(showMore()).toBeNull();
    view.unmount();
  });

  test("says no Agent is working when nothing is live or recent", () => {
    const { view } = renderSurface({
      scope: { projectId: null },
      revision: 1,
      complete: true,
      hasMoreRecent: false,
      active: [],
      recent: [],
    });
    expect(screen.getByText("No Agent is working")).toBeTruthy();
    view.unmount();
  });
});
