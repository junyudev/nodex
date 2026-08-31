import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexSidebarPinnedReorderMutation,
  buildSidebarThreadSyncModel,
  isCodexSidebarThreadItemReorderable,
  listReorderableCodexSidebarChatKeys,
  listPendingPinnedBeforeThreadUpdates,
  listRealThreadIdsForSidebarKeys,
  mergeVisibleCodexPinnedThreadOrder,
  mergePendingWorktreesIntoSidebarSnapshot,
  orderCodexSidebarPinnedThreadKeys,
  resolveCodexSidebarThreadHomeContainerId,
  sortSidebarThreadKeysForDisplay,
} from "./codex-sidebar-thread-sync";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import type {
  CodexSidebarSnapshot,
  CodexSidebarThreadItem,
  Project,
  ProjectSession,
} from "./types";

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    description: null,
    icon: null,
    sources: [{ root: `/work/${id}` }],
    primaryWorkspaceRoot: `/work/${id}`,
    created: new Date("2026-01-01T00:00:00.000Z"),
    updated: new Date("2026-01-01T00:00:00.000Z"),
    pinned: false,
    pinnedOrder: null,
  } as unknown as Project;
}

function makeThread(input: {
  threadId: string;
  projectId: string | null;
  parentThreadId?: string | null;
  pinned?: boolean;
  updatedAt?: number;
  recencyAt?: number | null;
}): CodexSidebarThreadItem {
  return {
    key: `local:${input.threadId}`,
    kind: "local",
    backendBinding: { kind: "codex" },
    runLocation: { kind: "local-checkout" },
    hostId: "local",
    threadId: input.threadId,
    parentThreadId: input.parentThreadId ?? null,
    sessionId: `session:${input.threadId}`,
    projectId: input.projectId,
    title: input.threadId,
    preview: "",
    cwd: input.projectId ? `/work/${input.projectId}` : null,
    updatedAt: input.updatedAt ?? 0,
    recencyAt: input.recencyAt === undefined ? (input.updatedAt ?? 0) : input.recencyAt,
    createdAt: 0,
    pinned: input.pinned === true,
    pinnedOrder: input.pinned === true ? 0 : null,
    unread: false,
    archived: false,
    statusType: "notLoaded",
    statusActiveFlags: [],
    projectless: input.projectId === null,
    disabled: false,
  };
}

function makeSnapshot(items: CodexSidebarThreadItem[]): CodexSidebarSnapshot {
  return {
    items,
    pinnedThreadIds: items.filter((item) => item.pinned).map((item) => item.threadId),
    projectAssignments: Object.fromEntries(
      items
        .filter(
          (item): item is CodexSidebarThreadItem & { projectId: string } =>
            typeof item.projectId === "string",
        )
        .map((item) => [item.threadId, item.projectId]),
    ),
    projectlessThreadIds: items.filter((item) => item.projectless).map((item) => item.threadId),
    generatedAt: 1,
  };
}

function makePendingThreadItem(input: {
  key: string;
  id: string;
  anchor: string | null;
  pinned?: boolean;
}): CodexSidebarThreadItem {
  return {
    ...makeThread({
      threadId: `client-new-thread:${input.id}`,
      projectId: null,
      pinned: input.pinned ?? true,
    }),
    key: input.key,
    kind: "pending-worktree",
    runLocation: { kind: "local-worktree", path: null, phase: "pending" },
    pendingWorktreeId: `pending:${input.id}`,
    clientThreadId: `client-new-thread:${input.id}`,
    pinnedBeforeThreadId: input.anchor,
    sessionId: null,
  };
}

