import {
  DEFAULT_MINI_SETTINGS,
  MINI_RESTING_MODES,
  type MiniAnchor,
  type MiniResting,
  type MiniSettings,
} from "../../shared/mini";
import { withAgentSecretChanges } from "./agent-environment-storage";
import {
  hasLegacyAgentProfiles,
  migrateAcpInstanceIds,
  migrateBuiltInAcpInstances,
  migrateLegacyAgentProfiles,
} from "./agent-profile-migration";
import {
  readStoredAgentProfiles,
  presentAgentProfiles,
  resolveAgentProfile,
  writeAgentProfiles,
} from "./agent-profile-store";
import type { AgentProfilesUpdate } from "../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../shared/agents/registry";
import {
  isAppComponentId,
  type AppComponentId,
  type SetAppComponentEnabledInput,
} from "../../shared/app-components";
import {
  PROVIDER_KEY_LIMIT,
  type ProviderKeySettings,
  type ProviderKeyConnection,
} from "../../shared/provider-keys";
import {
  presentProviderKeys,
  readStoredProviderKeys,
  resolveProviderKeySecret,
  writeProviderKeys,
} from "./provider-key-storage";
import type { PluginProjectScope } from "../../shared/agent-plugins/session-plugins";
import {
  decodeState,
  PRODUCT_ANALYTICS_STATE_FILE,
} from "../product-analytics/product-analytics-state";
import { resolveRemoteSignal } from "../../shared/product-analytics/remote-signals";
import {
  ModelPolicySchema,
  DEFAULT_MODEL_POLICY,
  type ModelPolicy,
} from "../../shared/model-policy";
import {
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  TerminalShellSettingsSchema,
  type TerminalShellSettings,
} from "../../shared/terminal-shell-settings";
import { syncDirectorySync } from "../platform/node/filesystem-durability";
import {
  LinkOpeningSettingsSchema,
  DEFAULT_LINK_OPENING_SETTINGS,
  type LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import {
  AgentRuntimeSettingsSchema,
  AgentRuntimeWritingModelSchema,
  DEFAULT_AGENT_RUNTIME_SETTINGS,
  type AgentRuntimeSettings,
  type AgentRuntimeWritingModel,
  type UpdateAgentRuntimeSettingsInput,
} from "../../shared/agent-runtime-settings";
import { AgentRuntimeModeSchema } from "../../shared/schemas/agent-runtime-api";
import {
  AgentInstructionsSettingsSchema,
  DEFAULT_AGENT_INSTRUCTIONS_SETTINGS,
  type AgentInstructionsSettings,
} from "../../shared/agent-instructions-settings";
import {
  UsageMeterSettingsSchema,
  DEFAULT_USAGE_METER_SETTINGS,
  type UsageMeterSettings,
} from "../../shared/usage-meter-settings";
import {
  presentAcpInstances,
  readStoredAcpInstances,
  resolveAcpLaunchConfiguration,
  writeAcpInstances,
} from "./acp-agent-environment";
import {
  ComposerPredictionSettingsSchema,
  DEFAULT_COMPOSER_PREDICTION_SETTINGS,
  type ComposerPredictionSettings,
} from "../../shared/composer-prediction-settings";
import type { SecretEncryptionAdapter } from "../platform/SecretEncryption";
import * as path from "path";
import { getLogger } from "../logging/logger";
import { isSystemTempDirectory } from "../platform/node/system-temp-directory";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { CodexExecutableUpdateSchema } from "../../shared/codex-executable-settings";
import { CodexHomeSettingsUpdateSchema } from "../../shared/codex-home-settings";
import { resolveCodexHome } from "../codex/codex-home";
import { stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX } from "../../shared/worktree-auto-branch";
import {
  applyCommandKeybindingUpdate,
  createCommandKeymapState,
  normalizeCommandKeybindingOverrides,
  type CommandKeybindingOverrides,
  type CommandKeybindingUpdate,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import type {
  AcpAgentSettings,
  AppUpdateSettings,
  BackupSettings,
  CodexDeveloperInstructionSettings,
  CodexGitSettings,
  CodexHomeSettings,
  CodexHomeSettingsUpdateInput,
  CodexExecutionHostSettings,
  CodexThreadDetailLevel,
  DiagnosticsSettings,
  HistorySettings,
  ManagedWorktreeSettings,
  TelemetrySettings,
  ThreadNotificationSettings,
  ThreadNotificationTurnMode,
  UpdateAppUpdateSettingsInput,
  UpdateAcpAgentSettingsInput,
  UpdateBackupSettingsInput,
  UpdateCodexDeveloperInstructionSettingsInput,
  UpdateCodexGitSettingsInput,
  UpdateCodexExecutionHostSettingsInput,
  UpdateDiagnosticsSettingsInput,
  UpdateHistorySettingsInput,
  UpdateManagedWorktreeSettingsInput,
  UpdateTelemetrySettingsInput,
  UpdateThreadNotificationSettingsInput,
  UpdateWindowRestoreSettingsInput,
  WindowRestorePolicy,
  WindowRestoreSettings,
} from "../../shared/types";
import { THREAD_NOTIFICATION_TURN_MODES, isThreadNotificationTurnMode } from "../../shared/types";
import { normalizeCodexSshExecutionHostConfig } from "../codex/codex-ssh-execution-host-config";
import {
  DEFAULT_INBOX_SETTINGS,
  INBOX_SUGGESTION_MODES,
  MAX_INBOX_INSTRUCTIONS_CHARS,
  clampInboxSuggestionConcurrency,
  decodeInboxAgentBinding,
  encodeInboxAgentBinding,
  type InboxAgentChoice,
  type InboxSettings,
  type InboxSuggestionMode,
  type UpdateInboxSettingsInput,
} from "../../shared/inbox";
import { UpdateInboxSettingsInputSchema } from "../../shared/schemas/inbox";
import { parseAppLocalePreference, type AppLocalePreference } from "../../shared/i18n/locales";
import {
  readSettingsTomlDocument,
  SETTINGS_DOCUMENT_MAX_BYTES,
  type SettingsTomlDocument,
} from "./settings-document";

// ─── Profile-local TOML [server] settings ───

export interface MiniPlacement {
  readonly displayId: number;
  readonly anchor: MiniAnchor;
}

export interface MiniPlacementSettings {
  readonly lastDisplayId: number | null;
  readonly anchors: Readonly<Record<string, MiniAnchor>>;
}

interface ServerTomlConfig {
  mini_shown?: boolean;
  mini_resting?: MiniResting;
  mini_last_display_id?: number;
  mini_display_anchors?: Record<string, MiniAnchor>;
  home?: string;
  codex_home?: string;
  codex_executable?: string;
  codex_account_home?: string;
  backup_auto_enabled?: boolean;
  backup_interval_hours?: number;
  backup_retention?: number;
  backup_retention_gib?: number;
  thread_notifications_turn_mode?: ThreadNotificationTurnMode;
  thread_notifications_questions_enabled?: boolean;
  thread_readback_enabled?: boolean;
  history_retention?: number;
  app_updates_auto_check_enabled?: boolean;
  app_updates_channel?: "stable" | "nightly";
  terminal_shell?: TerminalShellSettings["windowsShell"];
  window_restore_policy?: WindowRestorePolicy;
  composer_predictions_enabled?: boolean;
  default_runtime_mode?: AgentRuntimeSettings["defaultRuntimeMode"];
  writing_model?: AgentRuntimeWritingModel;
  title_model?: AgentRuntimeWritingModel;
  agent_instructions?: Partial<AgentInstructionsSettings>;
  usage_meters?: Partial<UsageMeterSettings>;
  model_policy?: ModelPolicy;
  open_link_in_target?: LinkOpeningSettings["openLinkInTarget"];
  fetch_link_favicons?: boolean;
  open_local_url_in_target?: LinkOpeningSettings["openLocalUrlInTarget"];
  external_browser_link_shortcut?: LinkOpeningSettings["externalBrowserLinkShortcut"];
  open_github_threads_in_nodex?: boolean;
  inbox_suggestions?: InboxSuggestionMode;
  inbox_dispatch_mode?: InboxSettings["dispatchMode"];
  /** Read only to migrate the former boolean preference. */
  inbox_suggestions_enabled?: boolean;
  inbox_suggestion_agent?: string;
  inbox_suggestion_model?: string;
  inbox_suggestion_effort?: string;
  inbox_suggestion_speed?: string;
  inbox_suggestion_concurrency?: number;
  automatic_work_at_once?: number;
  subagents_may_delegate?: boolean;
  inbox_instructions?: string;
  inbox_chat_agent?: string;
  inbox_chat_model?: string;
  inbox_chat_effort?: string;
  inbox_chat_speed?: string;
  inbox_suggestions_choose_models?: boolean;
  inbox_use_model_guide?: boolean;
  inbox_show_page_beside_new_chats?: boolean;
  inbox_new_chats_use_worktrees?: boolean;
  diagnostics_enabled?: boolean;
  diagnostics_dsn?: string;
  diagnostics_environment?: string;
  diagnostics_release?: string;
  diagnostics_traces_sample_rate?: number;
  diagnostics_replay_enabled?: boolean;
  diagnostics_replays_session_sample_rate?: number;
  diagnostics_replays_on_error_sample_rate?: number;
  telemetry_enabled?: boolean;
  command_keybindings?: Record<string, unknown>;
  codex_thread_detail_level?: CodexThreadDetailLevel;
  codex_default_mode_request_user_input_enabled?: boolean;
  git_branch_prefix?: string;
  git_commit_instructions?: string;
  git_pr_instructions?: string;
  worktree_root?: string;
  worktree_auto_delete_enabled?: boolean;
  worktree_auto_delete_limit?: number;
  execution_hosts?: unknown[];
  agent_instances?: unknown[];
  agent_instance_identity_version?: number;
  acp_agent_instances?: unknown[];
  claude_agent_instances?: unknown[];
  provider_keys?: unknown[];
  opencode_agent_instances?: unknown[];
  antigravity_agent_instances?: unknown[];
}

interface RootTomlConfig extends Record<string, unknown> {
  locale?: AppLocalePreference;
  server?: ServerTomlConfig;
  components?: { disabled?: unknown };
}

export interface ApplicationSettingsDocumentSource {
  readonly hostHomeDirectory?: string;
  readonly secretEncryption?: SecretEncryptionAdapter;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  /** Remote signals default on only in a released build; development and tests stay silent. */
  readonly isPackaged?: boolean;
  readonly settingsPath: string;
  readonly allowTemporaryWorktreeRoot?: boolean;
  readonly document?: SettingsTomlDocument;
}

const BACKUP_AUTO_DEFAULT = false;
const BACKUP_INTERVAL_DEFAULT = 6;
const BACKUP_RETENTION_DEFAULT = 28;
const BACKUP_RETENTION_GIB_DEFAULT = 32;
const BACKUP_RETENTION_GIB_MAX = 8_192;
const THREAD_NOTIFICATIONS_TURN_MODE_DEFAULT: ThreadNotificationTurnMode = "unseen";
const THREAD_NOTIFICATIONS_QUESTIONS_ENABLED_DEFAULT = true;
const APP_UPDATES_AUTO_CHECK_DEFAULT = true;
const WINDOW_RESTORE_POLICY_DEFAULT: WindowRestorePolicy = "all";
export const DEFAULT_SENTRY_DSN =
  "https://ecf630563128267bf9798a10b45a089a@o4511580306014208.ingest.us.sentry.io/4511580310011904";
const DIAGNOSTICS_ENVIRONMENT_DEFAULT = "production";
const DIAGNOSTICS_TRACES_SAMPLE_RATE_DEFAULT = 0;
const DIAGNOSTICS_REPLAY_ENABLED_DEFAULT = false;
const DIAGNOSTICS_REPLAYS_SESSION_SAMPLE_RATE_DEFAULT = 0.1;
const DIAGNOSTICS_REPLAYS_ON_ERROR_SAMPLE_RATE_DEFAULT = 1;
const CODEX_THREAD_DETAIL_LEVEL_DEFAULT: CodexThreadDetailLevel = "STEPS_COMMANDS";
const CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_ENABLED_DEFAULT = true;
const CODEX_GIT_BRANCH_PREFIX_DEFAULT = DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX;
const WORKTREE_AUTO_DELETE_LIMIT_DEFAULT = 15;
const EXECUTION_HOST_LIMIT = 32;

function serverSectionFromDocument(
  parsed: SettingsTomlDocument,
  configPath: string,
): ServerTomlConfig | null {
  const server = parsed.server;
  if (server === undefined) return null;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error(`Settings [server] must be a TOML table: ${configPath}`);
  }
  return server as ServerTomlConfig;
}

function readServerSection(configPath: string): ServerTomlConfig | null {
  return serverSectionFromDocument(readSettingsTomlDocument(configPath), configPath);
}

function loadServerTomlConfig(source: ApplicationSettingsDocumentSource): ServerTomlConfig {
  if (source.document) {
    return serverSectionFromDocument(source.document, source.settingsPath) ?? {};
  }
  return readServerSection(source.settingsPath) ?? {};
}

function loadProfileServerTomlConfig(source: ApplicationSettingsDocumentSource): ServerTomlConfig {
  return loadServerTomlConfig(source);
}

function getProfileSettingsPath(source: ApplicationSettingsDocumentSource): string {
  return source.settingsPath;
}

function readTomlConfig(configPath: string): RootTomlConfig {
  return readSettingsTomlDocument(configPath) as RootTomlConfig;
}

/** Only restricted plugins need a persisted override. */
export function readPluginScopes(source: ApplicationSettingsDocumentSource) {
  return pluginScopesFromDocument(readTomlConfig(source.settingsPath));
}

function pluginScopesFromDocument(document: RootTomlConfig) {
  const table = document.plugin_project_scope;
  if (!table || typeof table !== "object" || Array.isArray(table)) return {};
  return Object.fromEntries(
    Object.entries(table).flatMap(([id, projects]) =>
      Array.isArray(projects) &&
      projects.every((project): project is string => typeof project === "string")
        ? [[id, { kind: "projects", projectIds: projects } as const]]
        : [],
    ),
  );
}

export function writePluginScope(
  source: ApplicationSettingsDocumentSource,
  id: string,
  scope: PluginProjectScope,
) {
  const document = readTomlConfig(source.settingsPath);
  const entries = Object.fromEntries(
    Object.entries(pluginScopesFromDocument(document))
      .filter(([key]) => key !== id)
      .map(([key, value]) => [key, value.projectIds]),
  );
  if (scope.kind === "projects")
    Object.defineProperty(entries, id, {
      enumerable: true,
      value: [...new Set(scope.projectIds)].sort(),
    });
  document.plugin_project_scope = entries;
  writeTomlConfig(source.settingsPath, document);
}

function writeTomlConfig(configPath: string, nextToml: RootTomlConfig): void {
  const serialized = stringifyToml(nextToml as Record<string, unknown>);
  if (Buffer.byteLength(serialized, "utf8") > SETTINGS_DOCUMENT_MAX_BYTES)
    throw new Error(`Settings document exceeds ${SETTINGS_DOCUMENT_MAX_BYTES} bytes.`);
  const configDirectory = path.dirname(configPath);
  mkdirSync(configDirectory, { recursive: true });
  const temporaryPath = path.join(
    configDirectory,
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, configPath);
    try {
      syncDirectorySync(configDirectory);
    } catch {
      // Directory fsync is unavailable on some host filesystems. The complete
      // staged document has already replaced the canonical file atomically.
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The staging file may already have been published or never created.
    }
    throw error;
  }
}

