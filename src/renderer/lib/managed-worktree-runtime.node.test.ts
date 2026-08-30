import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  definitions: [] as unknown[],
  invoke: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("./renderer-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("./renderer-command")>();
  return {
    ...original,
    defineRendererCommand: (definition: unknown) => {
      mocks.definitions.push(definition);
      return original.defineRendererCommand(definition as never);
    },
  };
});

vi.mock("./api", () => ({
  subscribeCodexPendingWorktreesChanged: mocks.subscribe,
}));

import {
  listWorktreeEnvironmentConfigs,
  listWorktreeEnvironmentConfigsForWorkspace,
  managedWorktreeSettingsService,
  restoreManagedWorktree,
  saveWorktreeEnvironmentConfig,
} from "./managed-worktree-runtime";
import {
  consumeForkSidePanelTransfer,
  createPendingWorktree,
  pendingWorktreeRouteTransport,
  setPendingWorktreePinnedBeforeThread,
} from "./pending-worktree-runtime";

describe("managed Worktree renderer owners", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    vi.stubGlobal("window", { api: { invoke: mocks.invoke } });
  });

  const definitionsFor = (...channels: string[]) =>
    channels.map((channel) =>
      mocks.definitions.find(
        (definition) =>
          typeof definition === "object" &&
          definition !== null &&
          "channel" in definition &&
          definition.channel === channel,
      ),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies snapshot updates as returned values and destructive filesystem work as pending", async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === "worktrees:settings:update") {
        return { worktreeRoot: "/managed", autoDeleteEnabled: true, autoDeleteLimit: 12 };
      }
      if (channel === "worktrees:delete") return true;
      if (channel === "worktrees:thread:restore") {
        return { availability: { state: "available" }, restored: true };
      }
      if (channel === "worktrees:environments:config:save") {
        return { type: "success" };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    await expect(
      managedWorktreeSettingsService.updateSettings({ autoDeleteLimit: 12 }),
    ).resolves.toMatchObject({ autoDeleteLimit: 12 });
    await expect(managedWorktreeSettingsService.delete("local", "/managed/one")).resolves.toBe(
      true,
    );
    await expect(restoreManagedWorktree("thread-1")).resolves.toMatchObject({ restored: true });
    await expect(
      saveWorktreeEnvironmentConfig({
        projectId: "project-1",
        configPath: "/project/.codex/environment.toml",
        expectedRevision: null,
        environment: {
          version: 1,
          name: "Default",
          setup: { script: null, platformScripts: {} },
          cleanup: { script: null, platformScripts: {} },
          actions: [],
        },
      }),
    ).resolves.toMatchObject({ type: "success" });

    expect(
      definitionsFor(
        "worktrees:settings:update",
        "worktrees:delete",
        "worktrees:thread:restore",
        "worktrees:environments:config:save",
      ),
    ).toMatchObject([
      {
        channel: "worktrees:settings:update",
        authority: "main",
        protocol: { kind: "returned_value" },
      },
      {
        channel: "worktrees:delete",
        authority: "external",
        protocol: { kind: "pending_operation" },
      },
      {
        channel: "worktrees:thread:restore",
        authority: "external",
        protocol: { kind: "pending_operation" },
      },
      {
        channel: "worktrees:environments:config:save",
        authority: "external",
        protocol: { kind: "returned_value" },
      },
    ]);
  });

  it("keeps pending Worktree reads, controls, terminal results, and ongoing actions distinct", async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === "codex:pending-worktrees:list") return [];
      if (channel === "codex:pending-worktree:resolve-thread") {
        return { state: "succeeded", threadId: "thread-1" };
      }
      if (channel === "codex:pending-worktree:work-locally") {
        return { threadId: "thread-local" };
      }
      return undefined;
    });

    await expect(pendingWorktreeRouteTransport.list()).resolves.toEqual([]);
    await expect(pendingWorktreeRouteTransport.resolveThread("client-1")).resolves.toMatchObject({
      state: "succeeded",
    });
    await expect(pendingWorktreeRouteTransport.workLocally("local", "pending-1")).resolves.toEqual({
      threadId: "thread-local",
    });
    await expect(
      pendingWorktreeRouteTransport.retry("local", "pending-1"),
    ).resolves.toBeUndefined();
    await expect(
      pendingWorktreeRouteTransport.discardForkSidePanelTransfer("pending-1"),
    ).resolves.toBeUndefined();

    expect(
      definitionsFor(
        "codex:pending-worktree:resolve-thread",
        "codex:pending-worktree:work-locally",
        "codex:pending-worktree:retry",
      ),
    ).toMatchObject([
      {
        channel: "codex:pending-worktree:resolve-thread",
        protocol: { kind: "returned_value" },
      },
      {
        channel: "codex:pending-worktree:work-locally",
        protocol: { kind: "returned_value" },
      },
      {
        channel: "codex:pending-worktree:retry",
        protocol: { kind: "pending_operation" },
      },
    ]);
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "codex:pending-worktree:discard-fork-side-panel-transfer",
      "pending-1",
    );
  });

  it("routes Worktree configuration queries and pending creation through their owning APIs", async () => {
    const config = {
      projectId: "project-1",
      configPath: "/workspace/.codex/environments/default.toml",
      state: "valid" as const,
      environment: null,
      errorMessage: null,
      revision: "revision-1",
    };
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel.startsWith("worktrees:environments:configs:list")) return [config];
      if (channel === "codex:pending-worktree:create") {
        return { pendingWorktreeId: "pending-1", clientThreadId: null };
      }
      if (channel === "codex:fork-side-panel-transfer:consume") return null;
      return undefined;
    });

    await expect(listWorktreeEnvironmentConfigs("project-1")).resolves.toEqual([config]);
    await expect(
      listWorktreeEnvironmentConfigsForWorkspace("local", "/workspace"),
    ).resolves.toEqual([config]);
    await expect(
      createPendingWorktree({
        launchMode: "create-stable-worktree",
        hostId: "local",
        label: "Workspace",
        sourceWorkspaceRoot: "/workspace",
        sourceWorkspaceRoots: ["/workspace"],
        startConversationParamsInput: null,
        sourceConversationId: null,
        sourceCollaborationMode: null,
        prompt: "",
      }),
    ).resolves.toEqual({ pendingWorktreeId: "pending-1", clientThreadId: null });
    await expect(
      setPendingWorktreePinnedBeforeThread("local", "pending-1", "thread-2"),
    ).resolves.toBeUndefined();
    await expect(
      consumeForkSidePanelTransfer({
        routeKind: "local-thread",
        targetConversationId: "thread-1",
        targetProjectSessionId: "session-1",
        targetBrowserViewScopeId: "window-1",
      }),
    ).resolves.toBeNull();

    expect(mocks.invoke.mock.calls).toEqual([
      ["worktrees:environments:configs:list", "project-1"],
      ["worktrees:environments:configs:list-for-workspace", "local", "/workspace"],
      [
        "codex:pending-worktree:create",
        {
          launchMode: "create-stable-worktree",
          hostId: "local",
          label: "Workspace",
          sourceWorkspaceRoot: "/workspace",
          sourceWorkspaceRoots: ["/workspace"],
          startConversationParamsInput: null,
          sourceConversationId: null,
          sourceCollaborationMode: null,
          prompt: "",
        },
      ],
      ["codex:pending-worktree:set-pinned-before-thread", "local", "pending-1", "thread-2"],
      [
        "codex:fork-side-panel-transfer:consume",
        {
          routeKind: "local-thread",
          targetConversationId: "thread-1",
          targetProjectSessionId: "session-1",
          targetBrowserViewScopeId: "window-1",
        },
      ],
    ]);
    expect(
      definitionsFor(
        "codex:pending-worktree:create",
        "codex:pending-worktree:set-pinned-before-thread",
      ),
    ).toMatchObject([
      {
        channel: "codex:pending-worktree:create",
        authority: "external",
        protocol: { kind: "pending_operation" },
      },
      {
        channel: "codex:pending-worktree:set-pinned-before-thread",
        authority: "main",
        protocol: { kind: "pending_operation" },
      },
    ]);
  });
});