function makeSession(input: {
  id: string;
  order: number;
  pinned?: boolean;
  pinnedOrder?: number | null;
  updatedAt?: string;
}): ProjectSession {
  return {
    id: input.id,
    projectId: "alpha",
    noThreadFallbackTitle: input.id,
    displayTitle: input.id,
    order: input.order,
    pinned: input.pinned === true,
    pinnedOrder: input.pinnedOrder ?? null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("buildSidebarThreadSyncModel", () => {
  test("separates pinned, unpinned, project, and projectless rows", () => {
    const alpha = makeProject("alpha", "Alpha");
    const beta = makeProject("beta", "Beta");
    const pinned = makeThread({ threadId: "thread-pinned", projectId: "alpha", pinned: true });
    const alphaRecent = makeThread({ threadId: "thread-alpha", projectId: "alpha", updatedAt: 20 });
    const betaRecent = makeThread({ threadId: "thread-beta", projectId: "beta", updatedAt: 10 });
    const projectless = makeThread({ threadId: "thread-free", projectId: null, updatedAt: 5 });

    const model = buildSidebarThreadSyncModel({
      snapshot: makeSnapshot([pinned, alphaRecent, betaRecent, projectless]),
      projects: [alpha, beta],
    });

    expect(JSON.stringify(model.pinnedThreadKeys)).toBe(JSON.stringify(["local:thread-pinned"]));
    expect(JSON.stringify(model.projectGroups[0]?.pinnedThreadKeys)).toBe(
      JSON.stringify(["local:thread-pinned"]),
    );
    expect(JSON.stringify(model.projectGroups[0]?.threadKeys)).toBe(
      JSON.stringify(["local:thread-alpha"]),
    );
    expect(JSON.stringify(model.projectGroups[1]?.pinnedThreadKeys)).toBe(JSON.stringify([]));
    expect(JSON.stringify(model.projectGroups[1]?.threadKeys)).toBe(
      JSON.stringify(["local:thread-beta"]),
    );
    expect(JSON.stringify(model.projectlessThreadKeys)).toBe(JSON.stringify(["local:thread-free"]));
  });

  test("keeps local child threads out of every sidebar projection", () => {
    const root = makeThread({ threadId: "thread-root", projectId: null });
    const child = makeThread({
      threadId: "thread-child",
      projectId: null,
      parentThreadId: "thread-root",
      pinned: true,
    });
    const remote = {
      ...makeThread({
        threadId: "thread-remote",
        projectId: null,
        parentThreadId: "thread-root",
      }),
      kind: "remote" as const,
      hostId: "remote-host",
      runLocation: { kind: "remote-checkout" as const, hostId: "remote-host" },
    };

    const model = buildSidebarThreadSyncModel({
      snapshot: makeSnapshot([root, child, remote]),
      projects: [],
    });

    expect(model.snapshot.items.map((item) => item.threadId)).toEqual([
      "thread-root",
      "thread-remote",
    ]);
    expect([...model.threadItemsByKey.keys()]).toEqual([
      "local:thread-root",
      "local:thread-remote",
    ]);
    expect(model.pinnedThreadKeys).toEqual([]);
    expect(model.projectlessThreadKeys).toEqual(["local:thread-root", "local:thread-remote"]);
  });

  test("projects pending worktrees with exact phase, attention, pin, and route identity", () => {
    const base = {
      id: "local:pending-1",
      hostId: "local",
      label: "Pending task",
      sourceWorkspaceRoot: "/work/alpha",
      startingState: { type: "branch", branchName: "main" } as const,
      localEnvironmentConfigPath: null,
      prompt: "Do it",
      launchMode: "start-conversation" as const,
      clientThreadId: "client-new-thread:one",
      startConversationParamsInput: {
        input: [],
        commentAttachments: [],
        workspaceRoots: ["/work/alpha"],
        cwd: "/work/alpha",
        fileAttachments: [],
        addedFiles: [],
        agentMode: "auto" as const,
        permissionProfileId: undefined,
        shouldSendPermissionOverrides: true as const,
        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode: null,
        config: {},
        threadSource: "subagent" as const,
        workspaceKind: "project" as const,
        serviceName: undefined,
        projectAssignment: {
          projectKind: "local" as const,
          projectId: "alpha",
          pendingCoreUpdate: false as const,
        },
      },
      sourceConversationId: null,
      sourceCollaborationMode: null,
      createdAt: 10,
      attempt: 1,
      labelEdited: false,
      worktreeOutputText: "",
      setupOutputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      isPinned: true,
      pinnedBeforeThreadId: null,
    };
    const phases = [
      { phase: "creating", needsAttention: false, status: "active", unread: false, path: null },
      {
        phase: "setting-up",
        needsAttention: false,
        status: "idle",
        unread: false,
        path: "/worktrees/alpha",
      },
      {
        phase: "worktree-ready",
        needsAttention: false,
        status: "idle",
        unread: false,
        path: "/worktrees/alpha",
      },
      { phase: "failed", needsAttention: true, status: "systemError", unread: true, path: null },
    ] as const;

    for (const phase of phases) {
      const snapshot = mergePendingWorktreesIntoSidebarSnapshot(makeSnapshot([]), [
        {
          ...base,
          phase: phase.phase,
          needsAttention: phase.needsAttention,
          worktreeWorkspaceRoot: phase.path,
          worktreeGitRoot: phase.path,
        } as CodexPendingWorktreeEntry,
      ]);
      const item = snapshot.items[0];
      expect(item?.threadId).toBe("client-new-thread:one");
      expect(item?.pendingWorktreeId).toBe("local:pending-1");
      expect(item?.statusType).toBe(phase.status);
      expect(item?.unread).toBe(phase.unread);
      expect(item?.pinned).toBe(true);
      expect(item?.runLocation).toEqual({
        kind: "local-worktree",
        path: phase.path,
        phase: phase.path ? "ready" : "pending",
      });
    }
  });

  test("keeps one stable client-thread key and lets the realized conversation win", () => {
    const realized = {
      ...makeThread({ threadId: "conversation-1", projectId: "alpha" }),
      key: "local:client-new-thread:one",
      clientThreadId: "client-new-thread:one",
    };
    const pending = {
      id: "pending-1",
      hostId: "local",
      label: "Pending task",
      sourceWorkspaceRoot: "/work/alpha",
      startingState: { type: "branch", branchName: "main" } as const,
      localEnvironmentConfigPath: null,
      prompt: "Do it",
      launchMode: "start-conversation" as const,
      clientThreadId: "client-new-thread:one",
      startConversationParamsInput: {
        input: [],
        commentAttachments: [],
        workspaceRoots: ["/work/alpha"],
        cwd: "/work/alpha",
        fileAttachments: [],
        addedFiles: [],
        agentMode: "auto" as const,
        permissionProfileId: undefined,
        shouldSendPermissionOverrides: true as const,
        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode: null,
        config: {},
        threadSource: "subagent" as const,
        workspaceKind: "project" as const,
        projectAssignment: {
          projectKind: "local" as const,
          projectId: "alpha",
          pendingCoreUpdate: false as const,
        },
        serviceName: undefined,
      },
      sourceConversationId: null,
      sourceCollaborationMode: null,
      createdAt: 10,
      attempt: 1,
      phase: "creating" as const,
      labelEdited: false,
      worktreeOutputText: "",
      setupOutputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
      isPinned: false,
      pinnedBeforeThreadId: null,
    } satisfies CodexPendingWorktreeEntry;

    const merged = mergePendingWorktreesIntoSidebarSnapshot(makeSnapshot([realized]), [pending]);
    expect(merged.items.length).toBe(1);
    expect(merged.items[0]?.key).toBe("local:client-new-thread:one");
    expect(merged.items[0]?.kind).toBe("local");
    expect(merged.items[0]?.threadId).toBe("conversation-1");
  });
});

describe("pending-aware pinned thread order", () => {
  test("inserts anchor, null, missing, and remote-compatible pending buckets exactly", () => {
    const a = { ...makeThread({ threadId: "A", projectId: null, pinned: true }), key: "local:A" };
    const remote = {
      ...makeThread({ threadId: "R", projectId: null, pinned: true }),
      key: "remote:R",
      kind: "remote" as const,
      hostId: "remote-host",
      runLocation: { kind: "remote-checkout" as const, hostId: "remote-host" },
    };
    const pendingA2 = makePendingThreadItem({ key: "local:p2", id: "p2", anchor: "A" });
    const pendingA1 = makePendingThreadItem({ key: "local:p1", id: "p1", anchor: "A" });
    const pendingRemote = makePendingThreadItem({ key: "local:pR", id: "pR", anchor: "R" });
    const pendingNull = makePendingThreadItem({ key: "local:pN", id: "pN", anchor: null });
    const pendingMissing = makePendingThreadItem({ key: "local:pX", id: "pX", anchor: "X" });
    const items = [pendingA2, pendingMissing, pendingA1, pendingRemote, pendingNull, a, remote];
    const itemsByKey = new Map(items.map((item) => [item.key, item] as const));

    const ordered = orderCodexSidebarPinnedThreadKeys({
      threadKeys: items.map((item) => item.key),
      pinnedThreadIds: ["A", "R"],
      itemsByKey,
    });

    expect(JSON.stringify(ordered)).toBe(
      JSON.stringify([
        "local:p2",
        "local:p1",
        "local:A",
        "local:pR",
        "remote:R",
        "local:pN",
        "local:pX",
      ]),
    );
  });

  test("places an anchored pending row even when its realized row is unloaded", () => {
    const b = { ...makeThread({ threadId: "B", projectId: null, pinned: true }), key: "local:B" };
    const pendingA = makePendingThreadItem({ key: "local:pA", id: "pA", anchor: "A" });
    const pendingB = makePendingThreadItem({ key: "local:pB", id: "pB", anchor: "B" });
    const itemsByKey = new Map([pendingA, pendingB, b].map((item) => [item.key, item] as const));

    expect(
      JSON.stringify(
        orderCodexSidebarPinnedThreadKeys({
          threadKeys: [pendingA.key, pendingB.key, b.key],
          pinnedThreadIds: ["A", "B"],
          itemsByKey,
        }),
      ),
    ).toBe(JSON.stringify([pendingA.key, pendingB.key, b.key]));
  });

  test("derives changed pending anchors from the next realized local or remote row", () => {
    const a = { ...makeThread({ threadId: "A", projectId: null, pinned: true }), key: "local:A" };
    const remote = {
      ...makeThread({ threadId: "R", projectId: null, pinned: true }),
      key: "remote:R",
      kind: "remote" as const,
      hostId: "remote-host",
      runLocation: { kind: "remote-checkout" as const, hostId: "remote-host" },
    };
    const pending1 = makePendingThreadItem({ key: "local:p1", id: "p1", anchor: "A" });
    const pending2 = makePendingThreadItem({ key: "local:p2", id: "p2", anchor: "R" });
    const items = [a, remote, pending1, pending2];
    const itemsByKey = new Map(items.map((item) => [item.key, item] as const));
    const nextKeys = [a.key, pending1.key, pending2.key, remote.key];

    expect(
      JSON.stringify(
        listPendingPinnedBeforeThreadUpdates({
          sortablePinnedThreadKeys: nextKeys,
          itemsByKey,
        }),
      ),
    ).toBe(JSON.stringify([{ pendingWorktreeId: "pending:p1", beforeThreadId: "R" }]));
    expect(JSON.stringify(listRealThreadIdsForSidebarKeys(nextKeys, itemsByKey))).toBe(
      JSON.stringify(["A", "R"]),
    );
  });

  test("replaces only visible realized slots and leaves hidden pinned ids in place", () => {
    const a = { ...makeThread({ threadId: "A", projectId: null, pinned: true }), key: "local:A" };
    const b = { ...makeThread({ threadId: "B", projectId: null, pinned: true }), key: "local:B" };
    const pending = makePendingThreadItem({ key: "local:p", id: "p", anchor: "B" });
    const items = [a, b, pending];
    const itemsByKey = new Map(items.map((item) => [item.key, item] as const));

    expect(
      JSON.stringify(
        mergeVisibleCodexPinnedThreadOrder({
          pinnedThreadIds: ["A", "hidden", "B"],
          visibleThreadKeys: [a.key, pending.key, b.key],
          nextVisibleThreadKeys: [b.key, pending.key, a.key],
          itemsByKey,
        }),
      ),
    ).toBe(JSON.stringify(["B", "hidden", "A"]));
  });

  test("separates pending anchor writes from the persisted realized order", () => {
    const a = { ...makeThread({ threadId: "A", projectId: null, pinned: true }), key: "local:A" };
    const b = { ...makeThread({ threadId: "B", projectId: null, pinned: true }), key: "local:B" };
    const pending = makePendingThreadItem({ key: "local:p", id: "p", anchor: "B" });
    const items = [a, b, pending];
    const itemsByKey = new Map(items.map((item) => [item.key, item] as const));

    const mutation = buildCodexSidebarPinnedReorderMutation({
      pinnedThreadIds: ["A", "hidden", "B"],
      visibleThreadKeys: [pending.key, a.key, b.key],
      nextVisibleThreadKeys: [b.key, pending.key, a.key],
      itemsByKey,
    });

    expect(JSON.stringify(mutation.pendingUpdates)).toBe(
      JSON.stringify([{ pendingWorktreeId: "pending:p", beforeThreadId: "A" }]),
    );
    expect(JSON.stringify(mutation.pinnedThreadIds)).toBe(JSON.stringify(["B", "hidden", "A"]));
  });

  test("keeps the realized order payload when only a pending anchor changes", () => {
    const a = { ...makeThread({ threadId: "A", projectId: null, pinned: true }), key: "local:A" };
    const b = { ...makeThread({ threadId: "B", projectId: null, pinned: true }), key: "local:B" };
    const pending = makePendingThreadItem({ key: "local:p", id: "p", anchor: "A" });
    const itemsByKey = new Map([a, b, pending].map((item) => [item.key, item] as const));

    const mutation = buildCodexSidebarPinnedReorderMutation({
      pinnedThreadIds: ["A", "B"],
      visibleThreadKeys: [pending.key, a.key, b.key],
      nextVisibleThreadKeys: [a.key, pending.key, b.key],
      itemsByKey,
    });

    expect(JSON.stringify(mutation.pendingUpdates)).toBe(
      JSON.stringify([{ pendingWorktreeId: "pending:p", beforeThreadId: "B" }]),
    );
    expect(JSON.stringify(mutation.pinnedThreadIds)).toBe(JSON.stringify(["A", "B"]));
  });
});

describe("sortSidebarThreadKeysForDisplay", () => {
  test("orders attached Threads by conversation recency instead of metadata time", () => {
    const metadataRecent = makeThread({
      threadId: "thread-metadata",
      projectId: "alpha",
      updatedAt: 300,
      recencyAt: 100,
    });
    const conversationRecent = makeThread({
      threadId: "thread-conversation",
      projectId: "alpha",
      updatedAt: 200,
      recencyAt: 200,
    });
    const itemsByKey = new Map([
      [metadataRecent.key, metadataRecent],
      [conversationRecent.key, conversationRecent],
    ]);

    expect(
      sortSidebarThreadKeysForDisplay({
        threadKeys: [metadataRecent.key, conversationRecent.key],
        itemsByKey,
        sessionsById: new Map(),
      }),
    ).toEqual([conversationRecent.key, metadataRecent.key]);
  });

  test("sorts snapshot and fallback rows with one display comparator", () => {
    const olderSnapshotThread = makeThread({
      threadId: "thread-older",
      projectId: "alpha",
      updatedAt: 100,
    });
    const newFallbackThread = {
      ...makeThread({
        threadId: "session-new",
        projectId: "alpha",
        updatedAt: 200,
      }),
      key: "local:session:session-new",
      sessionId: "session-new",
      title: "New thread",
    };
    const itemsByKey = new Map([
      [olderSnapshotThread.key, olderSnapshotThread],
      [newFallbackThread.key, newFallbackThread],
    ]);
    const sessionsById = new Map([
      [
        "session:thread-older",
        makeSession({
          id: "session:thread-older",
          order: 1,
        }),
      ],
      [
        "session-new",
        makeSession({
          id: "session-new",
          order: 0,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    ]);

    const sorted = sortSidebarThreadKeysForDisplay({
      threadKeys: [olderSnapshotThread.key, newFallbackThread.key],
      itemsByKey,
      sessionsById,
    });

    expect(JSON.stringify(sorted)).toBe(
      JSON.stringify([newFallbackThread.key, olderSnapshotThread.key]),
    );
  });

  test("sorts pinned fallback rows by pinned order instead of append order", () => {
    const pinnedSnapshotThread = makeThread({
      threadId: "thread-pinned",
      projectId: "alpha",
      pinned: true,
      updatedAt: 200,
    });
    pinnedSnapshotThread.pinnedOrder = 3;
    const databaseView = {
      ...makeThread({
        threadId: "session-database-view",
        projectId: "alpha",
        pinned: true,
        updatedAt: 100,
      }),
      key: "local:session:session-database-view",
      sessionId: "session-database-view",
      title: "Database View",
      pinnedOrder: 0,
    };
    const itemsByKey = new Map([
      [pinnedSnapshotThread.key, pinnedSnapshotThread],
      [databaseView.key, databaseView],
    ]);
    const sessionsById = new Map([
      [
        "session:thread-pinned",
        makeSession({
          id: "session:thread-pinned",
          order: 1,
          pinned: true,
          pinnedOrder: 3,
        }),
      ],
      [
        "session-database-view",
        makeSession({
          id: "session-database-view",
          order: 0,
          pinned: true,
          pinnedOrder: 0,
        }),
      ],
    ]);

    const sorted = sortSidebarThreadKeysForDisplay({
      threadKeys: [pinnedSnapshotThread.key, databaseView.key],
      itemsByKey,
      sessionsById,
    });

    expect(JSON.stringify(sorted)).toBe(
      JSON.stringify([databaseView.key, pinnedSnapshotThread.key]),
    );
  });
});

describe("project thread reorder eligibility", () => {
  test("enables child DnD for durable threads without requiring loaded session detail", () => {
    expect(
      JSON.stringify(
        listReorderableCodexSidebarChatKeys({
          visibleThreadKeys: ["thread:a", "pending:x", "thread:b"],
          getSessionId: (threadKey) => (threadKey.startsWith("thread:") ? threadKey : null),
        }),
      ),
    ).toBe(JSON.stringify(["thread:a", "thread:b"]));
  });

  test("keeps ACP Threads out of Codex-owned move and reorder commands", () => {
    const acp: CodexSidebarThreadItem = {
      ...makeThread({ threadId: "thread:acp", projectId: "alpha" }),
      backendBinding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-main",
      },
    };

    expect(isCodexSidebarThreadItemReorderable(acp)).toBe(false);
    expect(
      isCodexSidebarThreadItemReorderable(
        makeThread({ threadId: "thread:codex", projectId: "alpha" }),
      ),
    ).toBe(true);
  });
});

describe("resolveCodexSidebarThreadHomeContainerId", () => {
  const knownProjectIds = new Set(["alpha"]);

  test("keeps membership and pin state as independent sidebar dimensions", () => {
    expect(
      resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: true,
        projectId: "alpha",
        projectless: false,
        knownProjectIds,
      }),
    ).toBe("project-pinned:alpha");
    expect(
      resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: false,
        projectId: "alpha",
        projectless: false,
        knownProjectIds,
      }),
    ).toBe("project:alpha");
    expect(
      resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: true,
        projectId: null,
        projectless: true,
        knownProjectIds,
      }),
    ).toBe("pinned");
    expect(
      resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: false,
        projectId: null,
        projectless: true,
        knownProjectIds,
      }),
    ).toBe("chats");
  });

  test("falls back only unknown pinned projects to the global pinned lane", () => {
    expect(
      resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: true,
        projectId: "missing",
        projectless: false,
        knownProjectIds,
      }),
    ).toBe("pinned");
    expect(
      resolveCodexSidebarThreadHomeContainerId({
        kind: "local",
        pinned: false,
        projectId: "missing",
        projectless: false,
        knownProjectIds,
      }),
    ).toBe(null);
  });
});
