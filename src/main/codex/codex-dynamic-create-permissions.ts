import type { ActivePermissionProfile } from "@nodex/codex-app-server-protocol/v2/ActivePermissionProfile";
import type { ApprovalsReviewer } from "@nodex/codex-app-server-protocol/v2/ApprovalsReviewer";
import type { AskForApproval } from "@nodex/codex-app-server-protocol/v2/AskForApproval";
import type { SandboxMode } from "@nodex/codex-app-server-protocol/v2/SandboxMode";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2/SandboxPolicy";
import type { Config } from "@nodex/codex-app-server-protocol/v2/Config";
import type { CodexAgentMode } from "../../shared/types";
import { CODEX_GRANULAR_APPROVAL_POLICY } from "../../shared/codex-permission-catalog";

export type CodexDynamicCreatePermissionMode = CodexAgentMode;

const CODEX_DYNAMIC_CREATE_PERMISSION_MODES: readonly CodexDynamicCreatePermissionMode[] = [
  "read-only",
  "auto",
  "granular",
  "guardian-approvals",
  "full-access",
  "custom",
];

export function isCodexDynamicCreatePermissionMode(
  value: unknown,
): value is CodexDynamicCreatePermissionMode {
  return CODEX_DYNAMIC_CREATE_PERMISSION_MODES.some((mode) => mode === value);
}

export interface CodexDynamicCreatePermissionContext {
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots?: readonly string[] | null;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
  readonly sandboxPolicy: SandboxPolicy;
}

export interface CodexDynamicCreatePermissionSource {
  readonly hostId: string;
  readonly cwd: string | null;
  readonly mode: CodexDynamicCreatePermissionMode;
  readonly context: CodexDynamicCreatePermissionContext;
}

export interface CodexDynamicCreatePermissionDestination {
  readonly hostId: string;
  readonly cwd: string;
  readonly defaultMode: CodexDynamicCreatePermissionMode;
  readonly defaultContext: CodexDynamicCreatePermissionContext;
  readonly workspaceRoots: readonly string[];
}

export type CodexDynamicCreateThreadLaunchPermissionParams = {
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
} & (
  | {
      readonly permissions: string;
      readonly runtimeWorkspaceRoots: string[];
      readonly sandbox?: never;
    }
  | {
      readonly permissions?: never;
      readonly runtimeWorkspaceRoots?: never;
      readonly sandbox: SandboxMode | null;
    }
);

export type CodexDynamicCreateTurnPermissionParams = {
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
} & (
  | {
      readonly permissions: string;
      readonly runtimeWorkspaceRoots: string[];
      readonly sandboxPolicy?: never;
    }
  | {
      readonly permissions?: never;
      readonly runtimeWorkspaceRoots?: never;
      readonly sandboxPolicy: SandboxPolicy;
    }
);

export interface CodexDynamicCreatePermissionSelection {
  readonly context: CodexDynamicCreatePermissionContext;
  readonly launchParams: CodexDynamicCreateThreadLaunchPermissionParams;
  readonly mode: CodexDynamicCreatePermissionMode;
  /**
   * The source profile retained by exact `at`, distinct from the profile that
   * the selected destination mode materializes on its own.
   */
  readonly sourcePermissionProfileId?: string;
  readonly turnParams: CodexDynamicCreateTurnPermissionParams;
}

export interface ResolveCodexDynamicCreatePermissionSelectionInput {
  readonly source: CodexDynamicCreatePermissionSource | null;
  readonly destination: CodexDynamicCreatePermissionDestination;
}

const GRANULAR_APPROVAL_POLICY = CODEX_GRANULAR_APPROVAL_POLICY;