function writeProfileServerTomlConfig(
  source: ApplicationSettingsDocumentSource,
  nextServer: ServerTomlConfig,
): void {
  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  nextToml.server = nextServer;
  writeTomlConfig(profileSettingsPath, nextToml);
}

/** Upgrade the Profile document and its secret references under the writer permit. */
export function migrateProfileAgentProfiles(source: ApplicationSettingsDocumentSource): void {
  migrateLegacyProfileTables(source);
  const current = loadProfileServerTomlConfig(source);
  withAgentSecretChanges((changes) => {
    const instances = readStoredAcpInstances(current.acp_agent_instances, { forMigration: true });
    const builtIns = migrateBuiltInAcpInstances(source, current, instances, changes);
    const next = { ...current, ...builtIns };
    const acp = migrateAcpInstanceIds(source, builtIns?.acp_agent_instances ?? instances, changes);
    if (acp) {
      next.acp_agent_instances = acp.instances;
      rewriteAcpSettingsReferences(next, acp.rewritten);
    }
    if (builtIns || acp) writeProfileServerTomlConfig(source, next);
  });
}

function migrateLegacyProfileTables(source: ApplicationSettingsDocumentSource): void {
  const previous = loadProfileServerTomlConfig(source);
  if (previous.agent_instances !== undefined) return;
  const hasLegacyInbox = [previous.inbox_chat_agent, previous.inbox_suggestion_agent].some(
    (agent) => agent?.startsWith("claude:"),
  );
  if (!hasLegacyAgentProfiles(source, previous) && !hasLegacyInbox) return;

  withAgentSecretChanges((changes) => {
    const agent_instances = migrateLegacyAgentProfiles(source, previous, changes);
    const next = { ...previous, agent_instances };
    if (previous.acp_agent_instances && previous.agent_instance_identity_version !== 1) {
      const instances = readStoredAcpInstances(previous.acp_agent_instances, {
        forMigration: true,
      });
      const acp = migrateAcpInstanceIds(source, instances, changes, true);
      if (acp) {
        next.acp_agent_instances = acp.instances;
        rewriteAcpSettingsReferences(next, acp.rewritten);
      }
    }
    delete next.claude_agent_instances;
    delete next.opencode_agent_instances;
    delete next.antigravity_agent_instances;
    delete next.agent_instance_identity_version;
    for (const key of ["inbox_chat_agent", "inbox_suggestion_agent"] as const) {
      const binding = decodeInboxAgentBinding(next[key]);
      if (binding) next[key] = encodeInboxAgentBinding(binding);
    }
    writeProfileServerTomlConfig(source, next);
  });
}

