import * as path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type {
  AppUpdateSettings,
  BackupSettings,
  HistorySettings,
  ThreadNotificationSettings,
  UpdateAppUpdateSettingsInput,
  UpdateBackupSettingsInput,
  UpdateHistorySettingsInput,
  UpdateThreadNotificationSettingsInput,
} from "../../shared/types";

// ─── TOML [server] config (user-level + CWD walk-up for project-level) ───

interface ServerTomlConfig {
  dir?: string;
  port?: number;
  backup_auto_enabled?: boolean;
  backup_interval_hours?: number;
  backup_retention?: number;
  thread_completion_notifications_enabled?: boolean;
  history_retention?: number;
  app_updates_auto_check_enabled?: boolean;
}

interface RootTomlConfig extends Record<string, unknown> {
  server?: ServerTomlConfig;
}

const BACKUP_AUTO_DEFAULT = false;
const BACKUP_INTERVAL_DEFAULT = 6;
const BACKUP_RETENTION_DEFAULT = 28;
const THREAD_COMPLETION_NOTIFICATIONS_DEFAULT = true;
const APP_UPDATES_AUTO_CHECK_DEFAULT = true;

function readServerSection(configPath: string): ServerTomlConfig | null {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    return (parsed.server as ServerTomlConfig) ?? null;
  } catch {
    return null;
  }
}

function findProjectConfig(): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".nodex", "config.toml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadServerTomlConfig(): ServerTomlConfig {
  const merged: ServerTomlConfig = {};

  // User-level (~/.nodex/config.toml)
  const homeConfig = path.join(getHomeDir(), ".nodex", "config.toml");
  const homeServer = readServerSection(homeConfig);
  if (homeServer) Object.assign(merged, homeServer);

  // Project-level (CWD walk-up) overrides user-level
  const projectConfig = findProjectConfig();
  if (projectConfig) {
    const projectServer = readServerSection(projectConfig);
    if (projectServer) Object.assign(merged, projectServer);
  }

  return merged;
}

function loadUserServerTomlConfig(): ServerTomlConfig {
  const homeConfig = path.join(getHomeDir(), ".nodex", "config.toml");
  return readServerSection(homeConfig) ?? {};
}

function getUserConfigPath(): string {
  return path.join(getHomeDir(), ".nodex", "config.toml");
}

function getHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;
  return homedir();
}

function readTomlConfig(configPath: string): RootTomlConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseToml(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as RootTomlConfig;
    }
    return {};
  } catch (error) {
    throw new Error(`Could not read config file at ${configPath}: ${(error as Error).message}`);
  }
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(getHomeDir(), p.slice(1));
  return p;
}

let userServerToml = loadUserServerTomlConfig();
let serverToml = loadServerTomlConfig();

// ─── Getters (resolution: env → TOML → default) ───

export function getKanbanDir(): string {
  const envDir = process.env.KANBAN_DIR;
  if (envDir) {
    return path.isAbsolute(envDir)
      ? envDir
      : path.resolve(process.cwd(), envDir);
  }
  if (serverToml.dir) {
    const expanded = expandTilde(serverToml.dir);
    return path.isAbsolute(expanded)
      ? expanded
      : path.resolve(process.cwd(), expanded);
  }
  return path.join(getHomeDir(), ".nodex");
}

export function getDatabasePath(): string {
  return path.join(getKanbanDir(), "kanban.db");
}

export const KANBAN_DIR = getKanbanDir();

export function getPort(): number {
  const envPort = process.env.KANBAN_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof serverToml.port === "number") return serverToml.port;
  return 51283;
}

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

function parseIntegerEnv(
  value: string | undefined,
  fallback: number,
  minimum: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(minimum, parsed);
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

  return {
    autoEnabled,
    intervalHours,
    retentionCount,
  };
}

function threadNotificationSettingsFromConfig(config: ServerTomlConfig): ThreadNotificationSettings {
  return {
    threadCompletionEnabled:
      typeof config.thread_completion_notifications_enabled === "boolean"
        ? config.thread_completion_notifications_enabled
        : THREAD_COMPLETION_NOTIFICATIONS_DEFAULT,
  };
}

function appUpdateSettingsFromConfig(config: ServerTomlConfig): AppUpdateSettings {
  return {
    automaticChecksEnabled:
      typeof config.app_updates_auto_check_enabled === "boolean"
        ? config.app_updates_auto_check_enabled
        : APP_UPDATES_AUTO_CHECK_DEFAULT,
  };
}

export function getBackupSettings(): BackupSettings {
  const fromToml = backupSettingsFromConfig(serverToml);
  const envOverrides = {
    autoEnabled: process.env.KANBAN_BACKUP_AUTO_ENABLED !== undefined,
    intervalHours: process.env.KANBAN_BACKUP_INTERVAL_HOURS !== undefined,
    retentionCount: process.env.KANBAN_BACKUP_RETENTION !== undefined,
  };

  return {
    autoEnabled: envOverrides.autoEnabled
      ? parseBooleanEnv(process.env.KANBAN_BACKUP_AUTO_ENABLED, fromToml.autoEnabled)
      : fromToml.autoEnabled,
    intervalHours: envOverrides.intervalHours
      ? parseIntegerEnv(process.env.KANBAN_BACKUP_INTERVAL_HOURS, fromToml.intervalHours, 1)
      : fromToml.intervalHours,
    retentionCount: envOverrides.retentionCount
      ? parseIntegerEnv(process.env.KANBAN_BACKUP_RETENTION, fromToml.retentionCount, 0)
      : fromToml.retentionCount,
    envOverrides,
  };
}