function configApprovalsReviewer(config: Readonly<Partial<Config>>): ApprovalsReviewer {
  const reviewer = config.approvals_reviewer;
  if (reviewer !== "user" && reviewer !== "auto_review" && reviewer !== "guardian_subagent") {
    return "user";
  }
  if (reviewer !== "guardian_subagent") return reviewer;

  const flatGuardianApproval = config["features.guardian_approval"];
  const nestedFeatures = config.features;
  const nestedGuardianApproval =
    typeof nestedFeatures === "object" && nestedFeatures !== null && !Array.isArray(nestedFeatures)
      ? Object.getOwnPropertyDescriptor(nestedFeatures, "guardian_approval")?.value
      : undefined;
  const guardianApprovalEnabled =
    typeof flatGuardianApproval === "boolean"
      ? flatGuardianApproval
      : typeof nestedGuardianApproval === "boolean"
        ? nestedGuardianApproval
        : undefined;
  return guardianApprovalEnabled === false ? "user" : reviewer;
}

function isAutomaticApprovalsReviewer(reviewer: ApprovalsReviewer): boolean {
  return reviewer === "auto_review" || reviewer === "guardian_subagent";
}

function isExactGranularApprovalPolicy(policy: AskForApproval): boolean {
  if (typeof policy !== "object" || policy === null || !("granular" in policy)) return false;
  const granular = policy.granular;
  return (
    granular.sandbox_approval === GRANULAR_APPROVAL_POLICY.granular.sandbox_approval &&
    granular.rules === GRANULAR_APPROVAL_POLICY.granular.rules &&
    granular.skill_approval === GRANULAR_APPROVAL_POLICY.granular.skill_approval &&
    granular.request_permissions === GRANULAR_APPROVAL_POLICY.granular.request_permissions &&
    granular.mcp_elicitations === GRANULAR_APPROVAL_POLICY.granular.mcp_elicitations
  );
}

function isDefaultReadOnlySandbox(policy: SandboxPolicy): boolean {
  return policy.type === "readOnly" && policy.networkAccess === false;
}

function isDefaultWorkspaceWriteSandbox(policy: SandboxPolicy): boolean {
  return (
    policy.type === "workspaceWrite" &&
    policy.excludeSlashTmp === false &&
    policy.excludeTmpdirEnvVar === false &&
    policy.networkAccess === false
  );
}

/** Exact bundle `bue`: infer the reusable source agent mode from effective permissions. */
export function inferCodexDynamicCreatePermissionMode(
  context: CodexDynamicCreatePermissionContext,
): CodexDynamicCreatePermissionMode | null {
  const { approvalPolicy, approvalsReviewer, sandboxPolicy } = context;
  if (approvalPolicy == null || sandboxPolicy == null) return null;
  if (
    sandboxPolicy.type === "readOnly" &&
    approvalPolicy === "on-request" &&
    isDefaultReadOnlySandbox(sandboxPolicy)
  ) {
    return "read-only";
  }
  if (
    sandboxPolicy.type === "workspaceWrite" &&
    isExactGranularApprovalPolicy(approvalPolicy) &&
    approvalsReviewer === "user" &&
    isDefaultWorkspaceWriteSandbox(sandboxPolicy)
  ) {
    return "granular";
  }
  if (
    sandboxPolicy.type === "workspaceWrite" &&
    approvalPolicy === "on-request" &&
    isDefaultWorkspaceWriteSandbox(sandboxPolicy)
  ) {
    return isAutomaticApprovalsReviewer(approvalsReviewer) ? "guardian-approvals" : "auto";
  }
  if (sandboxPolicy.type === "dangerFullAccess" && approvalPolicy === "never") {
    return "full-access";
  }
  return "custom";
}

function workspaceWriteContext(input: {
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly approvalPolicy?: AskForApproval | null;
  readonly approvalsReviewer?: ApprovalsReviewer;
  readonly config?: Readonly<Partial<Config>>["sandbox_workspace_write"];
  readonly workspaceRoots: readonly string[];
}): CodexDynamicCreatePermissionContext {
  return {
    activePermissionProfile: input.activePermissionProfile,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...input.workspaceRoots, ...(input.config?.writable_roots ?? [])],
      excludeSlashTmp: input.config?.exclude_slash_tmp ?? false,
      excludeTmpdirEnvVar: input.config?.exclude_tmpdir_env_var ?? false,
      networkAccess: input.config?.network_access ?? false,
    },
    approvalPolicy: input.approvalPolicy ?? "on-request",
    approvalsReviewer: input.approvalsReviewer ?? "user",
  };
}