function rewriteAcpSettingsReferences(
  settings: ServerTomlConfig,
  rewritten: ReadonlyMap<string, string>,
): void {
  if (!rewritten.size) return;
  for (const key of ["inbox_chat_agent", "inbox_suggestion_agent"] as const) {
    const previous = settings[key];
    const id = previous === undefined ? undefined : rewritten.get(previous);
    if (id) settings[key] = id;
  }
  for (const key of ["writing_model", "title_model"] as const) {
    const model = settings[key];
    if (!model) continue;
    const id = rewritten.get(model.instanceId);
    if (id) settings[key] = { ...model, instanceId: id };
  }
  const storedPolicy = settings.model_policy;
  const policy = StoredModelPolicySchema.safeParse(storedPolicy);
  if (!policy.success) return;
  const exceptions = policy.data.exceptions.map((exception) => {
    try {
      const entry: unknown = JSON.parse(exception);
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
        return exception;
      const id = rewritten.get(entry[0]);
      return id ? JSON.stringify([id, entry[1]]) : exception;
    } catch {
      return exception;
    }
  });
  if (
    (storedPolicy && "providersOff" in storedPolicy) ||
    exceptions.some((exception, index) => exception !== policy.data.exceptions[index])
  )
    settings.model_policy = { ...policy.data, exceptions };
}

function resolveConfiguredCodexHome(
  configuredHome: string | undefined,
  source: ApplicationSettingsDocumentSource,
  configuredAccountHome?: string,
): CodexHomeSettings {
  if (!source.hostHomeDirectory) throw new Error("The host home directory is unavailable.");
  return resolveCodexHome({
    configuredHome,
    configuredAccountHome,
    environment: source.environment,
    homeDirectory: source.hostHomeDirectory,
  });
}

export function getCodexHomeSettings(source: ApplicationSettingsDocumentSource): CodexHomeSettings {
  const config = loadProfileServerTomlConfig(source);
  const configuredHome = config.codex_home;
  if (configuredHome !== undefined && typeof configuredHome !== "string")
    throw new Error("Codex home must be a string");
  if (config.codex_account_home !== undefined && typeof config.codex_account_home !== "string")
    throw new Error("Codex account directory must be a string");
  return resolveConfiguredCodexHome(configuredHome, source, config.codex_account_home);
}

export function updateCodexHomeSettings(
  input: CodexHomeSettingsUpdateInput,
  source: ApplicationSettingsDocumentSource,
): CodexHomeSettings {
  const parsed = CodexHomeSettingsUpdateSchema.parse(input);
  const next = { ...loadProfileServerTomlConfig(source) };
  const resolved = resolveConfiguredCodexHome(
    parsed.homePath,
    source,
    parsed.accountHomePath ?? next.codex_account_home,
  );
  if (resolved.homePath) next.codex_home = resolved.resolvedHomePath;
  else delete next.codex_home;
  if (resolved.accountHomePath)
    next.codex_account_home = resolved.resolvedAccountHomePath ?? undefined;
  else delete next.codex_account_home;
  writeProfileServerTomlConfig(source, next);
  return getCodexHomeSettings(source);
}

export function getCodexExecutable(source: ApplicationSettingsDocumentSource): string {
  return CodexExecutableUpdateSchema.parse(
    loadProfileServerTomlConfig(source).codex_executable ?? "",
  );
}

export function updateCodexExecutable(
  executable: string,
  source: ApplicationSettingsDocumentSource,
): void {
  const value = CodexExecutableUpdateSchema.parse(executable);
  const next = { ...loadProfileServerTomlConfig(source) };
  if (value) next.codex_executable = value;
  else delete next.codex_executable;
  writeProfileServerTomlConfig(source, next);
}

// ─── Getters (resolution: env → Profile TOML → default) ───

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  return fallback;
}

function parseIntegerEnv(value: string | undefined, fallback: number, minimum: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function normalizeSampleRate(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${fieldName} must be between 0 and 1`);
  }
  return value;
}

function normalizeOptionalStringInput(value: string | null, fieldName: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIntegerInput(value: number, minimum: number, fieldName: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a number`);
  }
  const normalized = Math.trunc(value);
  if (normalized < minimum) {
    throw new Error(`${fieldName} must be at least ${minimum}`);
  }
  return normalized;
}

function backupSettingsFromConfig(config: ServerTomlConfig): Omit<BackupSettings, "envOverrides"> {
  const autoEnabled =
    typeof config.backup_auto_enabled === "boolean"
      ? config.backup_auto_enabled
      : BACKUP_AUTO_DEFAULT;
  const intervalHours =
    typeof config.backup_interval_hours === "number"
      ? Math.max(1, config.backup_interval_hours)
      : BACKUP_INTERVAL_DEFAULT;
  const retentionCount =
    typeof config.backup_retention === "number"
      ? Math.max(0, config.backup_retention)
      : BACKUP_RETENTION_DEFAULT;
  const retentionGiB =
    typeof config.backup_retention_gib === "number"
      ? Math.min(BACKUP_RETENTION_GIB_MAX, Math.max(0, config.backup_retention_gib))
      : BACKUP_RETENTION_GIB_DEFAULT;

  return {
    autoEnabled,
    intervalHours,
    retentionCount,
    retentionGiB,
  };
}

function threadNotificationSettingsFromConfig(
  config: ServerTomlConfig,
): ThreadNotificationSettings {
  return {
    turnMode: isThreadNotificationTurnMode(config.thread_notifications_turn_mode)
      ? config.thread_notifications_turn_mode
      : THREAD_NOTIFICATIONS_TURN_MODE_DEFAULT,
    readbackEnabled:
      typeof config.thread_readback_enabled === "boolean" ? config.thread_readback_enabled : true,
    questionsEnabled:
      typeof config.thread_notifications_questions_enabled === "boolean"
        ? config.thread_notifications_questions_enabled
        : THREAD_NOTIFICATIONS_QUESTIONS_ENABLED_DEFAULT,
  };
}

function appUpdateSettingsFromConfig(config: ServerTomlConfig): AppUpdateSettings {
  return {
    automaticChecksEnabled:
      typeof config.app_updates_auto_check_enabled === "boolean"
        ? config.app_updates_auto_check_enabled
        : APP_UPDATES_AUTO_CHECK_DEFAULT,
    channel:
      config.app_updates_channel === "stable" || config.app_updates_channel === "nightly"
        ? config.app_updates_channel
        : "stable",
  };
}

function windowRestoreSettingsFromConfig(config: ServerTomlConfig): WindowRestoreSettings {
  return {
    policy:
      config.window_restore_policy === "all" ||
      config.window_restore_policy === "last-window" ||
      config.window_restore_policy === "none"
        ? config.window_restore_policy
        : WINDOW_RESTORE_POLICY_DEFAULT,
  };
}

function diagnosticsSettingsFromConfig(
  config: ServerTomlConfig,
): Omit<DiagnosticsSettings, "envOverrides" | "active" | "blockedBy"> {
  const enabled = config.diagnostics_enabled !== false;
  const configuredDsn =
    typeof config.diagnostics_dsn === "string" ? config.diagnostics_dsn.trim() : "";
  const environment =
    typeof config.diagnostics_environment === "string" && config.diagnostics_environment.trim()
      ? config.diagnostics_environment.trim()
      : DIAGNOSTICS_ENVIRONMENT_DEFAULT;
  const release =
    typeof config.diagnostics_release === "string" && config.diagnostics_release.trim()
      ? config.diagnostics_release.trim()
      : null;
  const tracesSampleRate =
    typeof config.diagnostics_traces_sample_rate === "number"
      ? Math.min(1, Math.max(0, config.diagnostics_traces_sample_rate))
      : DIAGNOSTICS_TRACES_SAMPLE_RATE_DEFAULT;
  const replayEnabled =
    typeof config.diagnostics_replay_enabled === "boolean"
      ? config.diagnostics_replay_enabled
      : DIAGNOSTICS_REPLAY_ENABLED_DEFAULT;
  const replaysSessionSampleRate =
    typeof config.diagnostics_replays_session_sample_rate === "number"
      ? Math.min(1, Math.max(0, config.diagnostics_replays_session_sample_rate))
      : DIAGNOSTICS_REPLAYS_SESSION_SAMPLE_RATE_DEFAULT;
  const replaysOnErrorSampleRate =
    typeof config.diagnostics_replays_on_error_sample_rate === "number"
      ? Math.min(1, Math.max(0, config.diagnostics_replays_on_error_sample_rate))
      : DIAGNOSTICS_REPLAYS_ON_ERROR_SAMPLE_RATE_DEFAULT;

  return {
    enabled,
    dsn: configuredDsn || (enabled ? DEFAULT_SENTRY_DSN : ""),
    environment,
    release,
    tracesSampleRate,
    replayEnabled,
    replaysSessionSampleRate,
    replaysOnErrorSampleRate,
  };
}

