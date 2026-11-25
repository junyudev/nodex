import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import type { AgentsMapSnapshot } from "../../shared/agents-map";
import type { SessionSidebarPlacement } from "../../shared/sidebar-sections";
import { useAgentsMap, useAgentsMapPulse } from "../features/agents/agents-map-source";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  subscribe: vi.fn(),
  placements: vi.fn(),
  activities: vi.fn(),
}));

vi.mock("./agents-map-api", () => ({
  readAgentsMap: mocks.read,
  subscribeAgentsMapChanges: mocks.subscribe,
}));

vi.mock("./agent-runtime-session-activity", () => ({
  useAgentRuntimeActivities: mocks.activities,
}));

vi.mock("./sidebar-sections-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebar-sections-api")>()),
  readSessionSidebarPlacements: mocks.placements,
}));

const scope = { projectId: "project" };
const snapshot = (revision: number): AgentsMapSnapshot => ({
  scope,
  revision,
  active: [],
  recent: [],
  complete: true,
  hasMoreRecent: false,
});

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client }, children);
}

it("shares a racing initial read, catches up, and keeps the result when disabled", async () => {
  let resolveInitial!: (value: AgentsMapSnapshot) => void;
  const initial = new Promise<AgentsMapSnapshot>((resolve) => {
    resolveInitial = resolve;
  });
  mocks.read.mockReset().mockReturnValueOnce(initial).mockResolvedValue(snapshot(2));
  let changed: ((revision: number) => void) | undefined;
  mocks.subscribe.mockImplementation((listener: (revision: number) => void) => {
    changed = listener;
    return () => {
      changed = undefined;
    };
  });
  const view = renderHook(({ enabled }) => useAgentsMap({ scope, recentLimit: 10, enabled }), {
    wrapper: queryWrapper(),
    initialProps: { enabled: true },
  });
  await act(async () => {
    changed?.(2);
    resolveInitial(snapshot(1));
    await initial;
  });
  await waitFor(() => expect(view.result.current.snapshot?.revision).toBe(2));
  view.rerender({ enabled: false });
  expect(changed).toBeUndefined();
  expect(view.result.current.snapshot?.revision).toBe(2);
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it("keeps queued work visible in the pulse and excludes hidden chat attention", async () => {
  const placed = (
    sessionId: string,
    projectId: string | null,
    hidden = false,
  ): SessionSidebarPlacement => ({
    sessionId,
    projectId,
    hidden,
    sectionId: null,
    unread: false,
    snoozedUntil: null,
  });
  mocks.placements.mockResolvedValue([
    placed("queued", "project"),
    placed("coordinator", "project", true),
    placed("side", "project", true),
    placed("other", null),
  ]);
  mocks.activities.mockReturnValue(
    new Map<string, Pick<AgentRuntimeSessionActivity, "status">>([
      ["queued", { status: "queued" }],
      ["side", { status: "waiting" }],
      ["coordinator", { status: "waiting" }],
      ["other", { status: "waiting" }],
    ]),
  );
  const { result } = renderHook(
    () => [useAgentsMapPulse(scope), useAgentsMapPulse({ projectId: null })],
    { wrapper: queryWrapper() },
  );
  await waitFor(() => expect(result.current).toEqual(["working", "waiting"]));
  expect(mocks.placements).toHaveBeenCalledTimes(1);
});
