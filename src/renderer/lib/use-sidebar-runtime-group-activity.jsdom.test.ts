import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import type { SessionSidebarPlacement } from "../../shared/sidebar-sections";
import type { AgentRuntimeActivityStore } from "./agent-runtime-session-activity";
import { SIDEBAR_SECTIONS_QUERY_KEY } from "./sidebar-sections-api";
import { mergeRuntimeProjectActivity } from "./sidebar-runtime-group-activity";
import {
  sidebarRuntimeSessionPlacementsQueryOptions,
  useSidebarRuntimeGroupActivity,
} from "./use-sidebar-runtime-group-activity";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./sidebar-sections-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebar-sections-api")>()),
  readSessionSidebarPlacements: mocks.read,
}));

const activity = (status: AgentRuntimeSessionActivity["status"]): AgentRuntimeSessionActivity => ({
  sessionId: "live",
  threadId: "thread:live",
  status,
  activeRunId: null,
  pendingRequestCount: status === "waiting" ? 1 : 0,
  backgroundTasks: [],
  providerInstanceId: "codex",
  model: "test",
  updatedAt: "2026-10-31T00:00:00Z",
});

describe("sidebar Runtime placement query", () => {
  it("canonicalizes IDs and batches a live set that grows past the snapshot bound", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `session:${i}`);
    const options = sidebarRuntimeSessionPlacementsQueryOptions([...ids.toReversed(), ids[0]!]);
    expect(options.queryKey).toEqual(sidebarRuntimeSessionPlacementsQueryOptions(ids).queryKey);
    mocks.read
      .mockReset()
      .mockImplementation(async (batch: string[]) => batch.map((sessionId) => ({ sessionId })));
    expect(await options.queryFn()).toHaveLength(501);
    expect(mocks.read.mock.calls.map(([batch]) => batch.length)).toEqual([500, 1]);
    expect(sidebarRuntimeSessionPlacementsQueryOptions([]).enabled).toBe(false);
  });

  it("updates live status without refetching and refreshes membership, unread and archive through the Section prefix", async () => {
    let activities = new Map([["live", activity("running")]]);
    const listeners = new Set<() => void>();
    const store: AgentRuntimeActivityStore = {
      read: (id) => activities.get(id) ?? null,
      readAll: () => activities,
      subscribeAll: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribeSession: () => () => {},
      readConnection: () => ({ status: "idle" }),
      subscribeConnection: () => () => {},
    };
    let placements: SessionSidebarPlacement[] = [
      { sessionId: "live", projectId: "project", sectionId: "inherited", unread: false },
    ];
    mocks.read.mockReset().mockImplementation(async () => placements);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const view = renderHook(() => useSidebarRuntimeGroupActivity(store), { wrapper });
    try {
      await waitFor(() =>
        expect(view.result.current.projects.get("project")?.runningCount).toBe(1),
      );
      await act(async () => {
        activities = new Map([["live", activity("waiting")]]);
        listeners.forEach((listener) => listener());
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.result.current.sections.get("inherited")?.waitingCount).toBe(1),
      );
      expect(mocks.read).toHaveBeenCalledTimes(1);
      placements = [{ sessionId: "live", projectId: "moved", sectionId: "direct", unread: true }];
      await act(async () => {
        await client.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
      });
      await waitFor(() => expect(view.result.current.sections.has("direct")).toBe(true));
      expect(view.result.current.sections.has("inherited")).toBe(false);
      expect(view.result.current.projects.has("project")).toBe(false);
      expect(
        mergeRuntimeProjectActivity(
          { projectId: "moved", taskCount: 1, waitingCount: 0, unreadCount: 1, activeCount: 0 },
          view.result.current.projects.get("moved"),
        ),
      ).toEqual({
        projectId: "moved",
        taskCount: 1,
        waitingCount: 1,
        unreadCount: 0,
        activeCount: 0,
      });
      placements = [];
      await act(async () => {
        await client.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
      });
      await waitFor(() => expect(view.result.current.projects.size).toBe(0));
      expect(view.result.current.sections.size).toBe(0);
    } finally {
      view.unmount();
      client.clear();
    }
  });
});
