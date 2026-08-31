import * as path from "node:path";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { ConfigRequirements } from "@nodex/codex-app-server-protocol/v2/ConfigRequirements";
import type { ConfigEdit } from "@nodex/codex-app-server-protocol/v2/ConfigEdit";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2/SandboxPolicy";
import type { SandboxWorkspaceWrite } from "@nodex/codex-app-server-protocol/v2/SandboxWorkspaceWrite";
import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexPermissionMode,
  CodexPermissionPreset,
  CodexPermissionState,
  CodexSandboxMode,
} from "../../shared/types";

const GUARDIAN_APPROVAL_FEATURE_KEY = "guardian_approval";
const FLAT_GUARDIAN_APPROVAL_FEATURE_KEY = `features.${GUARDIAN_APPROVAL_FEATURE_KEY}`;
const APPROVALS_REVIEWER_KEY = "approvals_reviewer";
const DEFAULT_APPROVALS_REVIEWER: CodexApprovalsReviewer = "user";
const AUTO_REVIEW_APPROVALS_REVIEWER: CodexApprovalsReviewer = "auto_review";
const LEGACY_AUTO_REVIEW_APPROVALS_REVIEWER: CodexApprovalsReviewer = "guardian_subagent";
const READ_ONLY_PERMISSION_PROFILE_ID = ":read-only";
const WORKSPACE_PERMISSION_PROFILE_ID = ":workspace";
export const FULL_ACCESS_PERMISSION_PROFILE_ID = ":danger-full-access";

interface ResolvedPreset {
  preset: CodexPermissionPreset;
  permissionProfileId: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer: CodexApprovalsReviewer;
}

interface PermissionConfigTarget {
  source: CodexPermissionState["configTarget"]["source"];
  filePath: string | null;
}

const READ_ONLY_PRESET: ResolvedPreset = {
  preset: "read-only",
  permissionProfileId: READ_ONLY_PERMISSION_PROFILE_ID,
  sandboxMode: "read-only",
  approvalPolicy: "on-request",
  approvalsReviewer: DEFAULT_APPROVALS_REVIEWER,
};

const AUTO_PRESET: ResolvedPreset = {
  preset: "auto",
  permissionProfileId: WORKSPACE_PERMISSION_PROFILE_ID,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  approvalsReviewer: DEFAULT_APPROVALS_REVIEWER,
};

const GUARDIAN_PRESET: ResolvedPreset = {
  preset: "guardian-approvals",
  permissionProfileId: WORKSPACE_PERMISSION_PROFILE_ID,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  approvalsReviewer: AUTO_REVIEW_APPROVALS_REVIEWER,
};

const FULL_ACCESS_PRESET: ResolvedPreset = {
  preset: "full-access",
  permissionProfileId: FULL_ACCESS_PERMISSION_PROFILE_ID,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  approvalsReviewer: DEFAULT_APPROVALS_REVIEWER,
};

const INTERNAL_PRESETS: ResolvedPreset[] = [
  READ_ONLY_PRESET,
  AUTO_PRESET,
  GUARDIAN_PRESET,
  FULL_ACCESS_PRESET,
];

const VISIBLE_MODE_ORDER: CodexPermissionMode[] = [
  "auto",
  "guardian-approvals",
  "full-access",
  "custom",
];

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isAutomaticApprovalsReviewer(value: unknown): value is CodexApprovalsReviewer {
  return (
    value === AUTO_REVIEW_APPROVALS_REVIEWER || value === LEGACY_AUTO_REVIEW_APPROVALS_REVIEWER
  );
}

function readNestedBooleanFeature(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const direct = (value as Record<string, unknown>)[key];
  return isBoolean(direct) ? direct : null;
}

function readAutoReviewFeatureGate(
  config: ConfigReadResponse["config"],
  requirements: ConfigRequirements | null,
): boolean | null {
  const candidates = [
    config[FLAT_GUARDIAN_APPROVAL_FEATURE_KEY],
    readNestedBooleanFeature(config.features, GUARDIAN_APPROVAL_FEATURE_KEY),
    readNestedBooleanFeature(requirements?.featureRequirements, GUARDIAN_APPROVAL_FEATURE_KEY),
  ];

  if (candidates.some((candidate) => candidate === false)) return false;
  if (candidates.some((candidate) => candidate === true)) return true;
  return null;
}

