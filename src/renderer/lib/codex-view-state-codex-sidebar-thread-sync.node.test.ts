import { describe, expect, test } from "vite-plus/test";
import {
  buildSidebarThreadSyncModel,
  mergePendingWorktreesIntoSidebarSnapshot,
  orderCodexSidebarPinnedThreadKeys,
  orderSidebarPinnedSessionKeys,
  resolveCodexSidebarThreadHomeContainerId,
  sortSidebarThreadKeysForDisplay,
} from "./codex-sidebar-thread-sync";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import type {
  CodexSidebarSnapshot,
  CodexSidebarThreadItem,
  Project,
  ProjectSession,
  CodexModelOption,
} from "./types";
import {
  closestCodexAccentPreset,
  getCodexAccentStyle,
  getCodexThemeVariantStyle,
  normalizeCodexAccentColor,
  parseCodexAccent,
  renderCodexAppThemes,
  resolveEffectiveCodexAccent,
  type CodexAccentPreset,
} from "./codex-theme-variant";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  formatCodexThreadDetailLevelLabel,
  readCodexThreadSettings,
  resolveCodexDefaultThreadSettings,
  resolveCodexModelSelection,
  resolveCodexReasoningEffortOptions,
  resolveCodexThreadDetailLevel,
  THREAD_SETTINGS_STORAGE_KEY,
} from "./codex-thread-settings";