/** Exact bundle `Nue`: rebuild pending permissions from mode, new roots, and frozen config. */
export function buildCodexDynamicCreatePermissionContextForMode(input: {
  readonly mode: CodexDynamicCreatePermissionMode;
  readonly workspaceRoots: readonly string[];
  readonly config: Readonly<Partial<Config>>;
}): CodexDynamicCreatePermissionContext {
  const workspaceProfile = { id: ":workspace", extends: null } as const;
  if (input.mode === "read-only") {
    return {
      activePermissionProfile: { id: ":read-only", extends: null },
      runtimeWorkspaceRoots: [...input.workspaceRoots],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    };
  }
  if (input.mode === "full-access") {
    return {
      activePermissionProfile: { id: ":danger-full-access", extends: null },
      runtimeWorkspaceRoots: [...input.workspaceRoots],
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
      approvalsReviewer: "user",
    };
  }
  if (input.mode === "auto") {
    return workspaceWriteContext({
      activePermissionProfile: workspaceProfile,
      workspaceRoots: input.workspaceRoots,
    });
  }
  if (input.mode === "granular") {
    return workspaceWriteContext({
      activePermissionProfile: workspaceProfile,
      approvalPolicy: GRANULAR_APPROVAL_POLICY,
      workspaceRoots: input.workspaceRoots,
    });
  }
  if (input.mode === "guardian-approvals") {
    const approvalPolicy = input.config.approval_policy;
    const usesOnRequest =
      approvalPolicy === null || approvalPolicy === undefined || approvalPolicy === "on-request";
    if (input.config.sandbox_mode === "read-only" && usesOnRequest) {
      return {
        activePermissionProfile: { id: ":read-only", extends: null },
        runtimeWorkspaceRoots: [...input.workspaceRoots],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
      };
    }
    if (input.config.sandbox_mode === "workspace-write" && usesOnRequest) {
      return workspaceWriteContext({
        activePermissionProfile: null,
        approvalsReviewer: "guardian_subagent",
        config: input.config.sandbox_workspace_write,
        workspaceRoots: input.workspaceRoots,
      });
    }
    return workspaceWriteContext({
      activePermissionProfile: workspaceProfile,
      approvalsReviewer: "guardian_subagent",
      workspaceRoots: input.workspaceRoots,
    });
  }

  const reviewer = configApprovalsReviewer(input.config);
  if (input.config.sandbox_mode === "danger-full-access") {
    return {
      activePermissionProfile: null,
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: input.config.approval_policy ?? "never",
      approvalsReviewer: reviewer,
    };
  }
  if (input.config.sandbox_mode === "workspace-write") {
    return workspaceWriteContext({
      activePermissionProfile: null,
      approvalPolicy: input.config.approval_policy,
      approvalsReviewer: reviewer,
      config: input.config.sandbox_workspace_write,
      workspaceRoots: input.workspaceRoots,
    });
  }
  return {
    activePermissionProfile: null,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: input.config.approval_policy ?? "on-request",
    approvalsReviewer: reviewer,
  };
}