function isReviewerAllowed(
  reviewer: CodexApprovalsReviewer,
  allowedReviewers: readonly CodexApprovalsReviewer[] | null | undefined,
): boolean {
  if (!allowedReviewers) return true;
  if (isAutomaticApprovalsReviewer(reviewer)) {
    return allowedReviewers.some(isAutomaticApprovalsReviewer);
  }
  return allowedReviewers.includes(reviewer);
}

function resolveAutoReviewAvailability(
  config: ConfigReadResponse["config"],
  requirements: ConfigRequirements | null,
): boolean {
  if (readAutoReviewFeatureGate(config, requirements) === false) return false;
  return isPresetAllowed(GUARDIAN_PRESET, requirements);
}

function normalizeApprovalsReviewer(
  reviewer: unknown,
  autoReviewAvailable: boolean,
): CodexApprovalsReviewer {
  if (!isAutomaticApprovalsReviewer(reviewer)) {
    return DEFAULT_APPROVALS_REVIEWER;
  }
  return autoReviewAvailable ? AUTO_REVIEW_APPROVALS_REVIEWER : DEFAULT_APPROVALS_REVIEWER;
}

function isPermissionProfileAllowed(
  permissionProfileId: string,
  requirements: ConfigRequirements | null,
): boolean {
  const allowedPermissionProfiles = requirements?.allowedPermissionProfiles ?? null;
  return (
    allowedPermissionProfiles == null || allowedPermissionProfiles[permissionProfileId] === true
  );
}

function isPresetAllowed(preset: ResolvedPreset, requirements: ConfigRequirements | null): boolean {
  if (!isPermissionProfileAllowed(preset.permissionProfileId, requirements)) {
    return false;
  }

  const allowedApprovalPolicies = requirements?.allowedApprovalPolicies ?? null;
  if (allowedApprovalPolicies && !allowedApprovalPolicies.includes(preset.approvalPolicy)) {
    return false;
  }

  const allowedSandboxModes = requirements?.allowedSandboxModes ?? null;
  if (allowedSandboxModes && !allowedSandboxModes.includes(preset.sandboxMode)) {
    return false;
  }

  return isReviewerAllowed(preset.approvalsReviewer, requirements?.allowedApprovalsReviewers);
}

function listAvailablePresets(requirements: ConfigRequirements | null): ResolvedPreset[] {
  return INTERNAL_PRESETS.filter((preset) => isPresetAllowed(preset, requirements));
}

