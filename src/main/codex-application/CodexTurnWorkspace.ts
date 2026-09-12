import type { TurnEnvironmentParams } from "@nodex/codex-app-server-protocol/v2/TurnEnvironmentParams";
import { resolveCodexCanonicalProjectlessCwd } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexTurnPermissionWorkspaceTransition } from "../../shared/codex-conversation-state/codex-turn-permissions";
import type {
  CodexConversationWorkspace,
  CodexConversationWorkspaceState,
} from "./CodexConversationContext";

export interface CodexTurnWorkspaceCommit {
  readonly writableRoots: {
    readonly kind: "replace" | "merge";
    readonly roots: readonly string[];
  } | null;
  readonly revision: string | null;
  readonly hadWorkspaceState: boolean;
}

export interface CodexPreparedTurnWorkspace {
  readonly cwd: string | null;
  readonly pendingWorkspace: CodexConversationWorkspace | null;
  readonly pendingRevision: string | null;
  readonly permissionTransition?: CodexTurnPermissionWorkspaceTransition;
}

export interface CodexPreparedProjectlessWorkspace {
  readonly cwd: string;
  readonly workspaceRoot: string;
}

const unionRoots = (...groups: readonly (readonly string[])[]): string[] => [
  ...new Set(groups.flat()),
];

const PROJECTLESS_WORKSPACE_PATTERN =
  /^(.*(?:^|[\\/])Documents[\\/]+Nodex)[\\/]+(?:\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*|\d{4}-\d{2}-\d{2}[\\/]+[a-z0-9][a-z0-9-]*)[\\/]*$/i;

/** Returns the durable browser root for a generated projectless thread cwd. */
export function codexProjectlessWorkspaceRootFromCwd(cwd: string | null): string | null {
  return cwd?.trim().match(PROJECTLESS_WORKSPACE_PATTERN)?.[1] ?? null;
}

/** The newest retained generated root wins, matching the desktop's reverse scan. */
export function findCodexProjectlessWorkspaceInRoots(
  roots: readonly string[],
): CodexPreparedProjectlessWorkspace | null {
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const cwd = roots[index];
    if (!cwd) continue;
    const workspaceRoot = codexProjectlessWorkspaceRootFromCwd(cwd);
    if (workspaceRoot) return { cwd, workspaceRoot };
  }
  return null;
}

/** Exact owner-time projectless decision before permission materialization. */
export function shouldMaterializeCodexProjectlessWorkspace(input: {
  readonly environmentCwd: string | null;
  readonly hasPendingWorkspace: boolean;
  readonly state: CodexConversationWorkspaceState | null;
  readonly stateProjectId: string | null;
  readonly isProjectlessConversation: boolean;
  readonly workspaceKind: "project" | "projectless" | null | undefined;
}): boolean {
  if (input.environmentCwd !== null || input.hasPendingWorkspace) return false;
  if (input.state === null) {
    return input.workspaceKind === "projectless" || input.isProjectlessConversation;
  }
  return input.stateProjectId === null && input.state.applied === null;
}

/** Exact final workspace-kind selection after pending/projectless preparation. */
export function resolveCodexPreparedWorkspaceKind(input: {
  readonly currentWorkspaceKind: "project" | "projectless" | null | undefined;
  readonly hasPendingWorkspace: boolean;
  readonly hasProjectlessWorkspace: boolean;
  readonly state: CodexConversationWorkspaceState | null;
  readonly stateProjectId: string | null;
}): "project" | "projectless" {
  if (input.hasPendingWorkspace || (input.state !== null && input.stateProjectId !== null)) {
    return "project";
  }
  if (input.hasProjectlessWorkspace || (input.state !== null && input.stateProjectId === null)) {
    return "projectless";
  }
  return input.currentWorkspaceKind ?? "project";
}