export function buildCodexDynamicPendingPermissionSelection(input: {
  readonly mode: CodexDynamicCreatePermissionMode;
  readonly workspaceRoot: string;
  readonly workspaceRoots?: readonly string[];
  readonly config: Readonly<Partial<Config>>;
  readonly permissionProfileId?: string;
}): CodexDynamicCreatePermissionSelection {
  const workspaceRoots = input.workspaceRoots ?? [input.workspaceRoot];
  const baseContext = buildCodexDynamicCreatePermissionContextForMode({
    mode: input.mode,
    workspaceRoots,
    config: input.config,
  });
  const context: CodexDynamicCreatePermissionContext = input.permissionProfileId
    ? {
        ...baseContext,
        activePermissionProfile: { id: input.permissionProfileId, extends: null },
        runtimeWorkspaceRoots: [...workspaceRoots],
      }
    : baseContext;
  return resolveCodexDynamicCreatePermissionSelection({
    source: {
      hostId: "local",
      cwd: input.workspaceRoot,
      mode: input.mode,
      context,
    },
    destination: {
      hostId: "local",
      cwd: input.workspaceRoot,
      defaultMode: input.mode,
      defaultContext: context,
      workspaceRoots,
    },
  });
}

function appendUniqueRoots(current: readonly string[], added: readonly string[]): string[] {
  const merged = [...current];
  for (const root of added) {
    if (!merged.includes(root)) merged.push(root);
  }
  return merged;
}

function cloneSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  if (policy.type !== "workspaceWrite") return { ...policy };
  return {
    ...policy,
    writableRoots: [...policy.writableRoots],
  };
}

function clonePermissionContext(
  context: CodexDynamicCreatePermissionContext,
): CodexDynamicCreatePermissionContext {
  return {
    activePermissionProfile: context.activePermissionProfile
      ? { ...context.activePermissionProfile }
      : null,
    ...(context.runtimeWorkspaceRoots === undefined
      ? {}
      : {
          runtimeWorkspaceRoots:
            context.runtimeWorkspaceRoots === null ? null : [...context.runtimeWorkspaceRoots],
        }),
    approvalPolicy:
      typeof context.approvalPolicy === "string"
        ? context.approvalPolicy
        : {
            granular: { ...context.approvalPolicy.granular },
          },
    approvalsReviewer: context.approvalsReviewer,
    sandboxPolicy: cloneSandboxPolicy(context.sandboxPolicy),
  };
}

function mergePermissionContextWorkspaceRoots(
  context: CodexDynamicCreatePermissionContext,
  workspaceRoots: readonly string[],
): CodexDynamicCreatePermissionContext {
  const sandboxPolicy =
    context.sandboxPolicy.type === "workspaceWrite"
      ? {
          ...context.sandboxPolicy,
          writableRoots: appendUniqueRoots(context.sandboxPolicy.writableRoots, workspaceRoots),
        }
      : cloneSandboxPolicy(context.sandboxPolicy);
  return {
    ...clonePermissionContext(context),
    runtimeWorkspaceRoots: appendUniqueRoots(context.runtimeWorkspaceRoots ?? [], workspaceRoots),
    sandboxPolicy,
  };
}

function buildWorkspaceWriteContext(
  workspaceRoots: readonly string[],
  approvalPolicy: AskForApproval,
): CodexDynamicCreatePermissionContext {
  return {
    activePermissionProfile: {
      id: ":workspace",
      extends: null,
    },
    approvalPolicy,
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...workspaceRoots],
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
    },
  };
}

function buildBuiltInModeContext(
  mode: Exclude<CodexDynamicCreatePermissionMode, "custom" | "guardian-approvals">,
  workspaceRoots: readonly string[],
): CodexDynamicCreatePermissionContext {
  if (mode === "read-only") {
    return {
      activePermissionProfile: {
        id: ":read-only",
        extends: null,
      },
      runtimeWorkspaceRoots: [...workspaceRoots],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    };
  }

  if (mode === "full-access") {
    return {
      activePermissionProfile: {
        id: ":danger-full-access",
        extends: null,
      },
      runtimeWorkspaceRoots: [...workspaceRoots],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    };
  }

  return buildWorkspaceWriteContext(
    workspaceRoots,
    mode === "granular" ? GRANULAR_APPROVAL_POLICY : "on-request",
  );
}

