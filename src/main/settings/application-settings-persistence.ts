import * as path from "path";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { stringify as stringifyToml } from "smol-toml";
import {
  applyCommandKeybindingUpdate,
  createCommandKeymapState,
  normalizeCommandKeybindingOverrides,
  type CommandKeybindingOverrides,
  type CommandKeybindingUpdate,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import type {
  AppUpdateSettings,
  BackupSettings,
  CodexDeveloperInstructionSettings,
  CodexGitSettings,
  CodexExecutionHostSettings,
  CodexThreadDetailLevel,
  DiagnosticsSettings,
  HistorySettings,
  ManagedWorktreeSettings,
  TelemetrySettings,
  ThreadNotificationSettings,
  ThreadNotificationTurnMode,
  UpdateAppUpdateSettingsInput,
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
import { normalizeCodexSshExecutionHostConfig } from "../codex/codex-ssh-execution-host";
import { readSettingsTomlDocument, type SettingsTomlDocument } from "./settings-document";

// ─── Profile-local TOML [server] settings ───

interface ServerTomlConfig {
  home?: string;
  backup_auto_enabled?: boolean;
  backup_interval_hours?: number;
  backup_retention?: number;
  backup_retention_gib?: number;
  thread_notifications_turn_mode?: ThreadNotificationTurnMode;
  thread_notifications_permissions_enabled?: boolean;
  thread_notifications_questions_enabled?: boolean;
  history_retention?: number;
  app_updates_auto_check_enabled?: boolean;
  app_updates_channel?: "stable" | "nightly";
  window_restore_policy?: WindowRestorePolicy;
  diagnostics_enabled?: boolean;
  diagnostics_dsn?: string;
  diagnostics_environment?: string;
  diagnostics_release?: string;
  diagnostics_traces_sample_rate?: number;
  diagnostics_replay_enabled?: boolean;
  diagnostics_replays_session_sample_rate?: number;
  diagnostics_replays_on_error_sample_rate?: number;
  telemetry_enabled?: boolean;
  telemetry_client_key?: string;
  telemetry_environment?: string;
  telemetry_auto_capture_enabled?: boolean;
  command_keybindings?: Record<string, unknown>;
  codex_thread_detail_level?: CodexThreadDetailLevel;
  git_branch_prefix?: string;
  git_commit_instructions?: string;
  git_pr_instructions?: string;
  worktree_root?: string;
  worktree_auto_delete_enabled?: boolean;
  worktree_auto_delete_limit?: number;
  execution_hosts?: unknown[];
}

interface RootTomlConfig extends Record<string, unknown> {
  server?: ServerTomlConfig;
}

export interface ApplicationSettingsDocumentSource {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly settingsPath: string;
  readonly document?: SettingsTomlDocument;
}

const BACKUP_AUTO_DEFAULT = false;
const BACKUP_INTERVAL_DEFAULT = 6;
const BACKUP_RETENTION_DEFAULT = 28;
const BACKUP_RETENTION_GIB_DEFAULT = 32;
const BACKUP_RETENTION_GIB_MAX = 8_192;
const THREAD_NOTIFICATIONS_TURN_MODE_DEFAULT: ThreadNotificationTurnMode = "unfocused";
const THREAD_NOTIFICATIONS_PERMISSIONS_ENABLED_DEFAULT = true;
const THREAD_NOTIFICATIONS_QUESTIONS_ENABLED_DEFAULT = true;
const APP_UPDATES_AUTO_CHECK_DEFAULT = true;
const WINDOW_RESTORE_POLICY_DEFAULT: WindowRestorePolicy = "all";
export const DEFAULT_SENTRY_DSN =
  "https://ecf630563128267bf9798a10b45a089a@o4511580306014208.ingest.us.sentry.io/4511580310011904";
export const DEFAULT_STATSIG_CLIENT_KEY = "client-wpoc5Yx721NAMgJde6jcWUTiEP9kp2Ll9nr4EUxdmiP";
const DIAGNOSTICS_ENVIRONMENT_DEFAULT = "production";
const DIAGNOSTICS_TRACES_SAMPLE_RATE_DEFAULT = 0;
const DIAGNOSTICS_REPLAY_ENABLED_DEFAULT = false;
const DIAGNOSTICS_REPLAYS_SESSION_SAMPLE_RATE_DEFAULT = 0.1;
const DIAGNOSTICS_REPLAYS_ON_ERROR_SAMPLE_RATE_DEFAULT = 1;
const TELEMETRY_ENVIRONMENT_DEFAULT = "production";
const TELEMETRY_AUTO_CAPTURE_ENABLED_DEFAULT = false;
const CODEX_THREAD_DETAIL_LEVEL_DEFAULT: CodexThreadDetailLevel = "STEPS_COMMANDS";
const CODEX_GIT_BRANCH_PREFIX_DEFAULT = "codex/";
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

function writeTomlConfig(configPath: string, nextToml: RootTomlConfig): void {
  const configDirectory = path.dirname(configPath);
  mkdirSync(configDirectory, { recursive: true });
  const temporaryPath = path.join(
    configDirectory,
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, stringifyToml(nextToml as Record<string, unknown>), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, configPath);
    try {
      const directoryDescriptor = openSync(configDirectory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
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
    turnMode:
      config.thread_notifications_turn_mode === "off" ||
      config.thread_notifications_turn_mode === "unfocused" ||
      config.thread_notifications_turn_mode === "always"
        ? config.thread_notifications_turn_mode
        : THREAD_NOTIFICATIONS_TURN_MODE_DEFAULT,
    permissionsEnabled:
      typeof config.thread_notifications_permissions_enabled === "boolean"
        ? config.thread_notifications_permissions_enabled
        : THREAD_NOTIFICATIONS_PERMISSIONS_ENABLED_DEFAULT,
    questionsEnabled:
      typeof config.thread_notifications_questions_enabled === "boolean"
        ? config.thread_notifications_questions_enabled
        : THREAD_NOTIFICATIONS_QUESTIONS_ENABLED_DEFAULT,
  };
}

function appUpdateSettingsFromConfig(
  config: ServerTomlConfig,
  buildDefaultChannel: AppUpdateSettings["channel"] = "stable",
): AppUpdateSettings {
  return {
    automaticChecksEnabled:
      typeof config.app_updates_auto_check_enabled === "boolean"
        ? config.app_updates_auto_check_enabled
        : APP_UPDATES_AUTO_CHECK_DEFAULT,
    channel:
      config.app_updates_channel === "stable" || config.app_updates_channel === "nightly"
        ? config.app_updates_channel
        : buildDefaultChannel,
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
): Omit<DiagnosticsSettings, "envOverrides"> {
  const enabled = config.diagnostics_enabled === true;
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

function telemetrySettingsFromConfig(
  config: ServerTomlConfig,
): Omit<TelemetrySettings, "envOverrides"> {
  const enabled = config.telemetry_enabled === true;
  const configuredClientKey =
    typeof config.telemetry_client_key === "string" ? config.telemetry_client_key.trim() : "";
  const environment =
    typeof config.telemetry_environment === "string" && config.telemetry_environment.trim()
      ? config.telemetry_environment.trim()
      : TELEMETRY_ENVIRONMENT_DEFAULT;
  const autoCaptureEnabled =
    typeof config.telemetry_auto_capture_enabled === "boolean"
      ? config.telemetry_auto_capture_enabled
      : TELEMETRY_AUTO_CAPTURE_ENABLED_DEFAULT;

  return {
    enabled,
    clientKey: configuredClientKey || (enabled ? DEFAULT_STATSIG_CLIENT_KEY : ""),
    environment,
    autoCaptureEnabled,
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
  const profileServerToml = loadProfileServerTomlConfig(source);
  const environmentSource = source.environment;
  const fromToml = telemetrySettingsFromConfig(profileServerToml);
  const envOverrides = {
    enabled: environmentSource.NODEX_TELEMETRY_ENABLED !== undefined,
    clientKey: environmentSource.STATSIG_CLIENT_KEY !== undefined,
    environment: environmentSource.STATSIG_ENVIRONMENT !== undefined,
    autoCaptureEnabled: environmentSource.NODEX_TELEMETRY_AUTOCAPTURE_ENABLED !== undefined,
  };

  const enabled = envOverrides.enabled
    ? parseBooleanEnv(environmentSource.NODEX_TELEMETRY_ENABLED, fromToml.enabled)
    : fromToml.enabled;
  const clientKeyFromEnv = environmentSource.STATSIG_CLIENT_KEY?.trim() ?? "";
  const clientKey = envOverrides.clientKey
    ? clientKeyFromEnv
    : fromToml.clientKey || (enabled ? DEFAULT_STATSIG_CLIENT_KEY : "");
  const environmentFromEnv = environmentSource.STATSIG_ENVIRONMENT?.trim() ?? "";
  const environment =
    envOverrides.environment && environmentFromEnv ? environmentFromEnv : fromToml.environment;
  const autoCaptureEnabled = envOverrides.autoCaptureEnabled
    ? parseBooleanEnv(
        environmentSource.NODEX_TELEMETRY_AUTOCAPTURE_ENABLED,
        fromToml.autoCaptureEnabled,
      )
    : fromToml.autoCaptureEnabled;

  return {
    enabled,
    clientKey,
    environment,
    autoCaptureEnabled,
    envOverrides,
  };
}

export function updateTelemetrySettings(
  input: UpdateTelemetrySettingsInput,
  source: ApplicationSettingsDocumentSource,
): TelemetrySettings {
  if (typeof input.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (typeof input.autoCaptureEnabled !== "boolean") {
    throw new Error("autoCaptureEnabled must be a boolean");
  }

  const nextSettings = {
    enabled: input.enabled,
    clientKey: normalizeOptionalStringInput(input.clientKey, "clientKey"),
    environment:
      normalizeOptionalStringInput(input.environment, "environment") ??
      TELEMETRY_ENVIRONMENT_DEFAULT,
    autoCaptureEnabled: input.autoCaptureEnabled,
  };

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer: ServerTomlConfig = {
    ...(nextToml.server ?? {}),
    telemetry_enabled: nextSettings.enabled,
    telemetry_environment: nextSettings.environment,
    telemetry_auto_capture_enabled: nextSettings.autoCaptureEnabled,
  };
  if (nextSettings.clientKey) {
    nextServer.telemetry_client_key = nextSettings.clientKey;
  } else {
    delete nextServer.telemetry_client_key;
  }

  nextToml.server = nextServer;

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
  };
}

export function updateCodexDeveloperInstructionSettings(
  input: UpdateCodexDeveloperInstructionSettingsInput,
  source: ApplicationSettingsDocumentSource,
): CodexDeveloperInstructionSettings {
  if (!isCodexThreadDetailLevel(input.detailLevel)) {
    throw new Error("detailLevel must be one of STEPS_PROSE, STEPS_COMMANDS, or STEPS_EXECUTION");
  }
  writeProfileServerTomlConfig(source, {
    ...loadProfileServerTomlConfig(source),
    codex_thread_detail_level: input.detailLevel,
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

export function getManagedWorktreeSettings(
  source: ApplicationSettingsDocumentSource,
): ManagedWorktreeSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return {
    worktreeRoot:
      typeof profileServerToml.worktree_root === "string" && profileServerToml.worktree_root.trim()
        ? path.resolve(profileServerToml.worktree_root.trim())
        : null,
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
  const next = { ...loadProfileServerTomlConfig(source) };
  // Historical roots were an accidental discovery/authorization registry. A
  // managed settings write canonicalizes legacy documents to the single-root model.
  delete (next as Record<string, unknown>).worktree_known_roots;
  if (input.worktreeRoot !== undefined) {
    const normalized = input.worktreeRoot?.trim() ?? "";
    if (normalized) {
      next.worktree_root = path.resolve(normalized);
    } else delete next.worktree_root;
  }
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
  if (input.turnMode !== "off" && input.turnMode !== "unfocused" && input.turnMode !== "always") {
    throw new Error("turnMode must be one of off, unfocused, or always");
  }
  if (typeof input.permissionsEnabled !== "boolean") {
    throw new Error("permissionsEnabled must be a boolean");
  }
  if (typeof input.questionsEnabled !== "boolean") {
    throw new Error("questionsEnabled must be a boolean");
  }

  const nextSettings = {
    turnMode: input.turnMode,
    permissionsEnabled: input.permissionsEnabled,
    questionsEnabled: input.questionsEnabled,
  };

  const profileSettingsPath = getProfileSettingsPath(source);
  const nextToml = readTomlConfig(profileSettingsPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    thread_notifications_turn_mode: nextSettings.turnMode,
    thread_notifications_permissions_enabled: nextSettings.permissionsEnabled,
    thread_notifications_questions_enabled: nextSettings.questionsEnabled,
  };

  nextToml.server = nextServer;

  writeTomlConfig(profileSettingsPath, nextToml);
  return getThreadNotificationSettings(source);
}

export function getAppUpdateSettings(
  source: ApplicationSettingsDocumentSource,
  buildDefaultChannel: AppUpdateSettings["channel"] = "stable",
): AppUpdateSettings {
  const profileServerToml = loadProfileServerTomlConfig(source);
  return appUpdateSettingsFromConfig(profileServerToml, buildDefaultChannel);
}

export function updateAppUpdateSettings(
  input: UpdateAppUpdateSettingsInput,
  source: ApplicationSettingsDocumentSource,
  buildDefaultChannel: AppUpdateSettings["channel"] = "stable",
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
  return getAppUpdateSettings(source, buildDefaultChannel);
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