export function getBackupSettings(source: ApplicationSettingsDocumentSource): BackupSettings {
  const serverToml = loadServerTomlConfig(source);
  const environment = source.environment;
  const fromToml = backupSettingsFromConfig(serverToml);
  const envOverrides = {
    autoEnabled: environment.NODEX_BACKUP_AUTO_ENABLED !== undefined,
    intervalHours: environment.NODEX_BACKUP_INTERVAL_HOURS !== undefined,
    retentionCount: environment.NODEX_BACKUP_RETENTION !== undefined,
    retentionGiB: environment.NODEX_BACKUP_RETENTION_GIB !== undefined,
  };

  return {
    autoEnabled: envOverrides.autoEnabled
      ? parseBooleanEnv(environment.NODEX_BACKUP_AUTO_ENABLED, fromToml.autoEnabled)
      : fromToml.autoEnabled,
    intervalHours: envOverrides.intervalHours
      ? parseIntegerEnv(environment.NODEX_BACKUP_INTERVAL_HOURS, fromToml.intervalHours, 1)
      : fromToml.intervalHours,
    retentionCount: envOverrides.retentionCount
      ? parseIntegerEnv(environment.NODEX_BACKUP_RETENTION, fromToml.retentionCount, 0)
      : fromToml.retentionCount,
    retentionGiB: envOverrides.retentionGiB
      ? Math.min(
          BACKUP_RETENTION_GIB_MAX,
          parseIntegerEnv(environment.NODEX_BACKUP_RETENTION_GIB, fromToml.retentionGiB, 0),
        )
      : fromToml.retentionGiB,
    envOverrides,
  };
}

export function updateBackupSettings(
  input: UpdateBackupSettingsInput,
  source: ApplicationSettingsDocumentSource,
): BackupSettings {
  if (typeof input.autoEnabled !== "boolean") {
    throw new Error("autoEnabled must be a boolean");
  }

  const nextSettings = {
    autoEnabled: input.autoEnabled,
    intervalHours: normalizeIntegerInput(input.intervalHours, 1, "intervalHours"),
    retentionCount: normalizeIntegerInput(input.retentionCount, 0, "retentionCount"),
    retentionGiB: Math.min(
      BACKUP_RETENTION_GIB_MAX,
      normalizeIntegerInput(input.retentionGiB, 0, "retentionGiB"),
    ),
  };

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    backup_auto_enabled: nextSettings.autoEnabled,
    backup_interval_hours: nextSettings.intervalHours,
    backup_retention: nextSettings.retentionCount,
    backup_retention_gib: nextSettings.retentionGiB,
  };

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getBackupSettings(source);
}

export function getHistorySettings(source: ApplicationSettingsDocumentSource): HistorySettings {
  const serverToml = loadServerTomlConfig(source);
  const environment = source.environment;
  const fromToml =
    typeof serverToml.history_retention === "number"
      ? Math.max(0, serverToml.history_retention)
      : 1000;
  const envOverrides = {
    retentionCount: environment.NODEX_HISTORY_RETENTION !== undefined,
  };

  return {
    retentionCount: envOverrides.retentionCount
      ? parseIntegerEnv(environment.NODEX_HISTORY_RETENTION, fromToml, 0)
      : fromToml,
    envOverrides,
  };
}

export function updateHistorySettings(
  input: UpdateHistorySettingsInput,
  source: ApplicationSettingsDocumentSource,
): HistorySettings {
  const nextSettings = {
    retentionCount: normalizeIntegerInput(input.retentionCount, 0, "retentionCount"),
  };

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    history_retention: nextSettings.retentionCount,
  };

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getHistorySettings(source);
}

export function getDiagnosticsSettings(
  source: ApplicationSettingsDocumentSource,
): DiagnosticsSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  const environmentSource = source.environment;
  const fromToml = diagnosticsSettingsFromConfig(profileServerToml);
  const envOverrides = {
    enabled: environmentSource.NODEX_SENTRY_ENABLED !== undefined,
    dsn: environmentSource.SENTRY_DSN !== undefined,
    environment: environmentSource.SENTRY_ENVIRONMENT !== undefined,
    release: environmentSource.SENTRY_RELEASE !== undefined,
    tracesSampleRate: environmentSource.NODEX_SENTRY_TRACES_SAMPLE_RATE !== undefined,
    replayEnabled: environmentSource.NODEX_SENTRY_REPLAY_ENABLED !== undefined,
    replaysSessionSampleRate:
      environmentSource.NODEX_SENTRY_REPLAYS_SESSION_SAMPLE_RATE !== undefined,
    replaysOnErrorSampleRate:
      environmentSource.NODEX_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE !== undefined,
  };

  const enabled = envOverrides.enabled
    ? parseBooleanEnv(environmentSource.NODEX_SENTRY_ENABLED, fromToml.enabled)
    : fromToml.enabled;
  const dsnFromEnv = environmentSource.SENTRY_DSN?.trim() ?? "";
  const dsn = envOverrides.dsn ? dsnFromEnv : fromToml.dsn || (enabled ? DEFAULT_SENTRY_DSN : "");
  const environmentFromEnv = environmentSource.SENTRY_ENVIRONMENT?.trim() ?? "";
  const environment =
    envOverrides.environment && environmentFromEnv ? environmentFromEnv : fromToml.environment;
  const releaseFromEnv = environmentSource.SENTRY_RELEASE?.trim() ?? "";
  const release = envOverrides.release ? releaseFromEnv || null : fromToml.release;
  const tracesSampleRate = envOverrides.tracesSampleRate
    ? Math.min(
        1,
        Math.max(
          0,
          parseNumberEnv(
            environmentSource.NODEX_SENTRY_TRACES_SAMPLE_RATE,
            fromToml.tracesSampleRate,
          ),
        ),
      )
    : fromToml.tracesSampleRate;
  const replayEnabled = envOverrides.replayEnabled
    ? parseBooleanEnv(environmentSource.NODEX_SENTRY_REPLAY_ENABLED, fromToml.replayEnabled)
    : fromToml.replayEnabled;
  const replaysSessionSampleRate = envOverrides.replaysSessionSampleRate
    ? Math.min(
        1,
        Math.max(
          0,
          parseNumberEnv(
            environmentSource.NODEX_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
            fromToml.replaysSessionSampleRate,
          ),
        ),
      )
    : fromToml.replaysSessionSampleRate;
  const replaysOnErrorSampleRate = envOverrides.replaysOnErrorSampleRate
    ? Math.min(
        1,
        Math.max(
          0,
          parseNumberEnv(
            environmentSource.NODEX_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
            fromToml.replaysOnErrorSampleRate,
          ),
        ),
      )
    : fromToml.replaysOnErrorSampleRate;

  return {
    enabled,
    dsn,
    environment,
    release,
    tracesSampleRate,
    replayEnabled,
    replaysSessionSampleRate,
    replaysOnErrorSampleRate,
    envOverrides,
    ...resolveRemoteSignal({
      preference: enabled,
      override: envOverrides.enabled ? enabled : null,
      isPackaged: source.isPackaged === true,
      environment: environmentSource,
    }),
  };
}

export function updateDiagnosticsSettings(
  input: UpdateDiagnosticsSettingsInput,
  source: ApplicationSettingsDocumentSource,
): DiagnosticsSettings {
  if (typeof input.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const nextSettings = {
    enabled: input.enabled,
    dsn: normalizeOptionalStringInput(input.dsn, "dsn"),
    environment:
      normalizeOptionalStringInput(input.environment, "environment") ??
      DIAGNOSTICS_ENVIRONMENT_DEFAULT,
    release: normalizeOptionalStringInput(input.release, "release"),
    tracesSampleRate: normalizeSampleRate(input.tracesSampleRate, "tracesSampleRate"),
    replayEnabled: input.replayEnabled,
    replaysSessionSampleRate: normalizeSampleRate(
      input.replaysSessionSampleRate,
      "replaysSessionSampleRate",
    ),
    replaysOnErrorSampleRate: normalizeSampleRate(
      input.replaysOnErrorSampleRate,
      "replaysOnErrorSampleRate",
    ),
  };
  if (typeof nextSettings.replayEnabled !== "boolean") {
    throw new Error("replayEnabled must be a boolean");
  }

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer: ServerTomlConfig = {
    ...(nextToml.server ?? {}),
    diagnostics_enabled: nextSettings.enabled,
    diagnostics_environment: nextSettings.environment,
    diagnostics_traces_sample_rate: nextSettings.tracesSampleRate,
    diagnostics_replay_enabled: nextSettings.replayEnabled,
    diagnostics_replays_session_sample_rate: nextSettings.replaysSessionSampleRate,
    diagnostics_replays_on_error_sample_rate: nextSettings.replaysOnErrorSampleRate,
  };
  if (nextSettings.dsn) {
    nextServer.diagnostics_dsn = nextSettings.dsn;
  } else {
    delete nextServer.diagnostics_dsn;
  }
  if (nextSettings.release) {
    nextServer.diagnostics_release = nextSettings.release;
  } else {
    delete nextServer.diagnostics_release;
  }

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getDiagnosticsSettings(source);
}

export function getTelemetrySettings(source: ApplicationSettingsDocumentSource): TelemetrySettings {
  const preference = loadProfileServerTomlConfig(source).telemetry_enabled !== false;
  const environment = source.environment;
  const overridden = environment.NODEX_TELEMETRY_ENABLED !== undefined;
  const enabled = overridden
    ? parseBooleanEnv(environment.NODEX_TELEMETRY_ENABLED, preference)
    : preference;
  return {
    enabled,
    managed: overridden,
    ...resolveRemoteSignal({
      preference: enabled,
      override: overridden ? enabled : null,
      // A local test receiver stands in for the real service, so the preference governs as released.
      isPackaged: source.isPackaged === true || environment.NODEX_TELEMETRY_ENDPOINT !== undefined,
      environment,
    }),
  };
}

export function updateTelemetrySettings(
  input: UpdateTelemetrySettingsInput,
  source: ApplicationSettingsDocumentSource,
): TelemetrySettings {
  if (typeof input.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  nextToml.server = { ...(nextToml.server ?? {}), telemetry_enabled: input.enabled };
  writeTomlConfig(profileSettingsPath, nextToml);
  return getTelemetrySettings(source);
}

export function getThreadNotificationSettings(
  source: ApplicationSettingsDocumentSource,
): ThreadNotificationSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return threadNotificationSettingsFromConfig(profileServerToml);
}

function isCodexThreadDetailLevel(value: unknown): value is CodexThreadDetailLevel {
  return value === "STEPS_PROSE" || value === "STEPS_COMMANDS" || value === "STEPS_EXECUTION";
}

export function getCodexDeveloperInstructionSettings(
  source: ApplicationSettingsDocumentSource,
): CodexDeveloperInstructionSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return {
    detailLevel: isCodexThreadDetailLevel(profileServerToml.codex_thread_detail_level)
      ? profileServerToml.codex_thread_detail_level
      : CODEX_THREAD_DETAIL_LEVEL_DEFAULT,
    defaultModeRequestUserInput:
      typeof profileServerToml.codex_default_mode_request_user_input_enabled === "boolean"
        ? profileServerToml.codex_default_mode_request_user_input_enabled
        : CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_ENABLED_DEFAULT,
  };
}