export function updateBackupSettings(input: UpdateBackupSettingsInput): BackupSettings {
  if (typeof input.autoEnabled !== "boolean") {
    throw new Error("autoEnabled must be a boolean");
  }

  const nextSettings = {
    autoEnabled: input.autoEnabled,
    intervalHours: normalizeIntegerInput(input.intervalHours, 1, "intervalHours"),
    retentionCount: normalizeIntegerInput(input.retentionCount, 0, "retentionCount"),
  };

  const userConfigPath = getUserConfigPath();
  const nextToml = readTomlConfig(userConfigPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    backup_auto_enabled: nextSettings.autoEnabled,
    backup_interval_hours: nextSettings.intervalHours,
    backup_retention: nextSettings.retentionCount,
  };

  nextToml.server = nextServer;

  const configDirectory = path.dirname(userConfigPath);
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(userConfigPath, stringifyToml(nextToml as Record<string, unknown>), "utf8");

  userServerToml = loadUserServerTomlConfig();
  serverToml = loadServerTomlConfig();

  return getBackupSettings();
}

export function getHistorySettings(): HistorySettings {
  const fromToml =
    typeof serverToml.history_retention === "number"
      ? Math.max(0, serverToml.history_retention)
      : 1000;
  const envOverrides = {
    retentionCount: process.env.KANBAN_HISTORY_RETENTION !== undefined,
  };

  return {
    retentionCount: envOverrides.retentionCount
      ? parseIntegerEnv(process.env.KANBAN_HISTORY_RETENTION, fromToml, 0)
      : fromToml,
    envOverrides,
  };
}

export function updateHistorySettings(input: UpdateHistorySettingsInput): HistorySettings {
  const nextSettings = {
    retentionCount: normalizeIntegerInput(input.retentionCount, 0, "retentionCount"),
  };

  const userConfigPath = getUserConfigPath();
  const nextToml = readTomlConfig(userConfigPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    history_retention: nextSettings.retentionCount,
  };

  nextToml.server = nextServer;

  const configDirectory = path.dirname(userConfigPath);
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(userConfigPath, stringifyToml(nextToml as Record<string, unknown>), "utf8");

  userServerToml = loadUserServerTomlConfig();
  serverToml = loadServerTomlConfig();

  return getHistorySettings();
}

export function getThreadNotificationSettings(): ThreadNotificationSettings {
  return threadNotificationSettingsFromConfig(userServerToml);
}

export function updateThreadNotificationSettings(
  input: UpdateThreadNotificationSettingsInput,
): ThreadNotificationSettings {
  if (typeof input.threadCompletionEnabled !== "boolean") {
    throw new Error("threadCompletionEnabled must be a boolean");
  }

  const nextSettings = {
    threadCompletionEnabled: input.threadCompletionEnabled,
  };

  const userConfigPath = getUserConfigPath();
  const nextToml = readTomlConfig(userConfigPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    thread_completion_notifications_enabled: nextSettings.threadCompletionEnabled,
  };

  nextToml.server = nextServer;

  const configDirectory = path.dirname(userConfigPath);
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(userConfigPath, stringifyToml(nextToml as Record<string, unknown>), "utf8");

  userServerToml = loadUserServerTomlConfig();
  serverToml = loadServerTomlConfig();

  return getThreadNotificationSettings();
}

export function getAppUpdateSettings(): AppUpdateSettings {
  return appUpdateSettingsFromConfig(userServerToml);
}

export function updateAppUpdateSettings(
  input: UpdateAppUpdateSettingsInput,
): AppUpdateSettings {
  if (typeof input.automaticChecksEnabled !== "boolean") {
    throw new Error("automaticChecksEnabled must be a boolean");
  }

  const userConfigPath = getUserConfigPath();
  const nextToml = readTomlConfig(userConfigPath);
  const nextServer = {
    ...(nextToml.server ?? {}),
    app_updates_auto_check_enabled: input.automaticChecksEnabled,
  };

  nextToml.server = nextServer;

  const configDirectory = path.dirname(userConfigPath);
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(userConfigPath, stringifyToml(nextToml as Record<string, unknown>), "utf8");

  userServerToml = loadUserServerTomlConfig();
  serverToml = loadServerTomlConfig();

  return getAppUpdateSettings();
}

export function getThreadCompletionNotificationsEnabled(): boolean {
  return getThreadNotificationSettings().threadCompletionEnabled;
}

export function getBackupAutoEnabled(): boolean {
  return getBackupSettings().autoEnabled;
}

export function getBackupIntervalHours(): number {
  return getBackupSettings().intervalHours;
}

export function getBackupRetention(): number {
  return getBackupSettings().retentionCount;
}

export function getHistoryRetention(): number {
  return getHistorySettings().retentionCount;
}