function normalizeWorkspaceRoots(workspaceRoots: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of workspaceRoots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

function buildWorkspaceWriteSandboxPolicy(
  workspaceRoots: readonly string[],
  sandboxWorkspaceWrite: SandboxWorkspaceWrite | null | undefined,
): Extract<SandboxPolicy, { type: "workspaceWrite" }> {
  return {
    type: "workspaceWrite",
    writableRoots: normalizeWorkspaceRoots(workspaceRoots),
    networkAccess: sandboxWorkspaceWrite?.network_access ?? false,
    excludeTmpdirEnvVar: sandboxWorkspaceWrite?.exclude_tmpdir_env_var ?? false,
    excludeSlashTmp: sandboxWorkspaceWrite?.exclude_slash_tmp ?? false,
  };
}

function buildSandboxPolicy(
  sandboxMode: CodexSandboxMode | null,
  workspaceRoots: readonly string[],
  sandboxWorkspaceWrite: SandboxWorkspaceWrite | null | undefined,
): SandboxPolicy | null {
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (sandboxMode === "read-only") {
    return {
      type: "readOnly",
      networkAccess: sandboxWorkspaceWrite?.network_access ?? false,
    };
  }

  if (sandboxMode === "workspace-write" && workspaceRoots.length > 0) {
    return buildWorkspaceWriteSandboxPolicy(workspaceRoots, sandboxWorkspaceWrite);
  }

  return null;
}

function listVisibleModes(
  requirements: ConfigRequirements | null,
  autoReviewAvailable: boolean,
): CodexPermissionMode[] {
  const availablePresets = listAvailablePresets(requirements);
  const modes = new Set<CodexPermissionMode>();

  for (const preset of availablePresets) {
    if (preset.preset === "read-only") continue;
    if (preset.preset === "guardian-approvals" && !autoReviewAvailable) continue;
    modes.add(preset.preset);
  }

  return VISIBLE_MODE_ORDER.filter((mode) => modes.has(mode));
}

function isRepresentableCustomState(
  sandboxMode: CodexSandboxMode | null,
  approvalPolicy: CodexApprovalPolicy | null,
  approvalsReviewer: CodexApprovalsReviewer,
  requirements: ConfigRequirements | null,
): boolean {
  if (!sandboxMode || !approvalPolicy) return false;

  const allowedApprovalPolicies = requirements?.allowedApprovalPolicies ?? null;
  if (allowedApprovalPolicies && !allowedApprovalPolicies.includes(approvalPolicy)) {
    return false;
  }

  const allowedSandboxModes = requirements?.allowedSandboxModes ?? null;
  if (allowedSandboxModes && !allowedSandboxModes.includes(sandboxMode)) {
    return false;
  }

  if (requirements?.allowedPermissionProfiles != null) {
    return false;
  }

  return isReviewerAllowed(approvalsReviewer, requirements?.allowedApprovalsReviewers);
}

function resolvePresetFromEffectiveState(input: {
  sandboxMode: CodexSandboxMode | null;
  approvalPolicy: CodexApprovalPolicy | null;
  approvalsReviewer: CodexApprovalsReviewer;
}): CodexPermissionPreset | null {
  if (input.sandboxMode === "read-only" && input.approvalPolicy === "on-request") {
    return "read-only";
  }

  if (input.sandboxMode === "danger-full-access" && input.approvalPolicy === "never") {
    return "full-access";
  }

  if (input.sandboxMode === "workspace-write" && input.approvalPolicy === "on-request") {
    return isAutomaticApprovalsReviewer(input.approvalsReviewer) ? "guardian-approvals" : "auto";
  }

  return null;
}

function resolveFallbackPreset(
  requirements: ConfigRequirements | null,
  autoReviewAvailable: boolean,
): ResolvedPreset {
  const availablePresets = listAvailablePresets(requirements);
  const preferredOrder: CodexPermissionPreset[] = autoReviewAvailable
    ? ["auto", "guardian-approvals", "full-access", "read-only"]
    : ["auto", "full-access", "read-only"];

  for (const presetName of preferredOrder) {
    const preset = availablePresets.find((candidate) => candidate.preset === presetName);
    if (preset) return preset;
  }

  return AUTO_PRESET;
}

function resolveConfigTarget(input: {
  origins: ConfigReadResponse["origins"];
  defaultUserConfigPath: string;
}): PermissionConfigTarget {
  const originKeys = [
    "approval_policy",
    "sandbox_mode",
    APPROVALS_REVIEWER_KEY,
    "sandbox_workspace_write",
  ];

  for (const key of originKeys) {
    const origin = input.origins[key];
    const source = origin?.name;
    if (!source) continue;

    if (source.type === "project") {
      return {
        source: "project",
        filePath: path.join(source.dotCodexFolder, "config.toml"),
      };
    }

    if (source.type === "user") {
      return {
        source: "user",
        filePath: source.file,
      };
    }
  }

  return {
    source: "user",
    filePath: input.defaultUserConfigPath,
  };
}

export function resolveCodexPermissionState(input: {
  config: ConfigReadResponse["config"];
  origins: ConfigReadResponse["origins"];
  requirements: ConfigRequirements | null;
  defaultUserConfigPath: string;
  workspaceRoots: string[];
}): CodexPermissionState {
  const autoReviewAvailable = resolveAutoReviewAvailability(input.config, input.requirements);
  const sandboxMode = input.config.sandbox_mode ?? null;
  const approvalPolicy = input.config.approval_policy ?? null;
  const approvalsReviewer = normalizeApprovalsReviewer(
    input.config.approvals_reviewer,
    autoReviewAvailable,
  );
  const availableModes = listVisibleModes(input.requirements, autoReviewAvailable);
  const matchedPreset = resolvePresetFromEffectiveState({
    sandboxMode,
    approvalPolicy,
    approvalsReviewer,
  });
  const configTarget = resolveConfigTarget({
    origins: input.origins,
    defaultUserConfigPath: input.defaultUserConfigPath,
  });
  const fallbackPreset = resolveFallbackPreset(input.requirements, autoReviewAvailable);
  const matchedResolvedPreset = matchedPreset
    ? (INTERNAL_PRESETS.find((preset) => preset.preset === matchedPreset) ?? null)
    : null;
  const matchedPresetAllowed =
    matchedResolvedPreset !== null &&
    isPresetAllowed(matchedResolvedPreset, input.requirements) &&
    (matchedPreset !== "guardian-approvals" || autoReviewAvailable);
  const explicitKeys =
    input.origins.approval_policy ||
    input.origins.sandbox_mode ||
    input.origins[APPROVALS_REVIEWER_KEY];
  const hasRepresentableExplicitConfig =
    Boolean(explicitKeys) &&
    isRepresentableCustomState(sandboxMode, approvalPolicy, approvalsReviewer, input.requirements);
  const useFreshProfileDefault =
    !explicitKeys &&
    (matchedPreset === null || matchedPreset === "auto") &&
    autoReviewAvailable &&
    availableModes.includes("guardian-approvals");
  // Raw config values describe effective Codex sandbox behavior, not proof that
  // the user selected one of Nodex's built-in presets. Main may overlay a
  // separately persisted built-in selection after validating these values.
  const isCustom = hasRepresentableExplicitConfig;
  const effectivePreset = isCustom
    ? "custom"
    : useFreshProfileDefault
      ? "guardian-approvals"
      : matchedResolvedPreset && matchedPresetAllowed
        ? matchedResolvedPreset.preset
        : fallbackPreset.preset;
  const effectiveResolvedPreset =
    effectivePreset === "custom"
      ? null
      : (INTERNAL_PRESETS.find((preset) => preset.preset === effectivePreset) ?? fallbackPreset);

  const visibleMode: CodexPermissionMode = isCustom
    ? "custom"
    : effectivePreset === "read-only"
      ? "custom"
      : effectivePreset;
  const nextAvailableModes: CodexPermissionMode[] =
    hasRepresentableExplicitConfig && !availableModes.includes("custom")
      ? [...availableModes, "custom"]
      : availableModes;

  return {
    mode: visibleMode,
    effectivePreset,
    availableModes: nextAvailableModes,
    approvalPolicy: effectiveResolvedPreset?.approvalPolicy ?? approvalPolicy,
    approvalsReviewer: effectiveResolvedPreset?.approvalsReviewer ?? approvalsReviewer,
    sandboxMode: effectiveResolvedPreset?.sandboxMode ?? sandboxMode,
    sandbox: buildSandboxPolicy(
      effectiveResolvedPreset?.sandboxMode ?? sandboxMode,
      input.workspaceRoots,
      input.config.sandbox_workspace_write,
    ),
    autoReviewAvailable,
    configTarget,
  };
}

export function buildPermissionModeConfigEdits(mode: CodexPermissionMode): ConfigEdit[] {
  if (mode === "custom") {
    return [];
  }

  const preset =
    mode === "guardian-approvals"
      ? GUARDIAN_PRESET
      : mode === "full-access"
        ? FULL_ACCESS_PRESET
        : AUTO_PRESET;

  return [
    {
      keyPath: "sandbox_mode",
      value: preset.sandboxMode,
      mergeStrategy: "replace",
    },
    {
      keyPath: "approval_policy",
      value: preset.approvalPolicy,
      mergeStrategy: "replace",
    },
    {
      keyPath: APPROVALS_REVIEWER_KEY,
      value: preset.approvalsReviewer,
      mergeStrategy: "replace",
    },
  ];
}

export function buildTurnPermissionOverrides(input: {
  permissionState: CodexPermissionState;
  workspaceRoots: string[];
}): {
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandboxPolicy?: SandboxPolicy;
} {
  if (input.permissionState.effectivePreset === "custom") {
    return {};
  }

  const sandboxPolicy = buildSandboxPolicy(
    input.permissionState.sandboxMode,
    input.workspaceRoots,
    {
      writable_roots: input.workspaceRoots,
      network_access:
        input.permissionState.sandbox?.type === "workspaceWrite"
          ? input.permissionState.sandbox.networkAccess
          : false,
      exclude_tmpdir_env_var:
        input.permissionState.sandbox?.type === "workspaceWrite"
          ? input.permissionState.sandbox.excludeTmpdirEnvVar
          : false,
      exclude_slash_tmp:
        input.permissionState.sandbox?.type === "workspaceWrite"
          ? input.permissionState.sandbox.excludeSlashTmp
          : false,
    },
  );

  return {
    ...(input.permissionState.approvalPolicy
      ? { approvalPolicy: input.permissionState.approvalPolicy }
      : {}),
    approvalsReviewer: input.permissionState.approvalsReviewer,
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  };
}

export function buildThreadPermissionOverrides(input: { permissionState: CodexPermissionState }): {
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandbox?: CodexSandboxMode;
} {
  if (input.permissionState.effectivePreset === "custom") {
    return {};
  }

  return {
    ...(input.permissionState.approvalPolicy
      ? { approvalPolicy: input.permissionState.approvalPolicy }
      : {}),
    approvalsReviewer: input.permissionState.approvalsReviewer,
    ...(input.permissionState.sandboxMode ? { sandbox: input.permissionState.sandboxMode } : {}),
  };
}