export function updateCodexDeveloperInstructionSettings(
  input: UpdateCodexDeveloperInstructionSettingsInput,
  source: ApplicationSettingsDocumentSource,
): CodexDeveloperInstructionSettings {
  if (input.detailLevel !== undefined && !isCodexThreadDetailLevel(input.detailLevel)) {
    throw new Error("detailLevel must be one of STEPS_PROSE, STEPS_COMMANDS, or STEPS_EXECUTION");
  }
  if (
    input.defaultModeRequestUserInput !== undefined &&
    typeof input.defaultModeRequestUserInput !== "boolean"
  ) {
    throw new Error("defaultModeRequestUserInput must be a boolean");
  }
  const current = getCodexDeveloperInstructionSettings(source);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    codex_thread_detail_level: input.detailLevel ?? current.detailLevel,
    codex_default_mode_request_user_input_enabled:
      input.defaultModeRequestUserInput ?? current.defaultModeRequestUserInput,
  });
  return getCodexDeveloperInstructionSettings(source);
}

export function getCodexGitSettings(source: ApplicationSettingsDocumentSource): CodexGitSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return {
    branchPrefix:
      typeof profileServerToml.git_branch_prefix === "string"
        ? profileServerToml.git_branch_prefix
        : CODEX_GIT_BRANCH_PREFIX_DEFAULT,
    commitInstructions:
      typeof profileServerToml.git_commit_instructions === "string"
        ? profileServerToml.git_commit_instructions
        : "",
    pullRequestInstructions:
      typeof profileServerToml.git_pr_instructions === "string"
        ? profileServerToml.git_pr_instructions
        : "",
  };
}

export function updateCodexGitSettings(
  input: UpdateCodexGitSettingsInput,
  source: ApplicationSettingsDocumentSource,
): CodexGitSettings {
  const entries = Object.entries(input);
  if (entries.length === 0) return getCodexGitSettings(source);
  const allowedKeys = new Set(["branchPrefix", "commitInstructions", "pullRequestInstructions"]);
  if (entries.some(([key]) => !allowedKeys.has(key))) {
    throw new Error("Unknown Git setting");
  }
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("Git setting values must be strings");
  }

  const next = { ...loadProfileServerTomlConfig(source) };
  if (input.branchPrefix !== undefined) next.git_branch_prefix = input.branchPrefix;
  if (input.commitInstructions !== undefined)
    next.git_commit_instructions = input.commitInstructions;
  if (input.pullRequestInstructions !== undefined)
    next.git_pr_instructions = input.pullRequestInstructions;
  writeProfileServerTomlConfig(source, next);
  return getCodexGitSettings(source);
}

const warnedAboutTemporaryWorktreeRoot = new Set<string>();

function normalizeWorktreeRoot(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function rejectsWorktreeRoot(
  source: ApplicationSettingsDocumentSource,
  root: string | null,
): boolean {
  return root !== null && !source.allowTemporaryWorktreeRoot && isSystemTempDirectory(root);
}

export function getManagedWorktreeSettings(
  source: ApplicationSettingsDocumentSource,
): ManagedWorktreeSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  const worktreeRoot =
    typeof profileServerToml.worktree_root === "string"
      ? normalizeWorktreeRoot(profileServerToml.worktree_root)
      : null;
  const useDefaultRoot = rejectsWorktreeRoot(source, worktreeRoot);
  if (useDefaultRoot && !warnedAboutTemporaryWorktreeRoot.has(source.settingsPath)) {
    warnedAboutTemporaryWorktreeRoot.add(source.settingsPath);
    getLogger({ component: "worktree-settings" }).warn(
      "Ignoring the temporary worktree root and using the Profile default",
    );
  }
  return {
    worktreeRoot: useDefaultRoot ? null : worktreeRoot,
    autoDeleteEnabled:
      typeof profileServerToml.worktree_auto_delete_enabled === "boolean"
        ? profileServerToml.worktree_auto_delete_enabled
        : true,
    autoDeleteLimit:
      typeof profileServerToml.worktree_auto_delete_limit === "number" &&
      Number.isSafeInteger(profileServerToml.worktree_auto_delete_limit) &&
      profileServerToml.worktree_auto_delete_limit >= 1
        ? profileServerToml.worktree_auto_delete_limit
        : WORKTREE_AUTO_DELETE_LIMIT_DEFAULT,
  };
}

