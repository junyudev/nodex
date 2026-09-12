import { expect, test } from "vite-plus/test";
import {
  codexProjectlessWorkspaceRootFromCwd,
  findCodexProjectlessWorkspaceInRoots,
  prepareCodexTurnWorkspace,
  prepareCodexTurnWorkspaceCommit,
  resolveCodexPreparedWorkspaceKind,
  resolveExistingCodexProjectlessWorkspace,
  shouldMaterializeCodexProjectlessWorkspace,
} from "./CodexTurnWorkspace";

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

test("sticky environment suppresses a pending workspace", () => {
  const prepared = prepareCodexTurnWorkspace({
    conversationCwd: "/old",
    requestCwd: "/request",
    environment: {
      environmentId: "environment:test",
      cwd: "/environment",
      runtimeWorkspaceRoots: ["/environment", "/environment-extra"],
    },
    currentPermissionRoots: ["/old"],
    state: { revision: "workspace:r1", applied, pending },
  });

  expect(prepared.cwd).toBe("/environment");
  expect(prepared.pendingWorkspace).toBeNull();
  expect(prepared.pendingRevision).toBeNull();
  expect(prepared.permissionTransition).toBeUndefined();
});

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
  expect(prepared.permissionTransition).toEqual({
    appliedRoots: ["/old", "/old-project"],
    pendingRoots: ["/new", "/new-project"],
  });
  expect(commit).toEqual({
    writableRoots: { kind: "replace", roots: ["/new", "/new-project"] },
    revision: "workspace:r1",
    hadWorkspaceState: true,
  });
});

test("legacy workspace without transition merges new durable roots", () => {
  expect(
    prepareCodexTurnWorkspaceCommit({
      state: null,
      pendingWorkspace: null,
      pendingRevision: null,
      roots: ["/repo", "/extra"],
      retainedWritableRoots: ["/repo"],
      cwd: "/repo",
      conversationCwd: "/repo",
    }),
  ).toEqual({
    writableRoots: { kind: "merge", roots: ["/repo", "/extra"] },
    revision: null,
    hadWorkspaceState: false,
  });
});

test("projectless workspace detection mirrors owner-time generated-root reuse", () => {
  expect(
    codexProjectlessWorkspaceRootFromCwd(
      "/Users/test/Documents/Nodex/2026-09-17/explain-permission-flow",
    ),
  ).toBe("/Users/test/Documents/Nodex");
  expect(
    findCodexProjectlessWorkspaceInRoots([
      "/repo",
      "/Users/test/Documents/Nodex/2026-09-16/older",
      "/Users/test/Documents/Nodex/2026-09-17/newer",
    ]),
  ).toEqual({
    cwd: "/Users/test/Documents/Nodex/2026-09-17/newer",
    workspaceRoot: "/Users/test/Documents/Nodex",
  });
});

test("projectless preparation prefers cwd, retained roots, then browser-root repair", () => {
  expect(
    resolveExistingCodexProjectlessWorkspace({
      cwd: "/Users/test/Documents/Nodex/2026-09-17/direct",
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
