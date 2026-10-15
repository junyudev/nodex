import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import {
  resolveCodexCanonicalHydratedCwd,
  resolveCodexCanonicalHydratedPermissionContext,
  resolveCodexCanonicalProjectlessCwd,
  type CodexCanonicalConversationState,
  type CodexCanonicalHydratedPermissionContext,
} from "./codex-conversation-state";
import { latestAssignedConversationTurn } from "./codex-turn-selectors";
import { areWorkspacePathsEquivalent, workspaceRootsForCwd } from "../codex-workspace-paths";

export type CanonicalResumeOverrides = Pick<
  ThreadResumeParams,
  "cwd" | "runtimeWorkspaceRoots" | "serviceTier" | "personality"
>;

export interface CanonicalResumePreparation {
  readonly overrides: CanonicalResumeOverrides;
  /** Workspace roots used to materialize execution settings and select a request cwd. */
  readonly resumeWorkspaceRoots: readonly string[];
}

/** Native execution observations captured for resume response reconciliation. */
export interface ConversationResumePermissionContext {
  readonly requestedPermissions: CodexCanonicalHydratedPermissionContext;
  /** Null disables missing-root inference; an empty list has no physical workspace candidates. */
  readonly runtimeWorkspaceRootCandidates: readonly string[] | null;
}

function normalizedResumeWorkspaceRoots(
  cwd: string | null,
  roots: readonly string[],
  projectlessPathSentinel = "~",
): string[] {
  const retained = roots.filter((root) => root !== projectlessPathSentinel);
  if (cwd === null || cwd === "" || cwd === projectlessPathSentinel) return retained;
  return [cwd, ...retained.filter((root) => !areWorkspacePathsEquivalent(root, cwd))];
}

function projectlessWorkspaceWriteRoot(
  policy: CodexCanonicalHydratedPermissionContext["sandboxPolicy"] | undefined,
): string | null {
  if (policy?.type !== "workspaceWrite") return null;
  return policy.writableRoots.find((root) => root !== "~") ?? null;
}

/** Reconcile missing profile provenance and only infer roots from confirmed server grants. */
export function resolveConversationResumePermissions(
  response: Pick<
    ThreadResumeResponse,
    | "activePermissionProfile"
    | "runtimeWorkspaceRoots"
    | "approvalPolicy"
    | "approvalsReviewer"
    | "sandbox"
  >,
  context: ConversationResumePermissionContext,
): CodexCanonicalHydratedPermissionContext {
  const permissions = resolveCodexCanonicalHydratedPermissionContext({
    response: {
      activePermissionProfile: response.activePermissionProfile,
      runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      sandboxPolicy: response.sandbox,
    },
    previous: context.requestedPermissions,
  });
  if (
    context.runtimeWorkspaceRootCandidates === null ||
    response.activePermissionProfile === null ||
    response.sandbox.type !== "workspaceWrite" ||
    response.runtimeWorkspaceRoots.length !== 0
  )
    return permissions;
  const writableRoots = response.sandbox.writableRoots;
  return {
    ...permissions,
    runtimeWorkspaceRoots: context.runtimeWorkspaceRootCandidates.filter((candidate) =>
      writableRoots.some((root) => areWorkspacePathsEquivalent(root, candidate)),
    ),
  };
}

/** Restores physical placement and model preferences without replaying historical execution policy. */
export function canonicalResumePreparation(
  state: CodexCanonicalConversationState | null | undefined,
  workspace: {
    readonly cwd: string | null;
    readonly metadataCwd?: string | null;
    readonly resumeWorkspaceRoots?: readonly string[];
    readonly runtimeWorkspaceRoots: readonly string[];
    /** A committed pre-move workspace remains authoritative until the pending move is accepted. */
    readonly appliedWorkspace?: {
      readonly cwd: string;
      readonly runtimeWorkspaceRoots: readonly string[];
    } | null;
  },
): CanonicalResumePreparation {
  const last = latestAssignedConversationTurn(state);
  const params = last?.permissionParamsSource === "inferred" ? undefined : last?.params;
  const settings = state?.latestThreadSettings ?? state?.hydrationContext?.latestThreadSettings;
  const projectless = state?.workspaceKind === "projectless";
  const appliedWorkspace = workspace.appliedWorkspace ?? null;
  const workspaceWriteRoot =
    projectless && appliedWorkspace === null
      ? projectlessWorkspaceWriteRoot(settings?.sandboxPolicy ?? params?.sandboxPolicy)
      : null;
  const cwd = appliedWorkspace
    ? appliedWorkspace.cwd
    : resolveCodexCanonicalProjectlessCwd({
        cwd: resolveCodexCanonicalHydratedCwd({
          requestedCwd: state?.cwd ?? workspace.cwd,
          responseCwd: null,
          threadCwd: workspace.metadataCwd ?? null,
          fallbackCwd: workspace.cwd,
        }),
        fallbackCwd: workspaceWriteRoot,
        workspaceBrowserRoot: projectless ? (state?.workspaceBrowserRoot ?? null) : null,
        projectless,
      });
  const normalResumeRoots = normalizedResumeWorkspaceRoots(
    cwd,
    appliedWorkspace?.runtimeWorkspaceRoots ??
      workspace.resumeWorkspaceRoots ??
      workspace.runtimeWorkspaceRoots,
  );
  const serviceTier =
    settings?.serviceTier !== undefined ? settings.serviceTier : params?.serviceTier;
  const personality =
    settings?.personality !== undefined ? settings.personality : last?.params.personality;
  return {
    resumeWorkspaceRoots: normalResumeRoots,
    overrides: {
      cwd,
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(personality === undefined ? {} : { personality }),
      runtimeWorkspaceRoots: workspaceRootsForCwd(cwd, normalResumeRoots),
    },
  };
}

/** Project only wire overrides when a caller does not need result-reconciliation evidence. */
export function canonicalResumeOverrides(
  state: Parameters<typeof canonicalResumePreparation>[0],
  workspace: Parameters<typeof canonicalResumePreparation>[1],
): CanonicalResumeOverrides {
  return canonicalResumePreparation(state, workspace).overrides;
}
