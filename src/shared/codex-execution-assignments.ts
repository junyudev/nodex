export const CODEX_EXECUTION_STATSIG_SDK_KEY = "client-sYWqzCYMRkUg4DqqiZcR5DGTNl2iD7zNJY0HoeDLzxR";

export const CODEX_PERMISSION_REFRESH_GATE = "codex-app-permission-refresh";
export const CODEX_PERMISSION_REFRESH_GATE_HASH = "4226282475";

export const CODEX_EXECUTION_ASSIGNMENT_GATES = {
  artifactSession: "1950211113",
  artifactTemplatePicker: "183803860",
  automaticTitles: "1091791504",
  localThreadStoreCompression: "1538937767",
  mcp20260728: "2797990056",
  curatedRemoteMarketplace: "4218407052",
  backgroundPaginatedRolloutMigration: "218512289",
  presentationOutlinesTargeting: "423161634",
  permissionRefresh: CODEX_PERMISSION_REFRESH_GATE_HASH,
  threadQueue: "2120612410",
} as const;

export const CODEX_EXECUTION_ASSIGNMENT_CONFIGS = {
  artifactTemplatePicker: "1748737189",
  guardianV2Experiment: "1055689174",
  guardianV2Defaults: "2553103476",
  featureOverrides: "3902942138",
} as const;

export const CODEX_EXECUTION_ASSIGNMENT_LAYERS = {
  presentationOutlines: "2470976080",
  instructions: "1574672957",
} as const;

export const CODEX_EXECUTION_ASSIGNMENT_EXPERIMENTS = {
  personality: "1867347216",
} as const;

export const CODEX_EXECUTION_FEATURE_GATE_MAPPINGS = [
  ["3013700042", "apply_patch_preserve_line_endings"],
  ["1786883712", "unified_exec"],
  ["2200661400", "unified_image_budget"],
  ["241701189", "code_mode_buffered_exec"],
  ["1398371767", "code_mode_interrupt"],
  ["4173592727", "executed_tool_call_metadata"],
  ["1615536597", "shell_snapshot"],
  ["3342304550", "shell_snapshot_v2"],
  ["770526561", "remote_models"],
  ["2734851136", "responses_websockets_v2"],
  ["3701003275", "standalone_web_search"],
  ["1156958996", "collaboration_modes"],
  ["2929104770", "default_mode_request_user_input"],
  ["3390468622", "request_rule"],
  ["1935276618", "image_generation"],
  ["3762443246", "item_ids"],
  ["138621433", "image_detail_original"],
  ["2598928189", "image_resize_notice"],
  ["2307253562", "codex_git_commit"],
  ["3026692602", "workspace_dependencies"],
  ["3902016271", "guardian_approval"],
  ["1690660828", "write_stdin_approval"],
  ["2731805027", "guardian_reuse_parent_compaction"],
  ["1663911278", "apps_mcp_path_override"],
  ["3987662990", "mcp_oauth_refresh_coordination"],
  ["2701734443", "tool_search_always_defer_mcp_tools"],
  ["1693082043", "deferred_tool_world_state"],
  ["2395575782", "thread_tools"],
  ["1859936703", "settings_tools"],
  ["2707717541", "writing_blocks"],
  ["2508143457", "concurrent_reasoning_summaries"],
] as const;

export const CODEX_EXECUTION_DYNAMIC_FEATURE_ALLOWLIST = new Set([
  "powershell_shell_version",
  "shell_snapshot",
  "shell_snapshot_v2",
  "unified_exec",
  "write_stdin_approval",
  "code_mode_buffered_exec",
  "code_mode_interrupt",
  "responses_websockets_v2",
  "default_mode_request_user_input",
  "tool_search_always_defer_mcp_tools",
  "deferred_tool_world_state",
  "image_generation_sse",
  "compaction_image_budget",
]);

export const CODEX_EXECUTION_FEATURE_LAYERS = [
  { layerName: "2138468235", param: "enable_mcp_apps", featureKeys: ["enable_mcp_apps"] },
  {
    layerName: "223073164",
    param: "enable_plugins",
    featureKeys: ["apps", "plugins", "recommended_plugins"],
  },
  { layerName: "223073164", param: "enable_tool_suggest", featureKeys: ["tool_suggest"] },
  {
    layerName: "223073164",
    param: "enable_auth_elicitation",
    featureKeys: ["auth_elicitation"],
  },
  {
    layerName: "223073164",
    param: "enable_tool_call_mcp_elicitation",
    featureKeys: ["tool_call_mcp_elicitation"],
  },
] as const;

