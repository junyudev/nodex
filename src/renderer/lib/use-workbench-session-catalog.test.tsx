import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import type {
  Project,
  ProjectSession,
  ProjectSessionSummary,
  ProjectSessionSummaryWindow,
} from "../../shared/types";
import type { WorkbenchLocation } from "../../shared/workbench-layout";
import { materializeInitialWorkbenchSessionView } from "../../shared/workbench-session-view";
import {
  applyLegacySessionViewToWorkbenchScene,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../shared/workbench-scene";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("./api", () => ({
  invoke: invokeMock,
}));

import {
  useWorkbenchSessionCatalog,
  type WorkbenchSessionCatalogWindowPort,
} from "./use-workbench-session-catalog";
import { queryKeys } from "./query-keys";

function makeProject(id: string): Project {
  return {
    id,
    libraryId: "library",
    databaseId: `database:${id}`,
    defaultDatabaseViewId: `view:${id}`,
    lifecycle: "active",
    bindingRevision: 0,
    name: id,
    description: "",
    appearance: {},
    sources: [{ root: `/work/${id}`, order: 0 }],
    primaryWorkspaceRoot: `/work/${id}`,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-01-01T00:00:00.000Z"),
    updated: new Date("2026-01-01T00:00:00.000Z"),
  } as Project;
}

function makeSummary(
  id: string,
  projectId: string | null,
  overrides: Partial<ProjectSessionSummary> = {},
): ProjectSessionSummary {
  return {
    id,
    projectId,
    noThreadFallbackTitle: id,
    displayTitle: id,
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeWindow(
  items: ProjectSessionSummary[],
  overrides: Partial<ProjectSessionSummaryWindow> = {},
): ProjectSessionSummaryWindow {
  return {
    items,
    nextCursor: null,
    hasMore: false,
    projectionRevision: 1,
    ...overrides,
  };
}

function makeWindowPort(
  location: WorkbenchLocation = {
    kind: "session",
    sessionId: "session:alpha",
    projectContextId: "alpha",
  },
): WorkbenchSessionCatalogWindowPort {
  return {
    location,
    scenesByOwnerKey: {},
    setScene: vi.fn(),
    selectSession: vi.fn(),
    selectProject: vi.fn(),
    reconcileMissingSession: vi.fn(),
  };
}

function createHarness(
  window: WorkbenchSessionCatalogWindowPort,
  options: {
    projects?: Project[];
    expandedProjectIds?: Set<string>;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
    },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useWorkbenchSessionCatalog({
        projects: options.projects ?? [makeProject("alpha")],
        expandedProjectIds: options.expandedProjectIds ?? new Set(["alpha"]),
        window,
      }),
    { wrapper },
  );
  return { client, hook };
}

beforeEach(() => {
  invokeMock.mockReset();
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (!isWorkspaceSessionCommand(channel)) {
        return await invokeMock(channel, ...args);
      }
      const request = args[0] as { payload: Record<string, unknown> };
      const value = await invokeMock(
        channel,
        ...legacyWorkspaceSessionArgs(channel, request.payload),
      );
      return {
        ok: true,
        value,
        localCommit: {
          status: "committed",
          commit: {
            store_epoch: "epoch:test",
            commit_seq: 2,
            manifest_hash: "f".repeat(64),
          },
          delivery: null,
        },
      };
    },
  });
});

const WORKSPACE_SESSION_COMMANDS = new Set([
  "project-sessions:create",
  "project-sessions:ensure-default-draft",
  "project-sessions:mark-unread",
  "project-sessions:reorder",
  "project-sessions:set-pinned",
]);

function isWorkspaceSessionCommand(channel: string): boolean {
  return WORKSPACE_SESSION_COMMANDS.has(channel);
}

