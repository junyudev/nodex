import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import {
  createCodexCanonicalWorkspacePermissionContext,
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
  | "cwd"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "permissions"
  | "runtimeWorkspaceRoots"
  | "sandbox"
  | "serviceTier"
  | "personality"
  | "config"
>;

export interface CanonicalResumePreparation {
  readonly overrides: CanonicalResumeOverrides;
  readonly permissions: CodexCanonicalHydratedPermissionContext;
  /** Workspace roots used to materialize execution settings and select a request cwd. */
  readonly resumeWorkspaceRoots: readonly string[];
  /** Roots eligible for missing-runtime-root inference from the native resume response. */
  readonly permissionWorkspaceRoots: readonly string[];
}

/** Immutable permission evidence captured before native resume begins. */
export interface ConversationResumePermissionContext {
  readonly requestedPermissions: CodexCanonicalHydratedPermissionContext;
  /** Null disables inference; an empty list explicitly supplies no candidate grants. */
  readonly runtimeWorkspaceRootCandidates: readonly string[] | null;
}

function normalizedResumeWorkspaceRoots(
  cwd: string | null,
  roots: readonly string[],
  projectlessPathSentinel = "~",
): string[] {
  const retained = roots.filter((root) => root !== projectlessPathSentinel);
  if (cwd === null || cwd === "" || cwd === projectlessPathSentinel) return retained;
  return [cwd, ...retained.filter((root) => root !== cwd)];
}

function projectlessWorkspaceWriteRoot(
  policy: CodexCanonicalHydratedPermissionContext["sandboxPolicy"] | undefined,
): string | null {
  if (policy?.type !== "workspaceWrite") return null;
  return policy.writableRoots.find((root) => root !== "~") ?? null;
}

function resolvedResumePermissionRoots(input: {
  readonly state: CodexCanonicalConversationState | null | undefined;
  readonly cwd: string | null;
  readonly resumeWorkspaceRoots: readonly string[];
  readonly workspaceWriteRoot: string | null;
  readonly hasAppliedWorkspace: boolean;
}): string[] {
  if (input.hasAppliedWorkspace) return [...input.resumeWorkspaceRoots];
  if (input.state?.workspaceKind !== "projectless") return [...input.resumeWorkspaceRoots];
  const browserRoot = input.state.workspaceBrowserRoot;
  if (browserRoot != null && browserRoot !== "~") return [browserRoot];
  if (input.workspaceWriteRoot != null) return [input.workspaceWriteRoot];
  if (input.cwd != null && input.cwd !== "~" && input.cwd !== input.state.cwd) return [input.cwd];
  return [];
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

function permissionResumeOverrides(
  permissions: CodexCanonicalHydratedPermissionContext,
  includePermissions: boolean,
  includeReviewer: boolean,
  additionalWritableRoots: readonly string[] = [],
): CanonicalResumeOverrides {
  const { activePermissionProfile: profile, sandboxPolicy: policy } = permissions;
  const sandbox =
    policy.type === "readOnly"
      ? "read-only"
      : policy.type === "workspaceWrite"
        ? "workspace-write"
        : policy.type === "dangerFullAccess"
          ? "danger-full-access"
          : undefined;
  return {
    ...(includeReviewer ? { approvalsReviewer: permissions.approvalsReviewer } : {}),
    ...(includePermissions && profile == null && policy.type === "workspaceWrite"
      ? {
          config: {
            sandbox_workspace_write: {
              writable_roots: [...new Set([...policy.writableRoots, ...additionalWritableRoots])],
              network_access: policy.networkAccess,
              exclude_tmpdir_env_var: policy.excludeTmpdirEnvVar,
              exclude_slash_tmp: policy.excludeSlashTmp,
            },
          },
        }
      : {}),
    ...(includePermissions
      ? {
          approvalPolicy: permissions.approvalPolicy,
          ...(profile
            ? {
                permissions: profile.id,
                runtimeWorkspaceRoots: [...permissions.runtimeWorkspaceRoots],
              }
            : { sandbox }),
        }
      : {}),
  };
}

/** A caller selection replaces inherited permission fields, including the former policy's config. */
export function withExplicitResumePermissions(
  overrides: CanonicalResumeOverrides,
  permissions: CodexCanonicalHydratedPermissionContext,
  cwd: string | null,
): CanonicalResumeOverrides {
  const {
    approvalPolicy: _approvalPolicy,
    approvalsReviewer: _approvalsReviewer,
    permissions: _permissions,
    runtimeWorkspaceRoots: _runtimeWorkspaceRoots,
    sandbox: _sandbox,
    config,
    ...retained
  } = overrides;
  const { sandbox_workspace_write: _workspaceWrite, ...retainedConfig } = config ?? {};
  const selected = permissionResumeOverrides(
    {
      ...permissions,
      runtimeWorkspaceRoots: workspaceRootsForCwd(cwd, permissions.runtimeWorkspaceRoots),
    },
    true,
    true,
  );
  const selectedConfig = { ...retainedConfig, ...selected.config };
  return {
    ...retained,
    ...selected,
    ...(Object.keys(selectedConfig).length > 0 ? { config: selectedConfig } : {}),
  };
}

/** Reconstructed history permissions are defaults, never an explicit user selection. */
export function canonicalResumePreparation(
  state: CodexCanonicalConversationState | null | undefined,
  workspace: {
    readonly cwd: string | null;
    readonly metadataCwd?: string | null;
    readonly resumeWorkspaceRoots?: readonly string[];
    readonly permissions: CodexCanonicalHydratedPermissionContext;
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
      workspace.permissions.runtimeWorkspaceRoots,
  );
  const permissionResumeRoots = resolvedResumePermissionRoots({
    state,
    cwd,
    resumeWorkspaceRoots: normalResumeRoots,
    workspaceWriteRoot,
    hasAppliedWorkspace: appliedWorkspace !== null,
  });
  const current = state?.currentPermissions;
  const defaults = createCodexCanonicalWorkspacePermissionContext(permissionResumeRoots);
  const profile =
    settings?.activePermissionProfile !== undefined
      ? settings.activePermissionProfile
      : params?.permissions != null
        ? { id: params.permissions, extends: null }
        : current?.activePermissionProfile;
  const policy =
    settings?.sandboxPolicy ??
    params?.sandboxPolicy ??
    current?.sandboxPolicy ??
    defaults.sandboxPolicy;
  const approvalPolicy =
    settings?.approvalPolicy ??
    params?.approvalPolicy ??
    current?.approvalPolicy ??
    defaults.approvalPolicy;
  const approvalsReviewer =
    settings?.approvalsReviewer ??
    params?.approvalsReviewer ??
    current?.approvalsReviewer ??
    defaults.approvalsReviewer;
  const fixedPolicy = current?.sandboxPolicy ?? policy;
  const inheritsFixedRoots =
    profile != null && (current == null || current.activePermissionProfile?.id === profile.id);
  const retainedRoots =
    inheritsFixedRoots && fixedPolicy.type === "workspaceWrite"
      ? workspace.permissions.runtimeWorkspaceRoots.filter(
          (root) =>
            !fixedPolicy.writableRoots.some((fixed) => areWorkspacePathsEquivalent(fixed, root)),
        )
      : workspace.permissions.runtimeWorkspaceRoots;
  const retainedPermissionResumeRoots =
    inheritsFixedRoots && fixedPolicy.type === "workspaceWrite"
      ? permissionResumeRoots.filter(
          (root) =>
            root === cwd ||
            !fixedPolicy.writableRoots.some((fixed) => areWorkspacePathsEquivalent(fixed, root)),
        )
      : permissionResumeRoots;
  const preparedRoots = [
    ...new Set([
      ...(current?.runtimeWorkspaceRoots ?? []),
      ...retainedPermissionResumeRoots,
      ...retainedRoots,
    ]),
  ];
  const roots = workspaceRootsForCwd(cwd, preparedRoots);
  const includePermissions =
    settings?.approvalPolicy != null ||
    settings?.sandboxPolicy != null ||
    settings?.permissions != null ||
    settings?.activePermissionProfile !== undefined ||
    params != null ||
    current?.activePermissionProfile?.id === ":danger-full-access";
  const includeReviewer =
    settings?.approvalsReviewer != null ||
    params?.approvalsReviewer != null ||
    (last?.permissionParamsSource !== "inferred" && current?.approvalsReviewer != null);
  const serviceTier =
    settings?.serviceTier !== undefined ? settings.serviceTier : params?.serviceTier;
  const personality =
    settings?.personality !== undefined ? settings.personality : last?.params.personality;
  return {
    permissions: {
      activePermissionProfile: profile ?? null,
      sandboxPolicy:
        policy.type === "workspaceWrite"
          ? {
              ...policy,
              writableRoots: [
                ...new Set([
                  ...policy.writableRoots,
                  ...workspace.permissions.runtimeWorkspaceRoots,
                ]),
              ],
            }
          : policy,
      approvalPolicy,
      approvalsReviewer,
      runtimeWorkspaceRoots: preparedRoots,
    },
    resumeWorkspaceRoots: normalResumeRoots,
    permissionWorkspaceRoots: permissionResumeRoots,
    overrides: {
      cwd,
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(personality === undefined ? {} : { personality }),
      ...permissionResumeOverrides(
        {
          activePermissionProfile: profile ?? null,
          sandboxPolicy: policy,
          approvalPolicy,
          approvalsReviewer,
          runtimeWorkspaceRoots: roots,
        },
        includePermissions,
        includeReviewer,
        workspace.permissions.runtimeWorkspaceRoots,
      ),
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