const CODEX_EXECUTION_THREAD_CONFIG_EXCLUDED_FEATURES = new Set([
  "auth_elicitation",
  "plugins",
  "apps",
  "tool_suggest",
  "tool_call_mcp_elicitation",
  "writing_blocks",
]);

const CODEX_EXECUTION_APP_SERVER_FEATURE_MINIMUMS = {
  applyPatchPreserveLineEndings: "0.148.0-alpha.6",
  compactionImageBudget: "0.149.1",
  deferredToolWorldState: "0.146.0-alpha.6",
  mcpOauthRefreshCoordination: "0.154.0-alpha.1",
  guardianV2StructuredConfig: "0.148.0-alpha.18",
  recommendedPlugins: "0.147.0-alpha.1",
} as const;

export const CODEX_EXECUTION_TOOL_CATALOG_GATES = {
  crossHostHandoff: "2256010998",
  projectTools: "3672665",
  threadPullRequestAssociations: "465741219",
  shareThread: "4157559322",
  multiAgentMode: "1186680773",
  sidebarCustomSections: "2413345355",
} as const;

export const CODEX_EXECUTION_TOOL_CATALOG_CONFIGS = {
  modelAvailability: "107580212",
  realtimeConversationPrompt: "1193530394",
} as const;

export interface CodexExecutionAssignmentIdentity {
  readonly userId: string | null;
  readonly accountId: string | null;
  readonly authMethod: string | null;
  readonly stableId: string | null;
}

