import { describe, expect, test } from "vite-plus/test";
import {
  codexProjectlessWorkspaceRootFromCwd,
  findCodexProjectlessWorkspaceInRoots,
  prepareCodexTurnWorkspace,
  prepareCodexTurnWorkspaceCommit,
  resolveCodexPreparedWorkspaceKind,
  resolveExistingCodexProjectlessWorkspace,
  shouldMaterializeCodexProjectlessWorkspace,
} from "./CodexTurnWorkspace";
import {
  projectCodexTurnServiceTier,
  resolveNativeTurnExecutionSettings,
} from "./CodexTurnPreparation";

describe("CodexTurnWorkspace", () => {
  const applied = {
    projectSources: ["/old-project"],
    cwd: "/old",
    runtimeWorkspaceRoots: ["/old", "/old-project"],
  };
  const pending = {
    projectSources: ["/new-project"],
    cwd: "/new",
    runtimeWorkspaceRoots: ["/new", "/new-project"],
  };

  test("pending workspace captures replace semantics and accepted revision", () => {
    const prepared = prepareCodexTurnWorkspace({
      conversationCwd: "/old",
      requestCwd: undefined,
      environment: undefined,
      currentPermissionRoots: ["/old"],
      state: { revision: "workspace:r1", applied, pending },
    });
    const commit = prepareCodexTurnWorkspaceCommit({
      state: { revision: "workspace:r1", applied, pending },
      pendingWorkspace: prepared.pendingWorkspace,
      pendingRevision: prepared.pendingRevision,
      roots: ["/new", "/new-project"],
      retainedWritableRoots: ["/old", "/old-project"],
      cwd: prepared.cwd,
      conversationCwd: "/old",
    });

    expect(prepared.cwd).toBe("/new");
    expect(prepared.workspaceTransition).toEqual({
      appliedRoots: ["/old", "/old-project"],
      pendingRoots: ["/new", "/new-project"],
    });
    expect(commit).toEqual({
      writableRoots: { kind: "replace", roots: ["/new", "/new-project"] },
      revision: "workspace:r1",
      hadWorkspaceState: true,
    });
  });

  test("projectless workspace detection mirrors owner-time generated-root reuse", () => {
    const projectsDirectory = "/Users/test/Documents/Nodex";
    expect(
      codexProjectlessWorkspaceRootFromCwd(
        "/Users/test/Documents/Nodex/2026-09-17/explain-permission-flow",
        projectsDirectory,
      ),
    ).toBe(projectsDirectory);
    // Only a directory Nodex generated under this Profile's projects directory is projectless.
    for (const cwd of [
      "/Users/test/Documents/Nodex/Default",
      "/Users/test/Documents/Nodex-old/2026-09-17/explain",
      "/Users/other/Documents/Nodex/2026-09-17/explain",
    ])
      expect(codexProjectlessWorkspaceRootFromCwd(cwd, projectsDirectory)).toBeNull();
    expect(
      codexProjectlessWorkspaceRootFromCwd(
        "/dev/home/workspace/2026-09-17/explain",
        "/dev/home/workspace/",
      ),
    ).toBe("/dev/home/workspace");
    expect(
      findCodexProjectlessWorkspaceInRoots(
        [
          "/repo",
          "/Users/test/Documents/Nodex/2026-09-16/older",
          "/Users/test/Documents/Nodex/2026-09-17/newer",
        ],
        projectsDirectory,
      ),
    ).toEqual({
      cwd: "/Users/test/Documents/Nodex/2026-09-17/newer",
      workspaceRoot: "/Users/test/Documents/Nodex",
    });
  });

  test("projectless preparation prefers cwd, retained roots, then browser-root repair", () => {
    expect(
      resolveExistingCodexProjectlessWorkspace({
        cwd: "/Users/test/Documents/Nodex/2026-09-17/direct",
        projectsDirectory: "/Users/test/Documents/Nodex",
        retainedWritableRoots: ["/Users/test/Documents/Nodex/2026-09-16/retained"],
        workspaceKind: "projectless",
        workspaceBrowserRoot: "/Users/test/Documents/Nodex",
      }),
    ).toEqual({
      cwd: "/Users/test/Documents/Nodex/2026-09-17/direct",
      workspaceRoot: "/Users/test/Documents/Nodex",
    });
    expect(
      resolveExistingCodexProjectlessWorkspace({
        cwd: "/outside",
        projectsDirectory: "/Users/test/Documents/Nodex",
        retainedWritableRoots: [],
        workspaceKind: "projectless",
        workspaceBrowserRoot: "/Users/test/Documents/Nodex",
      }),
    ).toEqual({
      cwd: "/Users/test/Documents/Nodex",
      workspaceRoot: "/Users/test/Documents/Nodex",
    });
  });

  test("environment and pending workspace suppress projectless materialization", () => {
    expect(
      shouldMaterializeCodexProjectlessWorkspace({
        environmentCwd: "/environment",
        hasPendingWorkspace: false,
        state: null,
        stateProjectId: null,
        isProjectlessConversation: true,
        workspaceKind: "projectless",
      }),
    ).toBe(false);
    expect(
      shouldMaterializeCodexProjectlessWorkspace({
        environmentCwd: null,
        hasPendingWorkspace: true,
        state: { revision: "r1", applied: null, pending },
        stateProjectId: null,
        isProjectlessConversation: true,
        workspaceKind: "projectless",
      }),
    ).toBe(false);
  });

  test("workspace state target membership determines the final workspace kind", () => {
    expect(
      resolveCodexPreparedWorkspaceKind({
        currentWorkspaceKind: "projectless",
        hasPendingWorkspace: true,
        hasProjectlessWorkspace: false,
        state: { revision: "r1", applied, pending },
        stateProjectId: "project:target",
      }),
    ).toBe("project");
    expect(
      resolveCodexPreparedWorkspaceKind({
        currentWorkspaceKind: "project",
        hasPendingWorkspace: false,
        hasProjectlessWorkspace: false,
        state: { revision: "r2", applied, pending: null },
        stateProjectId: null,
      }),
    ).toBe("projectless");
  });

  test("delayed requests and queued messages follow the Chat's committed execution location", () => {
    const prepared = prepareCodexTurnWorkspace({
      conversationCwd: "/managed/current",
      requestCwd: "/previous/checkout",
      environment: undefined,
      currentPermissionRoots: ["/managed/current"],
      state: null,
    });
    expect(prepared.cwd).toBe("/managed/current");
  });
});