describe("codex sidebar thread sync", () => {
  function makeProject(id: string, name: string): Project {
    return {
      id,
      name,
      description: null,
      icon: null,
      sources: [{ kind: "directory" as const, path: `/work/${id}`, order: 0 }],
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
      backendBinding: { driver: "codex", instanceId: "codex" },
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
      snoozedUntil: null,
      snoozedAt: null,
      wokeAt: null,
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
      sessionId: null,
    };
  }

  function makeSession(input: {
    id: string;
    activityAt: number;
    pinned?: boolean;
    pinnedOrder?: number | null;
    updatedAt?: string;
  }): ProjectSession {
    return {
      id: input.id,
      projectId: "alpha",
      noThreadFallbackTitle: input.id,
      displayTitle: input.id,
      activityAt: input.activityAt,
      managed: false,
      pinned: input.pinned === true,
      pinnedOrder: input.pinnedOrder ?? null,
      archived: false,
      archivedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      wokeAt: null,
      pageTurn: null,
      canManage: true,
      canStop: true,
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
      const alphaRecent = makeThread({
        threadId: "thread-alpha",
        projectId: "alpha",
        updatedAt: 20,
      });
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
      expect(JSON.stringify(model.projectlessThreadKeys)).toBe(
        JSON.stringify(["local:thread-free"]),
      );
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
        firstSubmission: {
          launchId: "01991e60-b800-7000-8000-000000000101",
          clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
        },
        clientThreadId: "client-new-thread:one",
        startConversationParamsInput: {
          input: [],
          commentAttachments: [],
          workspaceRoots: ["/work/alpha"],
          cwd: "/work/alpha",
          fileAttachments: [],
          addedFiles: [],

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
        firstSubmission: {
          launchId: "01991e60-b800-7000-8000-000000000101",
          clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
        },
        clientThreadId: "client-new-thread:one",
        startConversationParamsInput: {
          input: [],
          commentAttachments: [],
          workspaceRoots: ["/work/alpha"],
          cwd: "/work/alpha",
          fileAttachments: [],
          addedFiles: [],

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
      } satisfies CodexPendingWorktreeEntry;

      const merged = mergePendingWorktreesIntoSidebarSnapshot(makeSnapshot([realized]), [pending]);
      expect(merged.items.length).toBe(1);
      expect(merged.items[0]?.key).toBe("local:client-new-thread:one");
      expect(merged.items[0]?.kind).toBe("local");
      expect(merged.items[0]?.threadId).toBe("conversation-1");
    });
  });

  describe("pending-aware pinned thread order", () => {
    test("keeps pending pins in input order after the realized pins", () => {
      const a = { ...makeThread({ threadId: "A", projectId: null, pinned: true }), key: "local:A" };
      const remote = {
        ...makeThread({ threadId: "R", projectId: null, pinned: true }),
        key: "remote:R",
        kind: "remote" as const,
        hostId: "remote-host",
        runLocation: { kind: "remote-checkout" as const, hostId: "remote-host" },
      };
      const pending2 = makePendingThreadItem({ key: "local:p2", id: "p2" });
      const pending1 = makePendingThreadItem({ key: "local:p1", id: "p1" });
      const unpinned = makePendingThreadItem({ key: "local:unpinned", id: "up", pinned: false });
      const items = [pending2, remote, unpinned, pending1, a];
      const itemsByKey = new Map(items.map((item) => [item.key, item] as const));

      const ordered = orderCodexSidebarPinnedThreadKeys({
        threadKeys: items.map((item) => item.key),
        pinnedThreadIds: ["A", "unloaded", "R"],
        itemsByKey,
      });

      expect(ordered).toEqual([a.key, remote.key, pending2.key, pending1.key]);
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
            activityAt: 100,
          }),
        ],
        [
          "session-new",
          makeSession({
            id: "session-new",
            activityAt: 200,
            updatedAt: "2026-01-01T00:00:01.000Z",
          }),
        ],
      ]);

      const sorted = sortSidebarThreadKeysForDisplay({
        threadKeys: [olderSnapshotThread.key, newFallbackThread.key],
        itemsByKey,
        sessionsById,
      });

      expect(sorted).toEqual([newFallbackThread.key, olderSnapshotThread.key]);
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
            activityAt: 1,
            pinned: true,
            pinnedOrder: 3,
          }),
        ],
        [
          "session-database-view",
          makeSession({
            id: "session-database-view",
            activityAt: 0,
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

  describe("durable Session pin order", () => {
    test("uses Session order across draft and attached rows before pending pins", () => {
      const attached = {
        ...makeThread({ threadId: "attached", projectId: null, pinned: true }),
        pinnedOrder: 0,
      };
      const draft = {
        ...makeThread({ threadId: "draft", projectId: null, pinned: true }),
        pinnedOrder: 9,
      };
      const pending = makePendingThreadItem({
        key: "local:pending",
        id: "pending",
      });
      const items = [attached, pending, draft];
      const sessionsById = new Map([
        [
          attached.sessionId!,
          makeSession({ id: attached.sessionId!, activityAt: 1, pinned: true, pinnedOrder: 2 }),
        ],
        [
          draft.sessionId!,
          makeSession({ id: draft.sessionId!, activityAt: 0, pinned: true, pinnedOrder: 0 }),
        ],
      ]);
      expect(
        orderSidebarPinnedSessionKeys({
          threadKeys: items.map((item) => item.key),
          itemsByKey: new Map(items.map((item) => [item.key, item])),
          sessionsById,
        }),
      ).toEqual([draft.key, attached.key, pending.key]);
    });
  });
});

describe("codex theme variant", () => {
  describe("getCodexThemeVariantStyle", () => {
    test("defines the runtime semantic control and foreground tokens for light", () => {
      const styles = getCodexThemeVariantStyle("light");

      expect(styles["--app-color-background-control"]).toBe("rgba(255, 255, 255, 0.96)");
      expect(styles["--color-background-control-opaque"]).toBe("rgb(255, 255, 255)");
      expect(styles["--app-color-accent-blue"]).toBe("#3a83f7");
      expect(styles["--app-color-text-foreground"]).toBe("#0d0d0d");
      expect(styles["--app-color-background-surface"]).toBe("#ffffff");
      expect(styles["--app-color-background-surface-under"]).toBe("#f5f5f5");
      expect(styles["--app-color-border"]).toBe("rgba(13, 13, 13, 0.078)");
      expect(styles["--cursor-interaction"]).toBe("pointer");
      expect(styles["--app-color-background-elevated-tertiary-opaque"]).toBe("#f3f3f3");
    });

    test("defines the runtime semantic control and foreground tokens for dark", () => {
      const styles = getCodexThemeVariantStyle("dark");

      expect(styles["--app-color-background-control"]).toBe("rgba(38, 38, 38, 0.96)");
      expect(styles["--color-background-control-opaque"]).toBe("rgb(38, 38, 38)");
      expect(styles["--app-color-accent-blue"]).toBe("#3a83f7");
      expect(styles["--app-color-background-surface"]).toBe("#111111");
      expect(styles["--app-color-text-foreground"]).toBe("#fcfcfc");
      expect(styles["--app-color-text-foreground-secondary"]).toBe("rgba(252, 252, 252, 0.71)");
      expect(styles["--app-color-text-foreground-tertiary"]).toBe("rgba(252, 252, 252, 0.498)");
      expect(styles["--app-color-border"]).toBe("rgba(252, 252, 252, 0.084)");
      expect(styles["--app-color-background-button-primary"]).toBe("rgb(9, 9, 9)");
      expect(styles["--app-color-background-surface-under"]).toBe("#0e0e0e");
      expect(styles["--color-background-panel"]).toBe("#1c1c1c");
      expect(styles["--color-background-composer-action-bar"]).toBe("#212121");
      expect(styles["--app-color-background-editor-opaque"]).toBe("rgb(33, 33, 33)");
      expect(styles["--app-color-background-elevated-primary-opaque"]).toBe("rgb(47, 47, 47)");
      expect(styles["--cursor-interaction"]).toBe("pointer");
      expect(styles["--app-color-background-elevated-tertiary-opaque"]).toBe("rgb(33, 33, 33)");
    });

    test("resolves conversation accent roles independently from generic button roles", () => {
      const light = getCodexThemeVariantStyle("light");
      const dark = getCodexThemeVariantStyle("dark");

      expect(light["--color-background-composer-primary"]).toBe("#000000");
      expect(dark["--color-background-composer-primary"]).toBe("#ffffff");
      expect(light["--color-background-user-message"]).toBe("rgb(233 233 233 / 50%)");
      expect(dark["--color-background-user-message"]).toBe("rgb(50 50 50 / 85%)");
      expect(light["--color-background-text-selection"]).toBe("#539af859");
      expect(dark["--color-background-text-selection"]).toBe("#63a8f866");
      expect(light["--app-color-decoration-deleted"]).toBe("#e02e2a");
      expect(dark["--app-color-decoration-added"]).toBe("#00a240");
    });
  });

  describe("accent preferences", () => {
    test("resolves selected Default to Blue and preserves explicit monochrome and custom colors", () => {
      expect(resolveEffectiveCodexAccent()).toEqual({ kind: "preset", name: "blue" });
      expect(resolveEffectiveCodexAccent({ kind: "preset", name: "default" })).toEqual({
        kind: "preset",
        name: "blue",
      });
      expect(resolveEffectiveCodexAccent({ kind: "preset", name: "black" })).toEqual({
        kind: "preset",
        name: "black",
      });
      expect(resolveEffectiveCodexAccent({ kind: "custom", color: "#ABC123" })).toEqual({
        kind: "custom",
        color: "#abc123",
      });
    });

    test("accepts explicit presets and normalized six-digit custom colors", () => {
      expect(parseCodexAccent({ kind: "preset", name: "black" })).toEqual({
        kind: "preset",
        name: "black",
      });
      expect(parseCodexAccent({ kind: "custom", color: "  #AbC123  " })).toEqual({
        kind: "custom",
        color: "#abc123",
      });
      expect(normalizeCodexAccentColor(" #00FF00 ")).toBe("#00ff00");
    });

    test.each([
      null,
      "blue",
      {},
      { kind: "preset", name: "red" },
      { kind: "custom", color: "#abc" },
      { kind: "custom", color: "#12345678" },
      { kind: "custom", color: "blue" },
    ])("defaults invalid persisted accent preferences: %j", (value) =>
      expect(parseCodexAccent(value)).toEqual({ kind: "preset", name: "default" }),
    );

    test("classifies custom hues for charts without replacing the exact selected color", () => {
      expect(closestCodexAccentPreset("#3a83f7")).toBe("blue");
      expect(closestCodexAccentPreset("#a67df2")).toBe("purple");
      expect(closestCodexAccentPreset("#787878")).toBe("black");
      expect(closestCodexAccentPreset("invalid")).toBeNull();
      const styles = getCodexThemeVariantStyle("light", { kind: "custom", color: "#0a72e5" });
      expect(styles["--codex-base-accent"]).toBe("#0a72e5");
      expect(styles["--color-chart-sequential-1"]).toBe("var(--blue-75)");
    });
  });

  const presetCases: Array<{
    name: CodexAccentPreset;
    accent: string;
    submit: [string, string];
    link: [string, string];
    message: [string, string];
    selection: [string, string];
  }> = [
    {
      name: "default",
      accent: "#3a83f7",
      submit: ["#000000", "#ffffff"],
      link: ["#2c67c5", "#2c67c5"],
      message: ["rgb(233 233 233 / 50%)", "rgb(50 50 50 / 85%)"],
      selection: ["#539af859", "#63a8f866"],
    },
    {
      name: "blue",
      accent: "#3a83f7",
      submit: ["#2c67c5", "#2c67c5"],
      link: ["#2c67c5", "#2c67c5"],
      message: ["#e8f3fe", "#173e76"],
      selection: ["#539af859", "#3a83f799"],
    },
    {
      name: "green",
      accent: "#53b559",
      submit: ["#53b559", "#48a04c"],
      link: ["#48a04c", "#48a04c"],
      message: ["#def3e5", "#2c6732"],
      selection: ["#6bc67f59", "#53b55999"],
    },
    {
      name: "yellow",
      accent: "#f6c543",
      submit: ["#f6c543", "#d9a337"],
      link: ["#b8802b", "#f6c543"],
      message: ["#fdf6dc", "#95611f"],
      selection: ["#f8d45d59", "#f6c54380"],
    },
    {
      name: "pink",
      accent: "#f077af",
      submit: ["#f077af", "#f077af"],
      link: ["#cf6194", "#f077af"],
      message: ["#fdedf4", "#873e60"],
      selection: ["#f68ebc59", "#f077af99"],
    },
    {
      name: "orange",
      accent: "#ee7c37",
      submit: ["#ee7c37", "#d25e28"],
      link: ["#d25e28", "#ee7c37"],
      message: ["#fbe8db", "#87401d"],
      selection: ["#ef8b5759", "#ee7c3799"],
    },
    {
      name: "purple",
      accent: "#a67df2",
      submit: ["#8952ee", "#7849d1"],
      link: ["#7849d1", "#7849d1"],
      message: ["#ede5fc", "#4e2f88"],
      selection: ["#a67df259", "#8952ee99"],
    },
    {
      name: "black",
      accent: "#3a83f7",
      submit: ["#000000", "#ffffff"],
      link: ["#2c67c5", "#2c67c5"],
      message: ["#000000", "rgb(50 50 50 / 85%)"],
      selection: ["#afafaf66", "color-mix(in srgb, var(--color-text) 32%, transparent)"],
    },
  ];

  describe("accent role projection", () => {
    test.each(["light", "dark"] as const)(
      "applies selected Default as Blue and keeps explicit Black/White distinct in %s",
      (variant) => {
        const blue = getCodexThemeVariantStyle(variant, resolveEffectiveCodexAccent());
        expect(blue["--color-background-composer-primary"]).toBe("#2c67c5");
        expect(blue["--color-text-composer-primary"]).toBe("#ffffff");
        expect(blue["--color-background-user-message"]).toBe(
          variant === "light" ? "#e8f3fe" : "#173e76",
        );

        const black = getCodexThemeVariantStyle(variant, { kind: "preset", name: "black" });
        expect(black["--color-background-composer-primary"]).toBe(
          variant === "light" ? "#000000" : "#ffffff",
        );
        expect(black["--color-background-user-message"]).toBe(
          variant === "light" ? "#000000" : "rgb(50 50 50 / 85%)",
        );
      },
    );

    test.each(presetCases)(
      "projects $name conversation, focus, link, and selection roles in both appearances",
      ({ name, accent, submit, link, message, selection }) => {
        for (const [index, variant] of (["light", "dark"] as const).entries()) {
          const styles = getCodexAccentStyle(variant, { kind: "preset", name });
          expect(styles["--codex-base-accent"]).toBe(accent);
          expect(styles["--app-color-border-focus"]).toBe(accent);
          expect(styles["--color-background-composer-primary"]).toBe(submit[index]);
          expect(styles["--app-color-text-accent"]).toBe(link[index]);
          expect(styles["--color-background-user-message"]).toBe(message[index]);
          expect(styles["--color-background-text-selection"]).toBe(selection[index]);
        }
      },
    );

    test("can keep user messages neutral without discarding a named accent", () => {
      const styles = getCodexAccentStyle("dark", { kind: "preset", name: "green" }, false);
      expect(styles["--color-background-user-message"]).toBe("rgb(50 50 50 / 85%)");
      expect(styles["--color-text-user-message"]).toBe("#ffffff");
      expect(styles["--color-background-composer-primary"]).toBe("#48a04c");
      expect(styles["--app-color-text-accent"]).toBe("#48a04c");
    });

    test.each([
      ["#ffffff", "rgb(0, 0, 0)"],
      ["#000000", "rgb(255, 255, 255)"],
      ["#3a83f7", "rgb(0, 0, 0)"],
      ["#0169cc", "rgb(255, 255, 255)"],
      ["#008cff", "rgb(255, 255, 255)"],
      ["#3f77e1", "rgb(255, 255, 255)"],
      ["#757575", "rgb(255, 255, 255)"],
      ["#767676", "rgb(0, 0, 0)"],
      ["#00ff00", "rgb(0, 0, 0)"],
    ])("chooses readable ink for custom accent %s", (color, ink) => {
      const styles = getCodexAccentStyle("light", { kind: "custom", color });
      expect(styles["--app-color-text-on-accent"]).toBe(ink);
      expect(styles["--app-color-text-unread-badge"]).toBe(ink);
    });

    test("uses semantic neutral conversation roles for an exact custom accent", () => {
      const styles = getCodexAccentStyle("light", { kind: "custom", color: "#dc229a" });
      expect(styles["--app-color-border-focus"]).toBe("#dc229a");
      expect(styles["--app-color-text-accent"]).toBe("#dc229a");
      expect(styles["--color-background-composer-primary"]).toBe(
        "var(--color-background-primary-solid)",
      );
      expect(styles["--color-background-user-message"]).toBe(
        "color-mix(in oklab, var(--color-text) 5%, transparent)",
      );
      expect(styles["--color-background-text-selection"]).toBe("var(--color-background-info-soft)");
      expect(styles["--color-background-attribution-highlight"]).toBe(
        "var(--color-background-info-soft)",
      );
    });
  });

  test("serializes both supplied palettes for document roots and nested appearance scopes", () => {
    expect(
      renderCodexAppThemes({
        light: { "--surface": "#ffffff", "--accent": "#365b9d" },
        dark: { "--surface": "#111111", "--accent": "#df5142" },
      }),
    )
      .toBe(`@layer theme {:where(:root:not([data-codex-window-type="extension"]))[data-theme="light"], :where(:root:not([data-codex-window-type="extension"])) [data-theme="light"] {--surface:#ffffff;
--accent:#365b9d;}
:where(:root:not([data-codex-window-type="extension"]))[data-theme="dark"], :where(:root:not([data-codex-window-type="extension"])) [data-theme="dark"] {--surface:#111111;
--accent:#df5142;}}`);
  });
});

describe("codex thread settings", () => {
  const MODELS: CodexModelOption[] = [
    {
      id: "gpt-5.3-codex",
      model: "gpt-5.3-codex",
      displayName: "GPT-5.3-Codex",
      description: "Default coding model",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Lower effort" },
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep reasoning" },
      ],
      defaultReasoningEffort: "high",
      inputModalities: ["text", "image"],
      multiAgentVersion: null,
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
    },
    {
      id: "gpt-5-codex-mini",
      model: "gpt-5-codex-mini",
      displayName: "GPT-5-Codex Mini",
      description: "Fast small model",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "minimal", description: "Minimal" },
        { reasoningEffort: "low", description: "Lower effort" },
      ],
      defaultReasoningEffort: "minimal",
      inputModalities: ["text", "image"],
      multiAgentVersion: null,
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: false,
    },
  ];

  describe("codex-thread-settings", () => {
    test("reads only the detail level, ignoring models and efforts saved by earlier versions", () => {
      const storageGlobal = globalThis as unknown as {
        localStorage?: {
          getItem: (key: string) => string | null;
          setItem: (key: string, value: string) => void;
          removeItem: (key: string) => void;
        };
      };
      const previousLocalStorage = storageGlobal.localStorage;
      const store = new Map<string, string>();
      storageGlobal.localStorage = {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => {
          store.set(key, value);
        },
        removeItem: (key) => {
          store.delete(key);
        },
      };

      try {
        store.set(
          THREAD_SETTINGS_STORAGE_KEY,
          JSON.stringify({ model: "gpt-5.3-codex", reasoningEffort: "high" }),
        );
        expect(readCodexThreadSettings()).toBeNull();

        store.set(
          THREAD_SETTINGS_STORAGE_KEY,
          JSON.stringify({ model: "gpt-5.3-codex", detailLevel: "invalid-detail-level" }),
        );
        expect(readCodexThreadSettings()).toBeNull();

        store.set(
          THREAD_SETTINGS_STORAGE_KEY,
          JSON.stringify({ model: "gpt-5.3-codex", detailLevel: "STEPS_PROSE" }),
        );
        expect(readCodexThreadSettings()).toEqual({ detailLevel: "STEPS_PROSE" });
      } finally {
        if (previousLocalStorage) {
          storageGlobal.localStorage = previousLocalStorage;
        } else {
          delete storageGlobal.localStorage;
        }
      }
    });

    test("defaults to the default model and its preferred reasoning effort", () => {
      const settings = resolveCodexDefaultThreadSettings(MODELS);

      expect(settings.model).toBe("gpt-5.3-codex");
      expect(settings.reasoningEffort).toBe("high");
    });

    test("omits a model while the selector list is unavailable", () => {
      expect(resolveCodexDefaultThreadSettings([])).toEqual({ model: "", reasoningEffort: "high" });
    });

    test("resolves shared model selections from visible defaults", () => {
      const selection = resolveCodexModelSelection({
        model: "retired-model",
        reasoningEffort: "max",
        models: MODELS,
        fallbackReasoningEffort: "medium",
      });

      expect(selection.model).toBe("gpt-5.3-codex");
      expect(selection.reasoningEffort).toBe("high");
    });

    test("matches persisted model aliases against visible model entries", () => {
      const selection = resolveCodexModelSelection({
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
        models: [
          ...MODELS,
          {
            id: "mini-id",
            model: "gpt-5.4-mini",
            displayName: "GPT-5.4 Mini",
            description: "Alias row",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "minimal", description: "Minimal" },
              { reasoningEffort: "low", description: "Lower effort" },
            ],
            defaultReasoningEffort: "minimal",
            inputModalities: ["text", "image"],
            multiAgentVersion: null,
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
          },
        ],
      });

      expect(selection.model).toBe("mini-id");
      expect(selection.reasoningEffort).toBe("minimal");
    });

    test("clamps unsupported reasoning effort when the selected model changes", () => {
      const selection = resolveCodexModelSelection({
        model: "gpt-5-codex-mini",
        reasoningEffort: "high",
        models: MODELS,
        fallbackReasoningEffort: "high",
        preferHighReasoning: true,
      });

      expect(selection.model).toBe("gpt-5-codex-mini");
      expect(selection.reasoningEffort).toBe("minimal");
    });

    test("resolves reasoning effort options from the selected model", () => {
      const options = resolveCodexReasoningEffortOptions("gpt-5-codex-mini", MODELS);

      expect(options.length).toBe(2);
      expect(options[0]?.reasoningEffort).toBe("minimal");
      expect(options[1]?.reasoningEffort).toBe("low");
    });

    test("formats fallback labels for the composer controls", () => {
      expect(formatCodexModelLabel("gpt-5.3-codex", MODELS)).toBe("GPT-5.3 Codex");
      expect(formatCodexModelLabel(undefined, MODELS)).toBe("Default model");
      expect(
        formatCodexModelLabel("gpt-5.1-codex-max", [
          ...MODELS,
          {
            id: "gpt-5.1-codex-max",
            model: "gpt-5.1-codex-max",
            displayName: "gpt-5.1-codex-max",
            description: "Alias missing from runtime",
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "high",
            inputModalities: ["text", "image"],
            multiAgentVersion: null,
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
          },
        ]),
      ).toBe("GPT-5.1 Codex Max");
      expect(formatCodexModelLabel("gpt-6-astra", [])).toBe("GPT-6 Astra");
      expect(formatCodexModelLabel("claude-opus-5-5", [])).toBe("Claude Opus 5.5");
      expect(
        formatCodexModelLabel("gpt-6-astra", [
          { ...MODELS[0]!, id: "gpt-6-astra", displayName: "GPT-6-Astra" },
        ]),
      ).toBe("GPT-6 Astra");
      expect(formatCodexReasoningEffortLabel("max")).toBe("Max");
      expect(formatCodexReasoningEffortLabel("low")).toBe("Light");
      expect(formatCodexReasoningEffortLabel("xhigh")).toBe("Extra High");
      expect(formatCodexReasoningEffortLabel("future_effort")).toBe("Future Effort");
      expect(formatCodexThreadDetailLevelLabel("STEPS_EXECUTION")).toBe("Steps with code output");
      expect(resolveCodexThreadDetailLevel(undefined)).toBe("STEPS_COMMANDS");
    });
  });
});