export interface CodexGuardianV2Experiment {
  readonly min_app_server_version: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface CodexExecutionToolCatalog {
  readonly gates: {
    readonly crossHostHandoff: boolean;
    readonly projectTools: boolean;
    readonly threadPullRequestAssociations: boolean;
    readonly shareThread: boolean;
    readonly multiAgentMode: boolean;
    readonly sidebarCustomSections: boolean;
  };
  readonly restrictedGates: Readonly<Record<string, boolean>>;
  readonly configs: {
    readonly modelAvailability: Readonly<Record<string, unknown>>;
    readonly realtimeConversationPrompt: Readonly<Record<string, unknown>>;
  };
}

export interface CodexExecutionAssignmentValues {
  readonly guardianV2Experiment?: CodexGuardianV2Experiment;
  readonly artifactSession: boolean;
  readonly artifactTemplatePicker: boolean;
  readonly automaticTitles: boolean;
  readonly experimentalFeatureGates: {
    readonly localThreadStoreCompression: boolean;
    readonly mcp20260728: boolean;
    readonly curatedRemoteMarketplace: boolean;
    readonly backgroundPaginatedRolloutMigration: boolean;
  };
  readonly toolCatalog: CodexExecutionToolCatalog;
  readonly presentationOutlinesTargeting: boolean;
  readonly presentationOutlines: Readonly<Record<string, unknown>>;
  readonly permissionRefresh: boolean;
  readonly threadQueue: boolean;
  readonly personality: Readonly<Record<string, unknown>>;
  readonly instructions: Readonly<Record<string, unknown>>;
}

export type CodexExecutionAssignmentsPublication = CodexExecutionAssignmentIdentity & {
  readonly sdkKey?: string;
  /** Undefined means evaluations are still loading. Null means loading completed without values. */
  readonly payload?: string | null;
  readonly defaultEnableFeatures?: Readonly<Record<string, unknown>>;
  readonly executionValues?: CodexExecutionAssignmentValues;
};

export interface CodexExecutionAssignmentsSnapshot {
  readonly permissionRefresh: boolean | null;
  readonly threadQueue: boolean | null;
}

export interface CodexReadyExecutionAssignments {
  readonly identity: CodexExecutionAssignmentIdentity;
  readonly values: CodexExecutionAssignmentValues;
  readonly defaultEnableFeatures: Readonly<Record<string, unknown>>;
}

export interface CodexExecutionInstructionOverrides {
  readonly desktopContextSection?: string;
  readonly workspaceDependenciesSection?: string;
  readonly memoryReadPrompt?: string;
  readonly memoryPhaseOnePrompt?: string;
  readonly memoryPhaseTwoPrompt?: string;
}

const CODEX_EXECUTION_MEMORY_PROMPT_LIMIT_BYTES = 64 * 1024;

const parseTrimmedOptionalString = (value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  return value.trim() || undefined;
};

const parseMemoryPrompt = (value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  if (value.length > CODEX_EXECUTION_MEMORY_PROMPT_LIMIT_BYTES) return null;
  if (new TextEncoder().encode(value).byteLength > CODEX_EXECUTION_MEMORY_PROMPT_LIMIT_BYTES)
    return null;
  return value.trim() ? value : undefined;
};

/** Parses the model-scoped instruction experiment using the desktop client's exact limits. */
export function parseCodexExecutionInstructionOverrides(
  value: unknown,
): CodexExecutionInstructionOverrides | null {
  if (!isPlainRecord(value)) return null;
  const desktopContextSection = parseTrimmedOptionalString(value.desktop_context_section);
  const workspaceDependenciesSection = parseTrimmedOptionalString(
    value.workspace_dependencies_section,
  );
  const memoryReadPrompt = parseMemoryPrompt(value.memory_read_prompt);
  const memoryPhaseOnePrompt = parseMemoryPrompt(value.memory_phase_one_prompt);
  const memoryPhaseTwoPrompt = parseMemoryPrompt(value.memory_phase_two_prompt);
  if (
    desktopContextSection === null ||
    workspaceDependenciesSection === null ||
    memoryReadPrompt === null ||
    memoryPhaseOnePrompt === null ||
    memoryPhaseTwoPrompt === null
  )
    return null;
  if (
    desktopContextSection === undefined &&
    workspaceDependenciesSection === undefined &&
    memoryReadPrompt === undefined &&
    memoryPhaseOnePrompt === undefined &&
    memoryPhaseTwoPrompt === undefined
  )
    return null;
  return {
    ...(desktopContextSection === undefined ? {} : { desktopContextSection }),
    ...(workspaceDependenciesSection === undefined ? {} : { workspaceDependenciesSection }),
    ...(memoryReadPrompt === undefined ? {} : { memoryReadPrompt }),
    ...(memoryPhaseOnePrompt === undefined ? {} : { memoryPhaseOnePrompt }),
    ...(memoryPhaseTwoPrompt === undefined ? {} : { memoryPhaseTwoPrompt }),
  };
}

/** Memory experiment fields are app-server config overrides only on the local desktop runtime. */
export function projectCodexExecutionMemoryPromptsToThreadConfig(
  overrides: CodexExecutionInstructionOverrides | null,
): Readonly<Record<string, unknown>> {
  if (!overrides) return {};
  return {
    ...(overrides.memoryReadPrompt === undefined
      ? {}
      : { "memories.read_prompt": overrides.memoryReadPrompt }),
    ...(overrides.memoryPhaseOnePrompt === undefined
      ? {}
      : { "memories.phase_one_prompt": overrides.memoryPhaseOnePrompt }),
    ...(overrides.memoryPhaseTwoPrompt === undefined
      ? {}
      : { "memories.phase_two_prompt": overrides.memoryPhaseTwoPrompt }),
  };
}

const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*)";
const SEMVER_NON_NUMERIC_IDENTIFIER = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PRERELEASE_IDENTIFIER = `(?:${SEMVER_IDENTIFIER}|${SEMVER_NON_NUMERIC_IDENTIFIER})`;
const SEMVER_PATTERN = new RegExp(
  `^${SEMVER_IDENTIFIER}\\.${SEMVER_IDENTIFIER}\\.${SEMVER_IDENTIFIER}(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);

interface ParsedSemanticVersion {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[] | null;
}

const parseSemanticVersion = (value: string): ParsedSemanticVersion | null => {
  if (!SEMVER_PATTERN.test(value)) return null;
  const coreAndPrerelease = value.split("+", 1)[0]!;
  const separator = coreAndPrerelease.indexOf("-");
  const core = (separator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, separator)).split(
    ".",
  );
  if (core.length !== 3) return null;
  return {
    core: core as [string, string, string],
    prerelease: separator === -1 ? null : coreAndPrerelease.slice(separator + 1).split("."),
  };
};

const compareNumeric = (left: string, right: string): -1 | 0 | 1 => {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const compareIdentifier = (left: string, right: string): -1 | 0 | 1 => {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return compareNumeric(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

export const compareCodexSemanticVersions = (left: string, right: string): -1 | 0 | 1 | null => {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumeric(parsedLeft.core[index]!, parsedRight.core[index]!);
    if (comparison !== 0) return comparison;
  }
  if (parsedLeft.prerelease === null && parsedRight.prerelease === null) return 0;
  if (parsedLeft.prerelease === null) return 1;
  if (parsedRight.prerelease === null) return -1;
  const length = Math.min(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIdentifier(
      parsedLeft.prerelease[index]!,
      parsedRight.prerelease[index]!,
    );
    if (comparison !== 0) return comparison;
  }
  if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0;
  return parsedLeft.prerelease.length < parsedRight.prerelease.length ? -1 : 1;
};

export const isCodexSemanticVersion = (value: string): boolean =>
  parseSemanticVersion(value) !== null;

export const emptyCodexExecutionToolCatalog = (): CodexExecutionToolCatalog => ({
  gates: {
    crossHostHandoff: false,
    projectTools: false,
    threadPullRequestAssociations: false,
    shareThread: false,
    multiAgentMode: false,
    sidebarCustomSections: false,
  },
  restrictedGates: {},
  configs: { modelAvailability: {}, realtimeConversationPrompt: {} },
});

export const emptyCodexExecutionAssignmentValues = (): CodexExecutionAssignmentValues => ({
  artifactSession: false,
  artifactTemplatePicker: false,
  automaticTitles: false,
  experimentalFeatureGates: {
    localThreadStoreCompression: false,
    mcp20260728: false,
    curatedRemoteMarketplace: false,
    backgroundPaginatedRolloutMigration: false,
  },
  toolCatalog: emptyCodexExecutionToolCatalog(),
  presentationOutlinesTargeting: false,
  presentationOutlines: {},
  permissionRefresh: false,
  threadQueue: false,
  personality: {},
  instructions: {},
});

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBooleanRecord = (value: unknown): value is Readonly<Record<string, boolean>> =>
  isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === "boolean");

export function isCodexExecutionAssignmentValues(
  value: unknown,
): value is CodexExecutionAssignmentValues {
  if (!isPlainRecord(value)) return false;
  if (typeof value.artifactSession !== "boolean") return false;
  if (typeof value.artifactTemplatePicker !== "boolean") return false;
  if (typeof value.automaticTitles !== "boolean") return false;
  if (typeof value.presentationOutlinesTargeting !== "boolean") return false;
  if (typeof value.permissionRefresh !== "boolean") return false;
  if (typeof value.threadQueue !== "boolean") return false;
  if (!isPlainRecord(value.presentationOutlines)) return false;
  if (!isPlainRecord(value.personality)) return false;
  if (!isPlainRecord(value.instructions)) return false;

  const experimental = value.experimentalFeatureGates;
  if (
    !isPlainRecord(experimental) ||
    typeof experimental.localThreadStoreCompression !== "boolean" ||
    typeof experimental.mcp20260728 !== "boolean" ||
    typeof experimental.curatedRemoteMarketplace !== "boolean" ||
    typeof experimental.backgroundPaginatedRolloutMigration !== "boolean"
  )
    return false;

  const catalog = value.toolCatalog;
  if (!isPlainRecord(catalog)) return false;
  const gates = catalog.gates;
  if (
    !isPlainRecord(gates) ||
    typeof gates.crossHostHandoff !== "boolean" ||
    typeof gates.projectTools !== "boolean" ||
    typeof gates.threadPullRequestAssociations !== "boolean" ||
    typeof gates.shareThread !== "boolean" ||
    typeof gates.multiAgentMode !== "boolean" ||
    typeof gates.sidebarCustomSections !== "boolean"
  )
    return false;
  if (!isBooleanRecord(catalog.restrictedGates)) return false;
  if (!isPlainRecord(catalog.configs)) return false;
  if (!isPlainRecord(catalog.configs.modelAvailability)) return false;
  if (!isPlainRecord(catalog.configs.realtimeConversationPrompt)) return false;

  if (value.guardianV2Experiment !== undefined) {
    const guardian = value.guardianV2Experiment;
    if (
      !isPlainRecord(guardian) ||
      typeof guardian.min_app_server_version !== "string" ||
      !isCodexSemanticVersion(guardian.min_app_server_version) ||
      !isPlainRecord(guardian.config)
    )
      return false;
  }
  return true;
}

const mergeGuardianConfig = (
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const previous = result[key];
    result[key] =
      isPlainRecord(previous) && isPlainRecord(value)
        ? mergeGuardianConfig(previous, value)
        : value;
  }
  return result;
};

/** Applies the app-server-version gated guardian v2 experiment over the published defaults. */
export function applyCodexGuardianV2Experiment(
  features: Readonly<Record<string, unknown>>,
  experiment: CodexGuardianV2Experiment | undefined,
  appServerVersion: string | null | undefined,
): Readonly<Record<string, unknown>> {
  if (!experiment || Object.keys(experiment.config).length === 0 || !appServerVersion)
    return features;
  if (!isCodexSemanticVersion(appServerVersion)) return features;
  const minimumComparison = compareCodexSemanticVersions(
    appServerVersion,
    experiment.min_app_server_version,
  );
  if (minimumComparison === null) return features;
  if (appServerVersion !== "0.0.0" && minimumComparison < 0) return features;
  const current = isPlainRecord(features.guardianv2) ? features.guardianv2 : {};
  return { ...features, guardianv2: mergeGuardianConfig(current, experiment.config) };
}

/** User preference only suppresses a remotely-enabled default-mode request-user-input feature. */
export function applyCodexDefaultModeRequestUserInput(
  features: Readonly<Record<string, unknown>> | null,
  enabled: boolean,
): Readonly<Record<string, unknown>> | null {
  if (enabled || features?.default_mode_request_user_input !== true) return features;
  return { ...features, default_mode_request_user_input: false };
}

const supportsCodexExecutionAppServerFeature = (
  appServerVersion: string | null | undefined,
  feature: keyof typeof CODEX_EXECUTION_APP_SERVER_FEATURE_MINIMUMS,
): boolean => {
  if (appServerVersion === "0.0.0") return true;
  if (!appServerVersion || !isCodexSemanticVersion(appServerVersion)) return false;
  if (feature === "compactionImageBudget") {
    if (appServerVersion.startsWith("0.149.0-alpha.4.")) {
      return (compareCodexSemanticVersions(appServerVersion, "0.149.0-alpha.4.3") ?? -1) >= 0;
    }
    if (appServerVersion.startsWith("0.149.0-alpha.7.")) {
      return (compareCodexSemanticVersions(appServerVersion, "0.149.0-alpha.7.3") ?? -1) >= 0;
    }
    if (appServerVersion.startsWith("0.150.0-")) return false;
  }
  return (
    (compareCodexSemanticVersions(
      appServerVersion,
      CODEX_EXECUTION_APP_SERVER_FEATURE_MINIMUMS[feature],
    ) ?? -1) >= 0
  );
};

/** Removes feature overrides whose wire representation is unsupported by this app-server. */
export function filterCodexExecutionFeaturesForAppServer(
  features: Readonly<Record<string, unknown>> | null | undefined,
  appServerVersion: string | null | undefined,
): Readonly<Record<string, unknown>> | null | undefined {
  if (!features) return features;
  let result: Readonly<Record<string, unknown>> = features;
  const omit = (key: string): void => {
    const { [key]: _omitted, ...remaining } = result;
    result = remaining;
  };
  if (
    result.apply_patch_preserve_line_endings !== undefined &&
    !supportsCodexExecutionAppServerFeature(appServerVersion, "applyPatchPreserveLineEndings")
  )
    omit("apply_patch_preserve_line_endings");
  if (
    result.compaction_image_budget !== undefined &&
    !supportsCodexExecutionAppServerFeature(appServerVersion, "compactionImageBudget")
  )
    omit("compaction_image_budget");
  if (
    result.deferred_tool_world_state !== undefined &&
    !supportsCodexExecutionAppServerFeature(appServerVersion, "deferredToolWorldState")
  )
    omit("deferred_tool_world_state");
  if (
    result.mcp_oauth_refresh_coordination !== undefined &&
    !supportsCodexExecutionAppServerFeature(appServerVersion, "mcpOauthRefreshCoordination")
  )
    omit("mcp_oauth_refresh_coordination");
  if (
    result.recommended_plugins !== undefined &&
    !supportsCodexExecutionAppServerFeature(appServerVersion, "recommendedPlugins")
  )
    omit("recommended_plugins");
  const guardian = result.guardianv2;
  if (
    isPlainRecord(guardian) &&
    !supportsCodexExecutionAppServerFeature(appServerVersion, "guardianV2StructuredConfig")
  ) {
    result = { ...result, guardianv2: guardian.enabled === true };
  }
  return result;
}

const normalizeCodexExecutionFeatureKey = (key: string): string =>
  key.startsWith("features.") ? key.slice("features.".length) : key;

/** Projects execution defaults into the exact thread/start config namespace. */
export function projectCodexExecutionFeaturesToThreadConfig(
  features: Readonly<Record<string, unknown>> | null | undefined,
): Readonly<Record<string, unknown>> {
  if (!features) return {};
  return Object.fromEntries(
    Object.entries(features).flatMap(([key, value]) => {
      const normalized = normalizeCodexExecutionFeatureKey(key);
      return CODEX_EXECUTION_THREAD_CONFIG_EXCLUDED_FEATURES.has(normalized)
        ? []
        : [[`features.${normalized}`, value]];
    }),
  );
}

export interface CodexExecutionStatsigUser {
  readonly userID?: string;
  readonly email?: string;
  readonly locale?: string;
  readonly appVersion?: string;
  readonly customIDs?: Readonly<Record<string, string>>;
  readonly custom?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export interface CodexExecutionStatsigBootstrap {
  readonly sdkKey: string;
  readonly statsigPayload: string | null;
  readonly user: CodexExecutionStatsigUser;
}
