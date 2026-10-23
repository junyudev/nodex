import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivity,
} from "../../shared/agent-runtime-api";
import { queryKeys } from "./query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import type { AgentRuntimeActivityStore } from "./agent-runtime-session-activity";
import { useClaudeUsageReadings } from "./use-claude-usage-readings";

type Providers = AgentRuntimeOperations["providers.read"]["output"];

const mocks = vi.hoisted(() => {
  const settingsListeners = new Set<() => void>();
  return {
    known: vi.fn<() => Promise<Providers | null>>(),
    settingsListeners,
    subscribeSettings: (listener: () => void) => {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },
  };
});
vi.mock("./agent-runtime-runtime", () => ({
  agentRuntimeRuntime: { knownCatalog: mocks.known },
}));
vi.mock("./renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeAgentSettingsChanges: mocks.subscribeSettings }),
}));

const claude = (usedPercent: number) =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    checkedAt: "2027-05-12T08:00:00.000Z",
    auth: { status: "authenticated", email: "dev@example.com", label: "Claude Max" },
    usageLimits: {
      checkedAt: "2027-05-12T08:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          windowDurationMins: 300,
        },
      ],
    },
    models: [],
    slashCommands: [],
    skills: [],
  }) as unknown as Providers[number];
const codex = {
  ...claude(0),
  instanceId: "codex",
  driver: "codex",
} as unknown as Providers[number];

function activity(sessionId: string, providerInstanceId: string): AgentRuntimeSessionActivity {
  return {
    sessionId,
    threadId: `${sessionId}-thread`,
    status: "running",
    activeRunId: "run",
    pendingRequestCount: 0,
    activeTaskCount: 0,
    resumesAutomatically: false,
    providerInstanceId,
    model: "model",
    updatedAt: "2027-05-12T08:00:00.000Z",
  };
}

function fakeActivityStore() {
  let activities = new Map<string, AgentRuntimeSessionActivity>();
  let connection: AgentRuntimeConnectionState = { status: "idle" };
  const all = new Set<() => void>();
  const connections = new Set<() => void>();
  const store: AgentRuntimeActivityStore = {
    read: (sessionId) => activities.get(sessionId) ?? null,
    readAll: () => activities,
    readConnection: () => connection,
    subscribeSession: () => () => {},
    subscribeAll: (listener) => {
      all.add(listener);
      return () => all.delete(listener);
    },
    subscribeConnection: (listener) => {
      connections.add(listener);
      return () => connections.delete(listener);
    },
  };
  return {
    store,
    setActivities(next: readonly AgentRuntimeSessionActivity[]) {
      activities = new Map(next.map((entry) => [entry.sessionId, entry]));
      for (const listener of [...all]) listener();
    },
    setConnection(next: AgentRuntimeConnectionState) {
      connection = next;
      for (const listener of [...connections]) listener();
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <TestQueryProvider>{children}</TestQueryProvider>
);

beforeEach(() => {
  mocks.known.mockReset();
  mocks.settingsListeners.clear();
});

test("Claude usage is read again only when a Claude reply settles", async () => {
  mocks.known.mockResolvedValueOnce([codex, claude(40)]).mockResolvedValue([codex, claude(70)]);
  const activity$ = fakeActivityStore();
  const { result } = renderHook(() => useClaudeUsageReadings(activity$.store), { wrapper });
  await waitFor(() => expect(result.current[0]?.windows[0]?.usedPercent).toBe(40));
  expect(mocks.known).toHaveBeenCalledTimes(1);

  // A Codex reply settling, or the window regaining focus, leaves Claude's reading alone.
  await act(async () => {
    activity$.setActivities([activity("codex-session", "codex")]);
    activity$.setActivities([]);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(mocks.known).toHaveBeenCalledTimes(1);

  // A Claude reply that is still running has not reported its final usage yet.
  await act(async () => {
    activity$.setActivities([activity("claude-session", "claudeAgent")]);
    await Promise.resolve();
  });
  expect(mocks.known).toHaveBeenCalledTimes(1);

  await act(async () => {
    activity$.setActivities([]);
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current[0]?.windows[0]?.usedPercent).toBe(70));
  expect(mocks.known).toHaveBeenCalledTimes(2);
});

test("a meter appears from changed settings or another surface's live catalog read", async () => {
  mocks.known.mockResolvedValueOnce(null).mockResolvedValue([claude(10)]);
  const activity$ = fakeActivityStore();
  const client = createTestQueryClient();
  const { result } = renderHook(() => useClaudeUsageReadings(activity$.store), {
    wrapper: ({ children }) => <TestQueryProvider client={client}>{children}</TestQueryProvider>,
  });
  await waitFor(() => expect(mocks.known).toHaveBeenCalledTimes(1));
  expect(result.current).toEqual([]);

  // Without a Claude meter nothing watches execution, so it cannot prompt a read.
  await act(async () => {
    activity$.setConnection({ status: "ready", generation: "1" });
    await Promise.resolve();
  });
  expect(mocks.known).toHaveBeenCalledTimes(1);

  await act(async () => {
    for (const listener of mocks.settingsListeners) listener();
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current).toHaveLength(1));
  expect(mocks.known).toHaveBeenCalledTimes(2);

  // A model picker's live catalog read carries newer usage without another read.
  await act(async () => {
    await client.fetchQuery({
      queryKey: queryKeys.agentRuntime.providers(),
      queryFn: async () => [claude(55)],
    });
  });
  await waitFor(() => expect(result.current[0]?.windows[0]?.usedPercent).toBe(55));
  expect(mocks.known).toHaveBeenCalledTimes(2);
});

test("while a Claude meter shows, execution becoming available is read again", async () => {
  mocks.known.mockResolvedValueOnce([claude(10)]).mockResolvedValue([claude(30)]);
  const activity$ = fakeActivityStore();
  const { result } = renderHook(() => useClaudeUsageReadings(activity$.store), { wrapper });
  await waitFor(() => expect(result.current).toHaveLength(1));

  await act(async () => {
    activity$.setConnection({ status: "starting" });
    activity$.setConnection({ status: "ready", generation: "1" });
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current[0]?.windows[0]?.usedPercent).toBe(30));
  expect(mocks.known).toHaveBeenCalledTimes(2);
});