function legacyWorkspaceSessionArgs(channel: string, payload: Record<string, unknown>): unknown[] {
  if (channel === "project-sessions:create") return [payload.input];
  if (channel === "project-sessions:ensure-default-draft") return [payload.projectId];
  if (channel === "project-sessions:reorder") {
    return [payload.projectId, payload.orderedSessionIds];
  }
  if (channel === "project-sessions:mark-unread") {
    return [payload.sessionId, { unread: payload.unread }];
  }
  if (channel === "project-sessions:set-pinned") {
    return [payload.sessionId, { pinned: payload.pinned }];
  }
  throw new Error(`Unexpected Workspace Session command: ${channel}`);
}

describe("useWorkbenchSessionCatalog", () => {
  test("keeps loading distinct from an empty catalog", async () => {
    let resolveProject: ((value: ProjectSessionSummaryWindow) => void) | null = null;
    invokeMock.mockImplementation((channel: string, projectId: string | null) => {
      if (channel === "project-sessions:get") {
        return Promise.resolve(makeSummary("session:alpha", "alpha") as ProjectSession);
      }
      expect(channel).toBe("workspace:tasks:list");
      if (projectId === null) return Promise.resolve(makeWindow([]));
      return new Promise<ProjectSessionSummaryWindow>((resolve) => {
        resolveProject = resolve;
      });
    });
    const window = makeWindowPort();
    const { hook } = createHarness(window);

    expect(hook.result.current.collectionsByProject.alpha.state).toEqual({ kind: "loading" });
    expect(hook.result.current.selectedDetailReady).toBe(false);
    expect(window.reconcileMissingSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveProject?.(makeWindow([makeSummary("session:alpha", "alpha")]));
    });
    await waitFor(() => {
      expect(hook.result.current.selectedDetailReady).toBe(true);
    });
    expect(hook.result.current.active?.domain.id).toBe("session:alpha");
  });

  test("treats a Project with no Sessions as a ready empty collection", async () => {
    invokeMock.mockImplementation((channel: string) => {
      expect(channel).toBe("workspace:tasks:list");
      return Promise.resolve(makeWindow([]));
    });
    const window = makeWindowPort({
      kind: "project",
      projectId: "alpha",
    });
    const { hook } = createHarness(window);

    expect(hook.result.current.selectedDetailReady).toBe(true);
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state).toEqual({
        kind: "ready",
        refreshing: false,
        refreshError: null,
      });
    });
    expect(hook.result.current.collectionsByProject.alpha.projections).toEqual([]);
    expect(invokeMock.mock.calls.some(([channel]) => channel === "project-sessions:get")).toBe(
      false,
    );
  });

  test("isolates loading state between Session scopes", async () => {
    let resolveProjectless: ((value: ProjectSessionSummaryWindow) => void) | null = null;
    invokeMock.mockImplementation((channel: string, projectId: string | null) => {
      expect(channel).toBe("workspace:tasks:list");
      if (projectId === "alpha") return Promise.resolve(makeWindow([]));
      return new Promise<ProjectSessionSummaryWindow>((resolve) => {
        resolveProjectless = resolve;
      });
    });
    const { hook } = createHarness(
      makeWindowPort({
        kind: "project",
        projectId: "alpha",
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state.kind).toBe("ready");
    });
    expect(hook.result.current.projectlessCollection.state.kind).toBe("loading");

    await act(async () => {
      resolveProjectless?.(makeWindow([]));
    });
  });

  test("keeps an unrequested inactive Project scope idle", async () => {
    invokeMock.mockImplementation((channel: string) => {
      expect(channel).toBe("workspace:tasks:list");
      return Promise.resolve(makeWindow([]));
    });
    const { hook } = createHarness(makeWindowPort({ kind: "project", projectId: "alpha" }), {
      projects: [makeProject("alpha"), makeProject("beta")],
      expandedProjectIds: new Set(),
    });

    expect(hook.result.current.collectionsByProject.beta.state).toEqual({ kind: "idle" });
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state.kind).toBe("ready");
    });
    expect(invokeMock.mock.calls.some(([, projectId]) => projectId === "beta")).toBe(false);
  });

  test("exposes a scope-local error that can be retried", async () => {
    let alphaAttempt = 0;
    invokeMock.mockImplementation((channel: string, projectId: string | null) => {
      expect(channel).toBe("workspace:tasks:list");
      if (projectId === null) return Promise.resolve(makeWindow([]));
      alphaAttempt += 1;
      if (alphaAttempt === 1) {
        return Promise.reject(new Error("Alpha is temporarily unavailable"));
      }
      return Promise.resolve(makeWindow([]));
    });
    const { hook } = createHarness(
      makeWindowPort({
        kind: "project",
        projectId: "alpha",
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state).toEqual({
        kind: "error",
        message: "Alpha is temporarily unavailable",
      });
    });

    await act(async () => {
      await hook.result.current.retryCollection("alpha");
    });
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state.kind).toBe("ready");
    });
  });

  test("keeps cached rows ready through a failing background refresh", async () => {
    let refreshAlpha = false;
    let rejectRefresh: ((reason: Error) => void) | null = null;
    invokeMock.mockImplementation((channel: string, projectId: string | null) => {
      expect(channel).toBe("workspace:tasks:list");
      if (projectId === null) return Promise.resolve(makeWindow([]));
      if (!refreshAlpha) {
        return Promise.resolve(makeWindow([makeSummary("session:alpha", "alpha")]));
      }
      return new Promise<ProjectSessionSummaryWindow>((_resolve, reject) => {
        rejectRefresh = reject;
      });
    });
    const { client, hook } = createHarness(
      makeWindowPort({
        kind: "project",
        projectId: "alpha",
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state.kind).toBe("ready");
    });
    refreshAlpha = true;
    act(() => {
      void client.invalidateQueries({
        queryKey: queryKeys.projectSessions.summaries("alpha"),
        exact: true,
      });
    });
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state).toEqual({
        kind: "ready",
        refreshing: true,
        refreshError: null,
      });
    });
    expect(hook.result.current.collectionsByProject.alpha.projections).toHaveLength(1);

    await act(async () => {
      rejectRefresh?.(new Error("Refresh failed"));
    });
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state).toEqual({
        kind: "ready",
        refreshing: false,
        refreshError: "Refresh failed",
      });
    });
    expect(hook.result.current.collectionsByProject.alpha.projections[0]?.id).toBe("session:alpha");
  });

  test("does not let an older in-flight TaskWindow refetch overwrite a committed refresh", async () => {
    let alphaReads = 0;
    let resolveOlderRefetch!: (window: ProjectSessionSummaryWindow) => void;
    invokeMock.mockImplementation((channel: string, projectId: string | null) => {
      expect(channel).toBe("workspace:tasks:list");
      if (projectId === null) return Promise.resolve(makeWindow([]));
      alphaReads += 1;
      if (alphaReads === 1) {
        return Promise.resolve(
          makeWindow([makeSummary("session:alpha", "alpha")], { projectionRevision: 1 }),
        );
      }
      if (alphaReads === 2) {
        return new Promise<ProjectSessionSummaryWindow>((resolve) => {
          resolveOlderRefetch = resolve;
        });
      }
      return Promise.resolve(
        makeWindow([makeSummary("session:beta", "alpha"), makeSummary("session:alpha", "alpha")], {
          projectionRevision: 2,
        }),
      );
    });
    const { client, hook } = createHarness(makeWindowPort());
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.projectionRevision).toBe(1);
    });

    let olderRefetch!: Promise<void>;
    act(() => {
      olderRefetch = client.invalidateQueries({
        queryKey: queryKeys.projectSessions.summaries("alpha"),
        exact: true,
      });
    });
    await waitFor(() => {
      expect(alphaReads).toBe(2);
    });
    await act(async () => {
      await hook.result.current.refreshThrough("alpha", 2);
    });
    await act(async () => {
      resolveOlderRefetch(
        makeWindow([makeSummary("session:alpha", "alpha")], { projectionRevision: 1 }),
      );
      await olderRefetch;
    });

    expect(
      client.getQueryData<ProjectSessionSummaryWindow>(
        queryKeys.projectSessions.summaries("alpha"),
      ),
    ).toEqual(
      makeWindow([makeSummary("session:beta", "alpha"), makeSummary("session:alpha", "alpha")], {
        projectionRevision: 2,
      }),
    );
    await waitFor(() => {
      expect(
        hook.result.current.collectionsByProject.alpha.projections.map(
          (projection) => projection.id,
        ),
      ).toEqual(["session:beta", "session:alpha"]);
    });
  });

  test("hydrates selected detail while preserving an explicit window view", async () => {
    const persistedView = materializeInitialWorkbenchSessionView({
      id: "session:alpha",
      projectId: "alpha",
      databaseViewId: null,
    });
    const persistedScene = applyLegacySessionViewToWorkbenchScene(
      materializeInitialWorkbenchScene({
        kind: "session",
        sessionId: "session:alpha",
      }),
      persistedView,
    );
    const window = {
      ...makeWindowPort(),
      scenesByOwnerKey: {
        [makeWorkbenchSceneKey({
          kind: "session",
          sessionId: "session:alpha",
        })]: persistedScene,
      },
    };
    const thread = {
      threadId: "thread:alpha",
      cwd: "/work/alpha",
      executionProfile: null,
      backendBinding: { kind: "codex" },
      managedWorktreePath: null,
      projectlessOutputDirectory: null,
      projectlessWorkspaceBrowserRoot: null,
    } as ProjectSession["thread"];
    const summary = makeSummary("session:alpha", "alpha", {
      thread: {
        threadId: "thread:alpha",
        cwd: "/work/alpha",
      } as ProjectSessionSummary["thread"],
    });
    const detail: ProjectSession = {
      ...summary,
      thread: {
        ...thread,
      } as NonNullable<ProjectSession["thread"]>,
    };
    invokeMock.mockImplementation((channel: string, value: string | null) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow(value === "alpha" ? [summary] : []));
      }
      if (channel === "project-sessions:get") {
        return Promise.resolve(detail);
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const { hook } = createHarness(window);

    await waitFor(() => {
      expect(hook.result.current.active?.domain.thread?.threadId).toBe("thread:alpha");
    });
    expect(hook.result.current.active?.scene).toStrictEqual(persistedScene);
    expect(window.setScene).not.toHaveBeenCalled();
  });

  test("hydrates the exact selected Session outside the bounded summary window", async () => {
    const selected = makeSummary("session:beyond-first-window", "alpha") as ProjectSession;
    const firstSummary = makeSummary("session:first", "alpha");
    invokeMock.mockImplementation((channel: string, value: string | null) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow(value === "alpha" ? [firstSummary] : []));
      }
      if (channel === "project-sessions:get") {
        expect(value).toBe("session:beyond-first-window");
        return Promise.resolve(selected);
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const window = makeWindowPort({
      kind: "session",
      sessionId: "session:beyond-first-window",
      projectContextId: "alpha",
    });
    const { hook } = createHarness(window);

    await waitFor(() => {
      expect(hook.result.current.active?.domain.id).toBe("session:beyond-first-window");
    });
    expect(hook.result.current.active?.domain.id).not.toBe("session:first");
    expect(window.reconcileMissingSession).not.toHaveBeenCalled();
  });

  test("reconciles only an authoritative missing exact Session", async () => {
    invokeMock.mockImplementation((channel: string, value: string | null) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(
          makeWindow(value === "alpha" ? [makeSummary("session:first", "alpha")] : []),
        );
      }
      if (channel === "project-sessions:get") return Promise.resolve(null);
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const window = makeWindowPort({
      kind: "session",
      sessionId: "session:missing",
      projectContextId: "alpha",
    });
    const { hook } = createHarness(window);

    await waitFor(() => {
      expect(window.reconcileMissingSession).toHaveBeenCalledWith("session:missing");
    });
    expect(hook.result.current.active).toBeNull();
  });

  test("keeps exact location on a transient detail error", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow([]));
      }
      if (channel === "project-sessions:get") {
        return Promise.reject(new Error("temporary outage"));
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const window = makeWindowPort({
      kind: "session",
      sessionId: "session:restore",
      projectContextId: "alpha",
    });
    const { hook } = createHarness(window);

    await waitFor(() => {
      expect(hook.result.current.selectedDetailError).toBe("temporary outage");
    });
    expect(window.reconcileMissingSession).not.toHaveBeenCalled();
    expect(window.location).toEqual({
      kind: "session",
      sessionId: "session:restore",
      projectContextId: "alpha",
    });
  });

  test("prefetches detail without fetching a full session list or board", async () => {
    const detail = makeSummary("session:alpha", "alpha") as ProjectSession;
    invokeMock.mockImplementation((channel: string, value: string | null) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(
          makeWindow(value === "alpha" ? [makeSummary("session:alpha", "alpha")] : []),
        );
      }
      if (channel === "project-sessions:get") return Promise.resolve(detail);
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const { hook } = createHarness(makeWindowPort());
    await waitFor(() => {
      expect(hook.result.current.selectedDetailReady).toBe(true);
    });

    await act(async () => {
      await hook.result.current.prefetch("session:alpha");
    });

    expect(invokeMock).toHaveBeenCalledWith("project-sessions:get", "session:alpha");
    expect(
      invokeMock.mock.calls.some(
        ([channel]) => channel === "project-sessions:list" || channel === "boards:by-project",
      ),
    ).toBe(false);
  });

  test("appends a bounded continuation without duplicating summaries", async () => {
    invokeMock.mockImplementation(
      (channel: string, projectId: string | null, input?: { after?: string }) => {
        if (channel !== "workspace:tasks:list") {
          throw new Error(`Unexpected channel: ${channel}`);
        }
        if (projectId === null) return Promise.resolve(makeWindow([]));
        if (input?.after === "cursor:one") {
          return Promise.resolve(
            makeWindow([
              makeSummary("session:alpha", "alpha"),
              makeSummary("session:beta", "alpha"),
            ]),
          );
        }
        return Promise.resolve(
          makeWindow([makeSummary("session:alpha", "alpha")], {
            hasMore: true,
            nextCursor: "cursor:one",
          }),
        );
      },
    );
    const { client, hook } = createHarness(makeWindowPort());
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.hasMore).toBe(true);
    });

    await act(async () => {
      await hook.result.current.loadMore("alpha");
    });

    expect(
      client
        .getQueryData<ProjectSessionSummaryWindow>(queryKeys.projectSessions.summaries("alpha"))
        ?.items.map((item) => item.id),
    ).toEqual(["session:alpha", "session:beta"]);
  });

  test("ignores a continuation from an older projection after the first page advances", async () => {
    let resolveContinuation!: (window: ProjectSessionSummaryWindow) => void;
    invokeMock.mockImplementation(
      (channel: string, projectId: string | null, input?: { after?: string }) => {
        if (channel !== "workspace:tasks:list") {
          throw new Error(`Unexpected channel: ${channel}`);
        }
        if (projectId === null) return Promise.resolve(makeWindow([]));
        if (input?.after === "cursor:one") {
          return new Promise<ProjectSessionSummaryWindow>((resolve) => {
            resolveContinuation = resolve;
          });
        }
        return Promise.resolve(
          makeWindow([makeSummary("session:alpha", "alpha")], {
            hasMore: true,
            nextCursor: "cursor:one",
            projectionRevision: 1,
          }),
        );
      },
    );
    const { client, hook } = createHarness(makeWindowPort());
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.hasMore).toBe(true);
    });

    let loadMore!: Promise<void>;
    act(() => {
      loadMore = hook.result.current.loadMore("alpha");
    });
    client.setQueryData<ProjectSessionSummaryWindow>(
      queryKeys.projectSessions.summaries("alpha"),
      makeWindow([makeSummary("session:beta", "alpha")], {
        hasMore: true,
        nextCursor: "cursor:one",
        projectionRevision: 2,
      }),
    );
    await act(async () => {
      resolveContinuation(
        makeWindow([makeSummary("session:stale", "alpha")], { projectionRevision: 1 }),
      );
      await loadMore;
    });

    expect(
      client
        .getQueryData<ProjectSessionSummaryWindow>(queryKeys.projectSessions.summaries("alpha"))
        ?.items.map((item) => item.id),
    ).toEqual(["session:beta"]);
    expect(
      client.getQueryData<ProjectSessionSummaryWindow>(queryKeys.projectSessions.summaries("alpha"))
        ?.projectionRevision,
    ).toBe(2);
  });

  test("seeds mutation responses in the Query detail cache", async () => {
    const current = makeSummary("session:alpha", "alpha") as ProjectSession;
    const updated = { ...current, unread: true };
    invokeMock.mockImplementation((channel: string, value: string | null) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow(value === "alpha" ? [current] : []));
      }
      if (channel === "project-sessions:get") {
        return Promise.resolve(current);
      }
      if (channel === "project-sessions:mark-unread") {
        return Promise.resolve(updated);
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const { client, hook } = createHarness(makeWindowPort());
    await waitFor(() => {
      expect(hook.result.current.selectedDetailReady).toBe(true);
    });

    await act(async () => {
      await hook.result.current.markUnread(current, true);
    });

    expect(
      client.getQueryData<ProjectSession>(queryKeys.projectSessions.detail(current.id))?.unread,
    ).toBe(true);
  });

  test("does not let a failed pin operation roll a newer cache update back", async () => {
    const current = makeSummary("session:alpha", "alpha") as ProjectSession;
    let rejectPin!: (error: Error) => void;
    invokeMock.mockImplementation((channel: string, value: string | null) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow(value === "alpha" ? [current] : []));
      }
      if (channel === "project-sessions:get") return Promise.resolve(current);
      if (channel === "project-sessions:set-pinned") {
        return new Promise<ProjectSession>((_resolve, reject) => {
          rejectPin = reject;
        });
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const { client, hook } = createHarness(makeWindowPort());
    await waitFor(() => {
      expect(hook.result.current.selectedDetailReady).toBe(true);
    });

    let pinRequest!: Promise<ProjectSession | null>;
    act(() => {
      pinRequest = hook.result.current.setPinned(current, true);
    });
    await waitFor(() => {
      expect(
        client.getQueryData<ProjectSession>(queryKeys.projectSessions.detail(current.id))?.pinned,
      ).toBe(true);
    });

    const newer = {
      ...current,
      displayTitle: "Newer title",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const newerWindow = makeWindow([newer], { projectionRevision: 2 });
    act(() => {
      client.setQueryData(queryKeys.projectSessions.detail(current.id), newer);
      client.setQueryData(queryKeys.projectSessions.summaries("alpha"), newerWindow);
    });

    const failure = new Error("pin failed");
    await act(async () => {
      rejectPin(failure);
      await expect(pinRequest).rejects.toBe(failure);
    });

    expect(
      client.getQueryData<ProjectSession>(queryKeys.projectSessions.detail(current.id)),
    ).toEqual(newer);
    expect(
      client.getQueryData<ProjectSessionSummaryWindow>(
        queryKeys.projectSessions.summaries("alpha"),
      ),
    ).toEqual(newerWindow);
  });

  test("selects projectless sessions through the WindowState command port", async () => {
    invokeMock.mockImplementation((channel: string, projectId: string | null) => {
      if (channel !== "workspace:tasks:list") {
        throw new Error(`Unexpected channel: ${channel}`);
      }
      return Promise.resolve(
        makeWindow(
          projectId === null
            ? [makeSummary("session:projectless", null)]
            : [makeSummary("session:alpha", "alpha")],
        ),
      );
    });
    const window = makeWindowPort();
    const { hook } = createHarness(window);
    await waitFor(() => {
      expect(hook.result.current.selectedDetailReady).toBe(true);
    });

    act(() => {
      hook.result.current.select(hook.result.current.projectlessCollection.presentations[0]);
    });

    expect(window.selectSession).toHaveBeenCalledWith({
      id: "session:projectless",
      projectId: null,
    });
  });

  test("ensures the Core-owned default draft without scanning ordinary threadless Sessions", async () => {
    const ordinary = makeSummary("session:page-chat", "alpha", {
      displayTitle: "Page workspace",
    });
    const ensured = makeSummary("session:default", "alpha", {
      noThreadFallbackTitle: "New chat",
      displayTitle: "New chat",
    }) as ProjectSession;
    invokeMock.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow([ordinary]));
      }
      if (channel === "project-sessions:ensure-default-draft") {
        expect(args).toEqual(["alpha"]);
        return Promise.resolve(ensured);
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const window = makeWindowPort({ kind: "project", projectId: "alpha" });
    const { client, hook } = createHarness(window);
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state.kind).toBe("ready");
    });

    let presentation!: Awaited<ReturnType<typeof hook.result.current.ensureDefaultDraft>>;
    await act(async () => {
      presentation = await hook.result.current.ensureDefaultDraft("alpha");
    });

    expect(presentation.domain.id).toBe("session:default");
    expect(
      client.getQueryData<ProjectSession>(queryKeys.projectSessions.detail("session:default"))?.id,
    ).toBe("session:default");
    expect(invokeMock.mock.calls.some(([channel]) => channel === "project-sessions:get")).toBe(
      false,
    );
  });

  test("commits canonical Session order for a pre-thread New Chat", async () => {
    const chat = makeSummary("session:chat", "alpha", { order: 0 });
    const draft = makeSummary("session:draft", "alpha", {
      displayTitle: "New chat",
      order: 1,
    });
    let canonical = [chat, draft];
    let projectionRevision = 1;
    invokeMock.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow(canonical, { projectionRevision }));
      }
      if (channel === "project-sessions:reorder") {
        expect(args).toEqual(["alpha", ["session:draft", "session:chat"]]);
        canonical = [
          { ...draft, order: 0 },
          { ...chat, order: 1 },
        ];
        projectionRevision += 1;
        return Promise.resolve();
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const { hook } = createHarness(makeWindowPort({ kind: "project", projectId: "alpha" }));
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.presentations).toHaveLength(2);
    });

    await act(async () => {
      await hook.result.current.reorder("alpha", ["session:draft", "session:chat"]);
    });

    await waitFor(() => {
      expect(
        hook.result.current.collectionsByProject.alpha.presentations.map(
          (presentation) => presentation.domain.id,
        ),
      ).toEqual(["session:draft", "session:chat"]);
    });
  });

  test("creates explicitly ordinary Sessions with the caller's title snapshot", async () => {
    const created = makeSummary("session:page-chat", "alpha", {
      noThreadFallbackTitle: "Roadmap",
      displayTitle: "Roadmap",
    }) as ProjectSession;
    invokeMock.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "workspace:tasks:list") {
        return Promise.resolve(makeWindow([]));
      }
      if (channel === "project-sessions:create") {
        expect(args).toEqual([
          {
            projectId: "alpha",
            noThreadFallbackTitle: "Roadmap",
            initialPageIds: [],
          },
        ]);
        return Promise.resolve(created);
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const window = makeWindowPort({ kind: "project", projectId: "alpha" });
    const { hook } = createHarness(window);
    await waitFor(() => {
      expect(hook.result.current.collectionsByProject.alpha.state.kind).toBe("ready");
    });

    let presentation!: Awaited<ReturnType<typeof hook.result.current.createOrdinarySession>>;
    await act(async () => {
      presentation = await hook.result.current.createOrdinarySession("alpha", "Roadmap");
    });

    expect(presentation.domain.id).toBe("session:page-chat");
  });
});