/** Reuses the same projectless workspace hints before a new directory is created. */
export function resolveExistingCodexProjectlessWorkspace(input: {
  readonly cwd: string | null;
  readonly retainedWritableRoots: readonly string[];
  readonly workspaceKind: "project" | "projectless" | null | undefined;
  readonly workspaceBrowserRoot: string | null | undefined;
}): CodexPreparedProjectlessWorkspace | null {
  const directRoot = codexProjectlessWorkspaceRootFromCwd(input.cwd);
  if (input.cwd !== null && directRoot !== null) {
    return { cwd: input.cwd, workspaceRoot: directRoot };
  }

  const retained = findCodexProjectlessWorkspaceInRoots(input.retainedWritableRoots);
  if (retained) return retained;

  const browserRoot = input.workspaceBrowserRoot ?? null;
  if (input.workspaceKind !== "projectless" || browserRoot === null || browserRoot === "~") {
    return null;
  }
  const cwd = resolveCodexCanonicalProjectlessCwd({
    cwd: input.cwd,
    fallbackCwd: browserRoot,
    workspaceBrowserRoot: browserRoot,
    projectless: true,
  });
  return cwd === null ? null : { cwd, workspaceRoot: browserRoot };
}

const workspaceFrom = (input: {
  readonly cwd: string | null;
  readonly projectSources?: readonly string[];
  readonly runtimeWorkspaceRoots?: readonly string[];
}): CodexConversationWorkspace | null => {
  if (input.cwd === null) return null;
  return {
    projectSources: [...(input.projectSources ?? [input.cwd])],
    cwd: input.cwd,
    runtimeWorkspaceRoots: [...(input.runtimeWorkspaceRoots ?? [input.cwd])],
  };
};

const appliedWorkspaceRoots = (
  workspace: CodexConversationWorkspace | null,
  fallbackCwd: string | null,
): readonly string[] => {
  if (workspace === null) return fallbackCwd === null ? [] : [fallbackCwd];
  return unionRoots(workspace.runtimeWorkspaceRoots, workspace.projectSources);
};

/** Mirrors the desktop owner-time applied/pending workspace selection before permission materialization. */
export function prepareCodexTurnWorkspace(input: {
  readonly conversationCwd: string | null;
  readonly requestCwd: string | null | undefined;
  readonly environment: TurnEnvironmentParams | undefined;
  readonly currentPermissionRoots: readonly string[] | undefined;
  readonly state: CodexConversationWorkspaceState | null;
}): CodexPreparedTurnWorkspace {
  const environment = input.environment;
  const applied = environment
    ? workspaceFrom({
        cwd: environment.cwd,
        runtimeWorkspaceRoots: environment.runtimeWorkspaceRoots ?? undefined,
      })
    : (input.state?.applied ??
      workspaceFrom({
        cwd: input.conversationCwd,
        runtimeWorkspaceRoots: input.currentPermissionRoots,
      }));
  const pendingWorkspace = environment ? null : (input.state?.pending ?? null);
  const pendingRevision = pendingWorkspace === null ? null : (input.state?.revision ?? null);
  const cwd =
    environment?.cwd ??
    pendingWorkspace?.cwd ??
    input.requestCwd ??
    input.conversationCwd ??
    applied?.cwd ??
    null;
  const permissionTransition =
    input.state !== null && pendingWorkspace !== null
      ? {
          appliedRoots: appliedWorkspaceRoots(applied, input.conversationCwd),
          pendingRoots: [...pendingWorkspace.runtimeWorkspaceRoots],
        }
      : undefined;
  return {
    cwd,
    pendingWorkspace,
    pendingRevision,
    ...(permissionTransition ? { permissionTransition } : {}),
  };
}

/** Produces the durable root synchronization plan captured with one owner-time preparation. */
export function prepareCodexTurnWorkspaceCommit(input: {
  readonly state: CodexConversationWorkspaceState | null;
  readonly pendingWorkspace: CodexConversationWorkspace | null;
  readonly pendingRevision: string | null;
  readonly roots: readonly string[];
  readonly retainedWritableRoots: readonly string[];
  readonly cwd: string | null;
  readonly conversationCwd: string | null;
}): CodexTurnWorkspaceCommit {
  if (input.state !== null && input.pendingWorkspace !== null) {
    return {
      writableRoots: { kind: "replace", roots: [...input.roots] },
      revision: input.pendingRevision,
      hadWorkspaceState: true,
    };
  }
  if (
    input.state === null &&
    input.roots.length > 0 &&
    (input.retainedWritableRoots.length > 0 || input.cwd !== input.conversationCwd)
  ) {
    return {
      writableRoots: { kind: "merge", roots: [...input.roots] },
      revision: null,
      hadWorkspaceState: false,
    };
  }
  return {
    writableRoots: null,
    revision: null,
    hadWorkspaceState: input.state !== null,
  };
}