export function updateManagedWorktreeSettings(
  input: UpdateManagedWorktreeSettingsInput,
  source: ApplicationSettingsDocumentSource,
): ManagedWorktreeSettings {
  const allowedKeys = new Set(["worktreeRoot", "autoDeleteEnabled", "autoDeleteLimit"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("Unknown managed worktree setting");
  }
  if (input.autoDeleteEnabled !== undefined && typeof input.autoDeleteEnabled !== "boolean") {
    throw new Error("autoDeleteEnabled must be a boolean");
  }
  if (
    input.autoDeleteLimit !== undefined &&
    (!Number.isSafeInteger(input.autoDeleteLimit) || input.autoDeleteLimit < 1)
  ) {
    throw new Error("autoDeleteLimit must be an integer of at least one");
  }
  if (
    input.worktreeRoot !== undefined &&
    input.worktreeRoot !== null &&
    typeof input.worktreeRoot !== "string"
  ) {
    throw new Error("worktreeRoot must be a string or null");
  }
  const worktreeRoot = normalizeWorktreeRoot(input.worktreeRoot);
  if (rejectsWorktreeRoot(source, worktreeRoot)) {
    throw new Error(
      "Choose a folder outside the system’s temporary directory. The system clears it automatically.",
    );
  }

  const next = { ...loadProfileServerTomlConfig(source) };
  // Historical roots were an accidental discovery/authorization registry. A
  // managed settings write canonicalizes legacy documents to the single-root model.
  delete (next as Record<string, unknown>).worktree_known_roots;
  if (worktreeRoot !== null) next.worktree_root = worktreeRoot;
  else if (input.worktreeRoot !== undefined) delete next.worktree_root;
  if (input.autoDeleteEnabled !== undefined) {
    next.worktree_auto_delete_enabled = input.autoDeleteEnabled;
  }
  if (input.autoDeleteLimit !== undefined) {
    next.worktree_auto_delete_limit = input.autoDeleteLimit;
  }
  writeProfileServerTomlConfig(source, next);
  return getManagedWorktreeSettings(source);
}

export function getCodexExecutionHostSettings(
  source: ApplicationSettingsDocumentSource,
): CodexExecutionHostSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  const hosts = Array.isArray(profileServerToml.execution_hosts)
    ? profileServerToml.execution_hosts
    : [];
  if (hosts.length > EXECUTION_HOST_LIMIT) {
    throw new Error(`Execution host settings exceed the ${EXECUTION_HOST_LIMIT} host bound`);
  }
  const sshHosts = hosts.map((candidate, index) => {
    try {
      return normalizeCodexSshExecutionHostConfig(candidate as never);
    } catch (error) {
      throw new Error(
        `Invalid SSH execution host at index ${String(index)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
  const identities = new Set<string>();
  for (const host of sshHosts) {
    if (identities.has(host.id)) throw new Error(`Duplicate SSH execution host id: ${host.id}`);
    identities.add(host.id);
  }
  return { sshHosts };
}

export function updateCodexExecutionHostSettings(
  input: UpdateCodexExecutionHostSettingsInput,
  source: ApplicationSettingsDocumentSource,
): CodexExecutionHostSettings {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "sshHosts") ||
    !Array.isArray(input.sshHosts)
  ) {
    throw new Error("Invalid execution host settings update");
  }
  const normalized = input.sshHosts.map(normalizeCodexSshExecutionHostConfig);
  if (normalized.length > EXECUTION_HOST_LIMIT) {
    throw new Error(`Execution host settings exceed the ${EXECUTION_HOST_LIMIT} host bound`);
  }
  const identities = new Set<string>();
  for (const host of normalized) {
    if (identities.has(host.id)) throw new Error(`Duplicate SSH execution host id: ${host.id}`);
    identities.add(host.id);
  }
  const next = { ...loadProfileServerTomlConfig(source), execution_hosts: normalized };
  writeProfileServerTomlConfig(source, next);
  return getCodexExecutionHostSettings(source);
}

export function getProviderKeySettings(
  source: ApplicationSettingsDocumentSource,
): ProviderKeySettings {
  return presentProviderKeys(
    readStoredProviderKeys(loadProfileServerTomlConfig(source).provider_keys),
  );
}

export function getProviderKeySecret(source: ApplicationSettingsDocumentSource, id: string) {
  return resolveProviderKeySecret(
    source,
    readStoredProviderKeys(loadProfileServerTomlConfig(source).provider_keys),
    id,
  );
}

export function updateProviderKeySettings(
  input:
    | { readonly removeId: string }
    | { readonly connection: ProviderKeyConnection; readonly key?: string },
  source: ApplicationSettingsDocumentSource,
): void {
  const document = loadProfileServerTomlConfig(source);
  const previous = readStoredProviderKeys(document.provider_keys);
  const { connections } = presentProviderKeys(previous);
  const next =
    "removeId" in input
      ? connections.filter(({ id }) => id !== input.removeId)
      : connections.some(({ id }) => id === input.connection.id)
        ? connections.map((connection) =>
            connection.id === input.connection.id ? input.connection : connection,
          )
        : [...connections, input.connection];
  if (next.length > PROVIDER_KEY_LIMIT) throw new Error("Too many API key connections.");
  const replacement =
    "connection" in input && input.key ? { id: input.connection.id, value: input.key } : undefined;
  writeProviderKeys(source, previous, next, replacement, (provider_keys) => {
    writeProfileServerTomlConfig(source, { ...document, provider_keys });
  });
}

export function getAgentProfiles(source: ApplicationSettingsDocumentSource) {
  return presentAgentProfiles(
    readStoredAgentProfiles(loadProfileServerTomlConfig(source).agent_instances),
  );
}

export function getAgentProfileLaunchConfiguration<Driver extends ProfileAgentDriver>(
  source: ApplicationSettingsDocumentSource,
  driver: Driver,
  instanceId: string,
) {
  migrateProfileAgentProfiles(source);
  return resolveAgentProfile(
    source,
    readStoredAgentProfiles(loadProfileServerTomlConfig(source).agent_instances),
    driver,
    instanceId,
  );
}

export function updateAgentProfiles(
  input: AgentProfilesUpdate,
  source: ApplicationSettingsDocumentSource,
) {
  migrateProfileAgentProfiles(source);
  const previous = loadProfileServerTomlConfig(source);
  writeAgentProfiles(
    source,
    input,
    readStoredAgentProfiles(previous.agent_instances),
    (agent_instances) => {
      writeProfileServerTomlConfig(source, { ...previous, agent_instances });
    },
  );
}

export function getAcpAgentSettings(source: ApplicationSettingsDocumentSource): AcpAgentSettings {
  return presentAcpInstances(
    readStoredAcpInstances(loadProfileServerTomlConfig(source).acp_agent_instances),
  );
}
export function getAcpLaunchConfiguration(
  source: ApplicationSettingsDocumentSource,
  instanceId: string,
) {
  return resolveAcpLaunchConfiguration(
    source,
    readStoredAcpInstances(loadProfileServerTomlConfig(source).acp_agent_instances),
    instanceId,
  );
}
export function updateAcpAgentSettings(
  input: UpdateAcpAgentSettingsInput,
  source: ApplicationSettingsDocumentSource,
): AcpAgentSettings {
  migrateProfileAgentProfiles(source);
  const previous = loadProfileServerTomlConfig(source);
  writeAcpInstances(
    source,
    input,
    readStoredAcpInstances(previous.acp_agent_instances),
    (instances) =>
      writeProfileServerTomlConfig(source, {
        ...previous,
        agent_instances: readStoredAgentProfiles(previous.agent_instances),
        acp_agent_instances: instances,
      }),
  );
  return getAcpAgentSettings(source);
}

export function getCommandKeybindingOverrides(
  source: ApplicationSettingsDocumentSource,
): CommandKeybindingOverrides {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return normalizeCommandKeybindingOverrides(profileServerToml.command_keybindings);
}

export function getCommandKeymapState(
  source: ApplicationSettingsDocumentSource,
): CommandKeymapState {
  return createCommandKeymapState(getCommandKeybindingOverrides(source));
}

export function updateCommandKeybinding(
  commandId: string,
  update: CommandKeybindingUpdate,
  source: ApplicationSettingsDocumentSource,
): CommandKeymapState {
  const currentOverrides = getCommandKeybindingOverrides(source);
  const nextOverrides = applyCommandKeybindingUpdate(currentOverrides, commandId, update);
  writeCommandKeybindingOverrides(source, nextOverrides);
  return getCommandKeymapState(source);
}

export function resetCommandKeybindings(
  source: ApplicationSettingsDocumentSource,
): CommandKeymapState {
  writeCommandKeybindingOverrides(source, {});
  return getCommandKeymapState(source);
}

function writeCommandKeybindingOverrides(
  source: ApplicationSettingsDocumentSource,
  overrides: CommandKeybindingOverrides,
): void {
  const nextServer: ServerTomlConfig = { ...loadProfileServerTomlConfig(source) };
  if (Object.keys(overrides).length === 0) {
    delete nextServer.command_keybindings;
  } else {
    nextServer.command_keybindings = overrides;
  }
  writeProfileServerTomlConfig(source, nextServer);
}

export function updateThreadNotificationSettings(
  input: UpdateThreadNotificationSettingsInput,
  source: ApplicationSettingsDocumentSource,
): ThreadNotificationSettings {
  if (!isThreadNotificationTurnMode(input.turnMode)) {
    throw new Error(`turnMode must be one of ${THREAD_NOTIFICATION_TURN_MODES.join(", ")}`);
  }
  if (typeof input.questionsEnabled !== "boolean") {
    throw new Error("questionsEnabled must be a boolean");
  }

  if (input.readbackEnabled !== undefined && typeof input.readbackEnabled !== "boolean") {
    throw new Error("readbackEnabled must be a boolean");
  }

  const nextSettings = {
    readbackEnabled: input.readbackEnabled ?? getThreadNotificationSettings(source).readbackEnabled,
    turnMode: input.turnMode,
    questionsEnabled: input.questionsEnabled,
  };

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    thread_notifications_turn_mode: nextSettings.turnMode,
    thread_notifications_questions_enabled: nextSettings.questionsEnabled,
    thread_readback_enabled: nextSettings.readbackEnabled,
  };

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getThreadNotificationSettings(source);
}

export function getDisabledAppComponents(
  source: ApplicationSettingsDocumentSource,
): readonly AppComponentId[] {
  const document = source.document ?? readTomlConfig(source.settingsPath);
  const components: unknown = document.components;
  if (!components || typeof components !== "object" || !("disabled" in components)) return [];
  return Array.isArray(components.disabled)
    ? [...new Set(components.disabled.filter(isAppComponentId))]
    : [];
}

export function updateAppComponentPreference(
  input: SetAppComponentEnabledInput,
  source: ApplicationSettingsDocumentSource,
): void {
  const document = readTomlConfig(source.settingsPath);
  const previous = document.components?.disabled;
  const disabled = new Set(
    Array.isArray(previous) ? previous.filter((id): id is string => typeof id === "string") : [],
  );
  if (input.enabled) disabled.delete(input.id);
  else disabled.add(input.id);
  document.components = { ...document.components, disabled: [...disabled].sort() };
  writeTomlConfig(source.settingsPath, document);
}

export function getAppUpdateSettings(source: ApplicationSettingsDocumentSource): AppUpdateSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return appUpdateSettingsFromConfig(profileServerToml);
}

export function updateAppUpdateSettings(
  input: UpdateAppUpdateSettingsInput,
  source: ApplicationSettingsDocumentSource,
): AppUpdateSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("App update settings input must be an object");
  }
  const keys = Object.keys(input);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "automaticChecksEnabled" && key !== "channel")
  ) {
    throw new Error("App update settings input contains unsupported keys");
  }
  if (
    input.automaticChecksEnabled !== undefined &&
    typeof input.automaticChecksEnabled !== "boolean"
  ) {
    throw new Error("automaticChecksEnabled must be a boolean");
  }
  if (input.channel !== undefined && input.channel !== "stable" && input.channel !== "nightly") {
    throw new Error("channel must be stable or nightly");
  }

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    ...(input.automaticChecksEnabled === undefined
      ? {}
      : {
          app_updates_auto_check_enabled: input.automaticChecksEnabled,
        }),
    ...(input.channel === undefined ? {} : { app_updates_channel: input.channel }),
  };

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getAppUpdateSettings(source);
}

/** Preserve an implicit Nightly choice before analytics records the new build's launch. */
export function preserveLegacyNightlyChannel(
  source: ApplicationSettingsDocumentSource,
  nodexHome: string,
  appVersion: string,
): void {
  if (!source.isPackaged || appVersion.includes("-")) return;
  const config = loadProfileServerTomlConfig(source);
  if (config.app_updates_channel !== undefined) return;

  let previousVersion: string | null;
  try {
    const statePath = path.join(nodexHome, PRODUCT_ANALYTICS_STATE_FILE);
    previousVersion = decodeState(readFileSync(statePath, "utf8")).lastLaunchVersion;
  } catch {
    return;
  }
  if (previousVersion?.includes("-nightly.")) {
    updateAppUpdateSettings({ channel: "nightly" }, source);
  }
}

/** An optional Inbox choice: a trimmed, bounded name, or unset. */
const inboxChoiceFromConfig = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed.length <= 256 ? trimmed : null;
};

const writeInboxChoice = (
  server: ServerTomlConfig,
  key:
    | "inbox_suggestion_model"
    | "inbox_suggestion_effort"
    | "inbox_suggestion_speed"
    | "inbox_chat_model"
    | "inbox_chat_effort"
    | "inbox_chat_speed",
  value: string | null,
) => {
  const trimmed = value?.trim();
  if (trimmed) server[key] = trimmed;
  else delete server[key];
};

const inboxSuggestionModeFromConfig = (config: ServerTomlConfig): InboxSuggestionMode => {
  const mode = config.inbox_suggestions;
  if (mode && INBOX_SUGGESTION_MODES.includes(mode)) return mode;
  if (typeof config.inbox_suggestions_enabled === "boolean")
    return config.inbox_suggestions_enabled ? "automatic" : "off";
  return DEFAULT_INBOX_SETTINGS.suggestions;
};

/** Model, effort and speed belong to the Agent they were chosen for. */
const inboxAgentChoiceFromConfig = (
  agent: unknown,
  choices: { readonly model: unknown; readonly effort: unknown; readonly speed: unknown },
  fallback: InboxAgentChoice,
): InboxAgentChoice => {
  const binding = decodeInboxAgentBinding(agent);
  return binding
    ? {
        instanceId: binding.instanceId,
        model: inboxChoiceFromConfig(choices.model),
        reasoningEffort: inboxChoiceFromConfig(choices.effort),
        serviceTier: inboxChoiceFromConfig(choices.speed),
      }
    : fallback;
};

function inboxSettingsFromConfig(config: ServerTomlConfig): InboxSettings {
  return {
    suggestions: inboxSuggestionModeFromConfig(config),
    dispatchMode: config.inbox_dispatch_mode === "act_on_requests" ? "act_on_requests" : "suggest",
    suggestionAgent: inboxAgentChoiceFromConfig(
      config.inbox_suggestion_agent,
      {
        model: config.inbox_suggestion_model,
        effort: config.inbox_suggestion_effort,
        speed: config.inbox_suggestion_speed,
      },
      DEFAULT_INBOX_SETTINGS.suggestionAgent,
    ),
    suggestionConcurrency:
      typeof config.inbox_suggestion_concurrency === "number" &&
      Number.isFinite(config.inbox_suggestion_concurrency)
        ? clampInboxSuggestionConcurrency(config.inbox_suggestion_concurrency)
        : DEFAULT_INBOX_SETTINGS.suggestionConcurrency,
    instructions:
      typeof config.inbox_instructions === "string"
        ? config.inbox_instructions.slice(0, MAX_INBOX_INSTRUCTIONS_CHARS)
        : DEFAULT_INBOX_SETTINGS.instructions,
    chatAgent: inboxAgentChoiceFromConfig(
      config.inbox_chat_agent,
      {
        model: config.inbox_chat_model,
        effort: config.inbox_chat_effort,
        speed: config.inbox_chat_speed,
      },
      DEFAULT_INBOX_SETTINGS.chatAgent,
    ),
    suggestionsChooseModels:
      typeof config.inbox_suggestions_choose_models === "boolean"
        ? config.inbox_suggestions_choose_models
        : DEFAULT_INBOX_SETTINGS.suggestionsChooseModels,
    useModelGuide:
      typeof config.inbox_use_model_guide === "boolean"
        ? config.inbox_use_model_guide
        : DEFAULT_INBOX_SETTINGS.useModelGuide,
    showPageBesideNewChats:
      typeof config.inbox_show_page_beside_new_chats === "boolean"
        ? config.inbox_show_page_beside_new_chats
        : DEFAULT_INBOX_SETTINGS.showPageBesideNewChats,
    newChatsUseWorktrees:
      typeof config.inbox_new_chats_use_worktrees === "boolean"
        ? config.inbox_new_chats_use_worktrees
        : DEFAULT_INBOX_SETTINGS.newChatsUseWorktrees,
  };
}

export function getInboxSettings(source: ApplicationSettingsDocumentSource): InboxSettings {
  return inboxSettingsFromConfig(loadProfileServerTomlConfig(source));
}

export function updateInboxSettings(
  input: UpdateInboxSettingsInput,
  source: ApplicationSettingsDocumentSource,
): InboxSettings {
  const current = getInboxSettings(source);
  const next: InboxSettings = { ...current, ...UpdateInboxSettingsInputSchema.parse(input) };
  const server: ServerTomlConfig = {
    ...loadProfileServerTomlConfig(source),
    inbox_suggestions: next.suggestions,
    inbox_dispatch_mode: next.dispatchMode,
    inbox_suggestion_agent: encodeInboxAgentBinding(next.suggestionAgent),
    inbox_suggestion_concurrency: next.suggestionConcurrency,
    inbox_instructions: next.instructions,
    inbox_chat_agent: encodeInboxAgentBinding(next.chatAgent),
    inbox_suggestions_choose_models: next.suggestionsChooseModels,
    inbox_use_model_guide: next.useModelGuide,
    inbox_show_page_beside_new_chats: next.showPageBesideNewChats,
    inbox_new_chats_use_worktrees: next.newChatsUseWorktrees,
  };
  delete server.inbox_suggestions_enabled;
  writeInboxChoice(server, "inbox_suggestion_model", next.suggestionAgent.model);
  writeInboxChoice(server, "inbox_suggestion_effort", next.suggestionAgent.reasoningEffort);
  writeInboxChoice(server, "inbox_suggestion_speed", next.suggestionAgent.serviceTier);
  writeInboxChoice(server, "inbox_chat_model", next.chatAgent.model);
  writeInboxChoice(server, "inbox_chat_effort", next.chatAgent.reasoningEffort);
  writeInboxChoice(server, "inbox_chat_speed", next.chatAgent.serviceTier);
  writeProfileServerTomlConfig(source, server);
  return getInboxSettings(source);
}

export function getLanguagePreference(
  source: ApplicationSettingsDocumentSource,
): AppLocalePreference {
  const document = source.document ?? readTomlConfig(source.settingsPath);
  return parseAppLocalePreference(document.locale);
}

export function updateLanguagePreference(
  preference: AppLocalePreference,
  source: ApplicationSettingsDocumentSource,
): void {
  const document = readTomlConfig(source.settingsPath);
  if (preference === null) delete document.locale;
  else document.locale = preference;
  writeTomlConfig(source.settingsPath, document);
}

export function getMiniSettings(source: ApplicationSettingsDocumentSource): MiniSettings {
  const { mini_shown, mini_resting } = loadProfileServerTomlConfig(source);
  return {
    shown: typeof mini_shown === "boolean" ? mini_shown : DEFAULT_MINI_SETTINGS.shown,
    resting:
      mini_resting && MINI_RESTING_MODES.includes(mini_resting)
        ? mini_resting
        : DEFAULT_MINI_SETTINGS.resting,
  };
}

export function getMiniPlacementSettings(
  source: ApplicationSettingsDocumentSource,
): MiniPlacementSettings {
  const { mini_last_display_id, mini_display_anchors } = loadProfileServerTomlConfig(source);
  const anchors: Record<string, MiniAnchor> = {};
  for (const [id, anchor] of Object.entries(mini_display_anchors ?? {})) {
    if (!/^-?\d+$/.test(id)) continue;
    if (anchor?.vertical !== "top" && anchor?.vertical !== "bottom") continue;
    if (
      anchor.horizontal !== "left" &&
      anchor.horizontal !== "center" &&
      anchor.horizontal !== "right"
    )
      continue;
    anchors[id] = { vertical: anchor.vertical, horizontal: anchor.horizontal };
  }
  return {
    lastDisplayId:
      typeof mini_last_display_id === "number" && Number.isSafeInteger(mini_last_display_id)
        ? mini_last_display_id
        : null,
    anchors,
  };
}

export function updateMiniSettings(
  change: Partial<MiniSettings>,
  source: ApplicationSettingsDocumentSource,
): void {
  const next = { ...getMiniSettings(source), ...change };
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    mini_shown: next.shown,
    mini_resting: next.resting,
  });
}

export function updateMiniPlacement(
  { displayId, anchor }: MiniPlacement,
  source: ApplicationSettingsDocumentSource,
): void {
  const { anchors } = getMiniPlacementSettings(source);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    mini_last_display_id: displayId,
    mini_display_anchors: { ...anchors, [displayId]: anchor },
  });
}

export function getWindowRestoreSettings(
  source: ApplicationSettingsDocumentSource,
): WindowRestoreSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return windowRestoreSettingsFromConfig(profileServerToml);
}

export function updateWindowRestoreSettings(
  input: UpdateWindowRestoreSettingsInput,
  source: ApplicationSettingsDocumentSource,
): WindowRestoreSettings {
  if (input.policy !== "all" && input.policy !== "last-window" && input.policy !== "none") {
    throw new Error("policy must be one of all, last-window, or none");
  }

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    window_restore_policy: input.policy,
  };

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getWindowRestoreSettings(source);
}

export function getAgentRuntimeSettings(
  source: ApplicationSettingsDocumentSource,
): AgentRuntimeSettings {
  const config = loadProfileServerTomlConfig(source);
  // Each choice stands alone, so a damaged writing model never resets the permission mode.
  return {
    automaticWorkAtOnce:
      AgentRuntimeSettingsSchema.shape.automaticWorkAtOnce.safeParse(config.automatic_work_at_once)
        .data ?? DEFAULT_AGENT_RUNTIME_SETTINGS.automaticWorkAtOnce,
    defaultRuntimeMode:
      AgentRuntimeModeSchema.safeParse(config.default_runtime_mode).data ??
      DEFAULT_AGENT_RUNTIME_SETTINGS.defaultRuntimeMode,
    writingModel:
      AgentRuntimeWritingModelSchema.safeParse(config.writing_model ?? config.title_model).data ??
      null,
    instructions: readAgentInstructionsSettings(config.agent_instructions),
    subagentsMayDelegate:
      AgentRuntimeSettingsSchema.shape.subagentsMayDelegate.safeParse(config.subagents_may_delegate)
        .data ?? DEFAULT_AGENT_RUNTIME_SETTINGS.subagentsMayDelegate,
  };
}

/** Each field stands alone, so one damaged instruction never resets the others. */
function readAgentInstructionsSettings(stored: unknown): AgentInstructionsSettings {
  const record = (typeof stored === "object" && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;
  const { shape } = AgentInstructionsSettingsSchema;
  return {
    artifactOpening:
      shape.artifactOpening.safeParse(record.artifactOpening).data ??
      DEFAULT_AGENT_INSTRUCTIONS_SETTINGS.artifactOpening,
    standingInstructions:
      shape.standingInstructions.safeParse(record.standingInstructions).data ??
      DEFAULT_AGENT_INSTRUCTIONS_SETTINGS.standingInstructions,
  };
}

export function updateAgentRuntimeSettings(
  input: UpdateAgentRuntimeSettingsInput,
  source: ApplicationSettingsDocumentSource,
): AgentRuntimeSettings {
  const settings = AgentRuntimeSettingsSchema.parse({
    ...getAgentRuntimeSettings(source),
    ...input,
  });
  const server: ServerTomlConfig = {
    ...loadProfileServerTomlConfig(source),
    default_runtime_mode: settings.defaultRuntimeMode,
    automatic_work_at_once: settings.automaticWorkAtOnce,
    subagents_may_delegate: settings.subagentsMayDelegate,
  };
  delete server.title_model;
  if (settings.writingModel) server.writing_model = settings.writingModel;
  else delete server.writing_model;
  server.agent_instructions = settings.instructions;
  writeProfileServerTomlConfig(source, server);
  return settings;
}

export function getComposerPredictionSettings(
  source: ApplicationSettingsDocumentSource,
): ComposerPredictionSettings {
  const enabled = loadProfileServerTomlConfig(source).composer_predictions_enabled;
  return typeof enabled === "boolean" ? { enabled } : DEFAULT_COMPOSER_PREDICTION_SETTINGS;
}

export function updateComposerPredictionSettings(
  input: ComposerPredictionSettings,
  source: ApplicationSettingsDocumentSource,
): ComposerPredictionSettings {
  const { enabled } = ComposerPredictionSettingsSchema.parse(input);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    composer_predictions_enabled: enabled,
  });
  return { enabled };
}

export function getUsageMeterSettings(
  source: ApplicationSettingsDocumentSource,
): UsageMeterSettings {
  const stored = loadProfileServerTomlConfig(source).usage_meters;
  const parsed = UsageMeterSettingsSchema.partial().safeParse(stored);
  return { ...DEFAULT_USAGE_METER_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

export function updateUsageMeterSettings(
  input: UsageMeterSettings,
  source: ApplicationSettingsDocumentSource,
): UsageMeterSettings {
  const settings = UsageMeterSettingsSchema.parse(input);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    usage_meters: settings,
  });
  return settings;
}

export function getFetchLinkFavicons(source: ApplicationSettingsDocumentSource): boolean {
  return loadProfileServerTomlConfig(source).fetch_link_favicons !== false;
}

export function updateFetchLinkFavicons(
  enabled: boolean,
  source: ApplicationSettingsDocumentSource,
): void {
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    fetch_link_favicons: enabled,
  });
}

/** Profile-owned URL destinations; absent values use the effective Desktop defaults. */
export function getLinkOpeningSettings(
  source: ApplicationSettingsDocumentSource,
): LinkOpeningSettings {
  const config = loadProfileServerTomlConfig(source);
  return {
    openLinkInTarget:
      LinkOpeningSettingsSchema.shape.openLinkInTarget.safeParse(config.open_link_in_target).data ??
      DEFAULT_LINK_OPENING_SETTINGS.openLinkInTarget,
    openLocalUrlInTarget:
      LinkOpeningSettingsSchema.shape.openLocalUrlInTarget.safeParse(
        config.open_local_url_in_target,
      ).data ?? DEFAULT_LINK_OPENING_SETTINGS.openLocalUrlInTarget,
    externalBrowserLinkShortcut:
      LinkOpeningSettingsSchema.shape.externalBrowserLinkShortcut.safeParse(
        config.external_browser_link_shortcut,
      ).data ?? DEFAULT_LINK_OPENING_SETTINGS.externalBrowserLinkShortcut,
    openGitHubThreadsInNodex:
      LinkOpeningSettingsSchema.shape.openGitHubThreadsInNodex.safeParse(
        config.open_github_threads_in_nodex,
      ).data ?? DEFAULT_LINK_OPENING_SETTINGS.openGitHubThreadsInNodex,
  };
}
export function updateLinkOpeningSettings(
  input: LinkOpeningSettings,
  source: ApplicationSettingsDocumentSource,
): LinkOpeningSettings {
  const settings = LinkOpeningSettingsSchema.parse(input);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    open_link_in_target: settings.openLinkInTarget,
    open_local_url_in_target: settings.openLocalUrlInTarget,
    external_browser_link_shortcut: settings.externalBrowserLinkShortcut,
    open_github_threads_in_nodex: settings.openGitHubThreadsInNodex,
  });
  return settings;
}

export function getTerminalShellSettings(
  source: ApplicationSettingsDocumentSource,
): TerminalShellSettings {
  const parsed = TerminalShellSettingsSchema.safeParse({
    windowsShell: loadProfileServerTomlConfig(source).terminal_shell,
  });
  return parsed.success ? parsed.data : DEFAULT_TERMINAL_SHELL_SETTINGS;
}

export function updateTerminalShellSettings(
  input: TerminalShellSettings,
  source: ApplicationSettingsDocumentSource,
): TerminalShellSettings {
  const settings = TerminalShellSettingsSchema.parse(input);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    terminal_shell: settings.windowsShell,
  });
  return getTerminalShellSettings(source);
}

/**
 * A policy saved while every provider had its own switch. Only Nodex's carries over: the others
 * duplicated their Agent's own on/off, and their models keep their individual switches.
 */
const ProviderSwitchesModelPolicySchema = z
  .object({
    providersOff: z.array(z.string().min(1)).max(4096),
    exceptions: ModelPolicySchema.shape.exceptions,
    agentsMayChooseCredit: z.boolean(),
  })
  .strict()
  .transform(({ providersOff, ...policy }): ModelPolicy => ({
    ...policy,
    nodexOff: providersOff.includes("nodex"),
  }));

const StoredModelPolicySchema = z.union([ModelPolicySchema, ProviderSwitchesModelPolicySchema]);

export function getModelPolicy(source: ApplicationSettingsDocumentSource): ModelPolicy {
  const stored = loadProfileServerTomlConfig(source).model_policy;
  if (stored === undefined) return DEFAULT_MODEL_POLICY;
  // Invalid spending policy fails closed instead of silently enabling credit.
  return StoredModelPolicySchema.parse(stored);
}
export function updateModelPolicy(
  input: ModelPolicy,
  source: ApplicationSettingsDocumentSource,
): ModelPolicy {
  const policy = ModelPolicySchema.parse(input);
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    model_policy: policy,
  });
  return policy;
}