function selectSourceForDestination(
  source: CodexDynamicCreatePermissionSource | null,
  destination: CodexDynamicCreatePermissionDestination,
): CodexDynamicCreatePermissionSource | null {
  if (!source || source.hostId !== destination.hostId) return null;
  if (source.cwd === destination.cwd) return source;
  if (source.mode === "custom" || source.mode === "guardian-approvals") return null;
  const profileId = source.context.activePermissionProfile?.id;
  return profileId?.startsWith(":") === true ? source : null;
}

function resolveSelectedContext(
  source: CodexDynamicCreatePermissionSource | null,
  destination: CodexDynamicCreatePermissionDestination,
): CodexDynamicCreatePermissionContext {
  if (!source) return clonePermissionContext(destination.defaultContext);
  if (source.cwd === destination.cwd) {
    return mergePermissionContextWorkspaceRoots(source.context, destination.workspaceRoots);
  }

  if (source.mode === "custom" || source.mode === "guardian-approvals") {
    return clonePermissionContext(destination.defaultContext);
  }
  const profileId = source.context.activePermissionProfile?.id;
  if (!profileId?.startsWith(":")) return clonePermissionContext(destination.defaultContext);

  const rebased = buildBuiltInModeContext(source.mode, destination.workspaceRoots);
  return {
    ...rebased,
    activePermissionProfile: {
      id: profileId,
      extends: null,
    },
    runtimeWorkspaceRoots: [...destination.workspaceRoots],
  };
}

function sandboxModeFromPolicy(policy: SandboxPolicy): SandboxMode | null {
  if (policy.type === "dangerFullAccess") return "danger-full-access";
  if (policy.type === "readOnly") return "read-only";
  if (policy.type === "workspaceWrite") return "workspace-write";
  return null;
}

function effectiveRuntimeWorkspaceRoots(context: CodexDynamicCreatePermissionContext): string[] {
  if (context.runtimeWorkspaceRoots !== null && context.runtimeWorkspaceRoots !== undefined) {
    return [...context.runtimeWorkspaceRoots];
  }
  return context.sandboxPolicy.type === "workspaceWrite"
    ? [...context.sandboxPolicy.writableRoots]
    : [];
}

function buildLaunchParams(
  context: CodexDynamicCreatePermissionContext,
): CodexDynamicCreateThreadLaunchPermissionParams {
  const base = {
    approvalPolicy: context.approvalPolicy,
    approvalsReviewer: context.approvalsReviewer,
  };
  if (!context.activePermissionProfile) {
    return {
      ...base,
      sandbox: sandboxModeFromPolicy(context.sandboxPolicy),
    };
  }
  return {
    ...base,
    permissions: context.activePermissionProfile.id,
    runtimeWorkspaceRoots: effectiveRuntimeWorkspaceRoots(context),
  };
}

function buildTurnParams(
  context: CodexDynamicCreatePermissionContext,
): CodexDynamicCreateTurnPermissionParams {
  const base = {
    approvalPolicy: context.approvalPolicy,
    approvalsReviewer: context.approvalsReviewer,
  };
  if (!context.activePermissionProfile) {
    return {
      ...base,
      sandboxPolicy: cloneSandboxPolicy(context.sandboxPolicy),
    };
  }
  return {
    ...base,
    permissions: context.activePermissionProfile.id,
    runtimeWorkspaceRoots: effectiveRuntimeWorkspaceRoots(context),
  };
}

export function resolveCodexDynamicCreatePermissionSelection(
  input: ResolveCodexDynamicCreatePermissionSelectionInput,
): CodexDynamicCreatePermissionSelection {
  const selectedSource = selectSourceForDestination(input.source, input.destination);
  const context = resolveSelectedContext(selectedSource, input.destination);
  const sourcePermissionProfileId = selectedSource?.context.activePermissionProfile?.id;
  return {
    context,
    launchParams: buildLaunchParams(context),
    mode: selectedSource?.mode ?? input.destination.defaultMode,
    ...(sourcePermissionProfileId === undefined ? {} : { sourcePermissionProfileId }),
    turnParams: buildTurnParams(context),
  };
}