describe("CodexTurnPreparationServiceTier", () => {
  describe("turn service-tier projection", () => {
    test("retains native sentinel values and explicitly materializes an absent tier as null", () => {
      expect(projectCodexTurnServiceTier(undefined, null)).toEqual({ serviceTier: null });
      expect(projectCodexTurnServiceTier(undefined, "default")).toEqual({ serviceTier: "default" });
      expect(projectCodexTurnServiceTier({ serviceTier: "standard" }, "priority")).toEqual({
        serviceTier: "standard",
      });
    });
  });

  describe("native turn owner materialization", () => {
    const inherited = { model: "owner-model", effort: "high" as const, collaborationMode: null };
    test("resolves omitted fields from the receiving owner while preserving explicit null effort", () => {
      expect(resolveNativeTurnExecutionSettings({ threadId: "a", input: [] }, inherited)).toEqual(
        inherited,
      );
      expect(
        resolveNativeTurnExecutionSettings(
          { threadId: "a", input: [], model: null, effort: null },
          inherited,
        ),
      ).toEqual({ ...inherited, effort: null });
      expect(
        resolveNativeTurnExecutionSettings(
          { threadId: "a", input: [], model: "  explicit  " },
          inherited,
        ).model,
      ).toBe("explicit");
    });
    test("retains the full explicit collaboration object and suppresses independent model and effort", () => {
      const collaborationMode = {
        mode: "plan" as const,
        settings: {
          model: "plan-model",
          reasoning_effort: "low" as const,
          developer_instructions: "keep this context",
        },
      };
      expect(
        resolveNativeTurnExecutionSettings(
          { threadId: "a", input: [], model: "ignored", effort: "high", collaborationMode },
          inherited,
        ),
      ).toEqual({ model: null, effort: null, collaborationMode });
      expect(
        resolveNativeTurnExecutionSettings(
          { threadId: "a", input: [] },
          { ...inherited, collaborationMode },
        ),
      ).toEqual({ ...inherited, collaborationMode });
    });
  });
});
