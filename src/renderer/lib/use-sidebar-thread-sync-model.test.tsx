import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { act, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import type {
  CodexHostMessage,
  CodexSidebarSnapshot,
  CodexSidebarSyncResult,
  Project,
} from "./types";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { useSidebarThreadSyncModel } from "./use-sidebar-thread-sync-model";
import { installWindowApi } from "../test/browser-globals";
import { render } from "../test/dom";
import { createTestQueryClient, TestQueryProvider } from "../test/query";
import { queryKeys } from "./query-keys";

let invokeCalls: unknown[][] = [];
let hostMessageListener: ((message: CodexHostMessage) => void) | null = null;
let projectSessionListeners: Array<{
  listener: (event: ProjectSessionsChangeEvent) => void;
}> = [];
let syncResult: CodexSidebarSyncResult;

const emptySnapshot: CodexSidebarSnapshot = {
  items: [],
  pinnedThreadIds: [],
  projectAssignments: {},
  projectlessThreadIds: [],
  generatedAt: 1,
};

function makeProject(id: string): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: id,
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [{ root: `/work/${id}`, order: 0 }],
    primaryWorkspaceRoot: `/work/${id}`,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-01-01T00:00:00.000Z"),
    updated: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeSyncResult(
  input: {
    snapshot?: CodexSidebarSnapshot;
    changedProjectIds?: string[];
    projectlessChanged?: boolean;
    materializedSessionIds?: string[];
  } = {},
): CodexSidebarSyncResult {
  return {
    snapshot: input.snapshot ?? emptySnapshot,
    source: "core",
    refreshed: false,
    refreshedAt: 0,
    changedProjectIds: input.changedProjectIds ?? [],
    projectlessChanged: input.projectlessChanged ?? false,
    materializedSessionIds: input.materializedSessionIds ?? [],
    failedThreadIds: [],
  };
}

type SidebarThreadSyncActions = Pick<
  ReturnType<typeof useSidebarThreadSyncModel>,
  "applySnapshot" | "refresh" | "reorderPinned" | "setPinned"
>;

function Harness(props: {
  projects: Project[];
  onSnapshot: (snapshot: CodexSidebarSnapshot) => void;
  onActions?: (actions: SidebarThreadSyncActions) => void;
  onReorderPinned?: (
    reorder: (orderedThreadIds: readonly string[]) => Promise<CodexSidebarSnapshot>,
  ) => void;
}) {
  const { onActions, onReorderPinned, onSnapshot, projects } = props;
  const state = useSidebarThreadSyncModel({
    projects,
  });
  useEffect(() => {
    onSnapshot(state.snapshot);
  }, [onSnapshot, state.snapshot]);
  useEffect(() => {
    onReorderPinned?.(state.reorderPinned);
  }, [onReorderPinned, state.reorderPinned]);
  useEffect(() => {
    onActions?.({
      applySnapshot: state.applySnapshot,
      refresh: state.refresh,
      reorderPinned: state.reorderPinned,
      setPinned: state.setPinned,
    });
  }, [onActions, state.applySnapshot, state.refresh, state.reorderPinned, state.setPinned]);
  return createElement("div", { "data-count": state.snapshot.items.length });
}

describe("useSidebarThreadSyncModel", () => {
  beforeEach(() => {
    syncResult = makeSyncResult();
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        invokeCalls.push([channel, ...args]);
        if (channel === "codex:sidebar:snapshot") return emptySnapshot;
        if (channel === "codex:sidebar:sync") return syncResult;
        if (channel === "codex:threads:pinned:set") return syncResult.snapshot;
        if (channel === "codex:threads:pinned:reorder") return syncResult.snapshot;
        return null;
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        if (channel === "codex:host-message") {
          hostMessageListener = (message) => listener(message);
          return () => {
            hostMessageListener = null;
          };
        }
        if (channel === "project-sessions-changed") {
          const sessionListener = (event: ProjectSessionsChangeEvent) => listener(event);
          projectSessionListeners.push({
            listener: sessionListener,
          });
          return () => {
            projectSessionListeners = projectSessionListeners.filter(
              (entry) => entry.listener !== sessionListener,
            );
          };
        }
        return () => undefined;
      },
    });
  });

  afterEach(() => {
    invokeCalls = [];
    hostMessageListener = null;
    projectSessionListeners = [];
    syncResult = makeSyncResult();
  });

  test("applies sidebarSyncUpdated host messages without scheduling another sync", async () => {
    syncResult = makeSyncResult();
    const snapshots: CodexSidebarSnapshot[] = [];
    render(
      createElement(TestQueryProvider, {
        client: createTestQueryClient(),
        children: createElement(Harness, {
          projects: [makeProject("alpha"), makeProject("beta")],
          onSnapshot: (snapshot) => snapshots.push(snapshot),
        }),
      }),
    );
    await waitFor(() => {
      if (hostMessageListener === null) throw new Error("missing host listener");
    });
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "codex:sidebar:sync" &&
          (call[1] as { policy?: string } | undefined)?.policy === "force" &&
          (call[1] as { reason?: string } | undefined)?.reason === "mount",
      ),
    ).toBe(false);
    snapshots.length = 0;
    const callsBeforeMessage = invokeCalls.length;
    const broadcastResult = makeSyncResult({
      snapshot: {
        ...emptySnapshot,
        projectAssignments: { thr_beta: "beta" },
        generatedAt: 2,
      },
      changedProjectIds: ["beta"],
      materializedSessionIds: ["session_beta"],
    });

    await act(async () => {
      hostMessageListener?.({
        type: "sidebarSyncUpdated",
        hostId: "local",
        result: broadcastResult,
        reason: "host-message",
      });
      await Promise.resolve();
    });

    expect(invokeCalls.length).toBe(callsBeforeMessage);
    await waitFor(() => {
      if (snapshots[snapshots.length - 1]?.projectAssignments.thr_beta !== "beta") {
        throw new Error("missing beta snapshot");
      }
    });
  });

  test("persists the exact realized pinned-thread order through the sidebar boundary", async () => {
    let reorderPinned:
      | ((orderedThreadIds: readonly string[]) => Promise<CodexSidebarSnapshot>)
      | null = null;
    render(
      createElement(TestQueryProvider, {
        client: createTestQueryClient(),
        children: createElement(Harness, {
          projects: [makeProject("alpha")],
          onSnapshot: () => undefined,
          onReorderPinned: (reorder) => {
            reorderPinned = reorder;
          },
        }),
      }),
    );
    await waitFor(() => {
      expect(reorderPinned !== null).toBe(true);
    });

    await act(async () => {
      await reorderPinned?.(["thread-b", "thread-a"]);
    });

    expect(
      invokeCalls.some(
        (call) =>
          JSON.stringify(call) ===
          JSON.stringify(["codex:threads:pinned:reorder", ["thread-b", "thread-a"]]),
      ),
    ).toBe(true);
  });

  test("keeps sidebar mutation actions stable across snapshot updates", async () => {
    const actionSnapshots: SidebarThreadSyncActions[] = [];
    const snapshots: CodexSidebarSnapshot[] = [];
    render(
      createElement(TestQueryProvider, {
        client: createTestQueryClient(),
        children: createElement(Harness, {
          projects: [makeProject("alpha")],
          onSnapshot: (snapshot) => snapshots.push(snapshot),
          onActions: (actions) => actionSnapshots.push(actions),
        }),
      }),
    );
    await waitFor(() => {
      if (hostMessageListener === null || actionSnapshots.length === 0) {
        throw new Error("missing sidebar sync harness state");
      }
    });
    const initialActions = actionSnapshots.at(-1);
    const nextSnapshot: CodexSidebarSnapshot = {
      ...emptySnapshot,
      generatedAt: 2,
      projectAssignments: { thread_alpha: "alpha" },
    };

    await act(async () => {
      hostMessageListener?.({
        type: "sidebarSyncUpdated",
        hostId: "local",
        result: makeSyncResult({ snapshot: nextSnapshot }),
        reason: "host-message",
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      if (snapshots.at(-1)?.generatedAt !== 2) throw new Error("missing updated snapshot");
    });

    const updatedActions = actionSnapshots.at(-1);
    expect(updatedActions?.applySnapshot).toBe(initialActions?.applySnapshot);
    expect(updatedActions?.refresh).toBe(initialActions?.refresh);
    expect(updatedActions?.reorderPinned).toBe(initialActions?.reorderPinned);
    expect(updatedActions?.setPinned).toBe(initialActions?.setPinned);
  });

  test("invalidates all explicit Session scopes through one global subscription", async () => {
    syncResult = makeSyncResult();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.projectSessions.summaries("beta"), []);
    queryClient.setQueryData(queryKeys.projectSessions.summaries(null), []);
    queryClient.setQueryData(queryKeys.projectSessions.summaries("beta", "builtin"), []);
    queryClient.setQueryData(queryKeys.projectSessions.summaries(null, "builtin"), []);
    queryClient.setQueryData(queryKeys.projectSessions.detail("session-beta"), {});
    render(
      createElement(TestQueryProvider, {
        client: queryClient,
        children: createElement(Harness, {
          projects: [makeProject("alpha"), makeProject("beta")],
          onSnapshot: () => undefined,
        }),
      }),
    );
    await waitFor(() => {
      if (projectSessionListeners.length !== 1) {
        throw new Error("missing project session listeners");
      }
    });
    const callsBeforeEvent = invokeCalls.length;

    await act(async () => {
      projectSessionListeners[0]?.listener({
        summaryScopes: [{ kind: "project", projectId: "beta" }, { kind: "projectless" }],
        detailInvalidation: {
          kind: "sessions",
          sessionIds: ["session-beta"],
        },
        changeType: "update",
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryState(queryKeys.projectSessions.summaries("beta"))?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(queryKeys.projectSessions.summaries(null))?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(queryKeys.projectSessions.summaries("beta", "builtin"))
          ?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(queryKeys.projectSessions.summaries(null, "builtin"))
          ?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(queryKeys.projectSessions.detail("session-beta"))?.isInvalidated,
      ).toBe(true);
    });
    expect(invokeCalls.length).toBe(callsBeforeEvent);
  });
});
