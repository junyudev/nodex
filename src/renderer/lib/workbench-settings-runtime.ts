import type { AgentImportSourceKind } from "../../shared/agent-import";
import type { UpdateAcpAgentSettingsInput, UpdateCodexGitSettingsInput } from "../../shared/types";
import type {
  RestoreBackupInput,
  UpdateBackupSettingsInput,
  UpdateDiagnosticsSettingsInput,
  UpdateHistorySettingsInput,
  UpdateTelemetrySettingsInput,
} from "./types";
import { openFileLink } from "./file-system-operations";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const updateDiagnosticsSettingsCommand = defineRendererCommand({
  key: "workbench_settings.diagnostics.update",
  channel: "settings:diagnostics:update",
  authority: "main",
  owner: "WorkbenchSettings",
  protocol: { kind: "returned_value" },
});

const updateTelemetrySettingsCommand = defineRendererCommand({
  key: "workbench_settings.telemetry.update",
  channel: "settings:telemetry:update",
  authority: "main",
  owner: "WorkbenchSettings",
  protocol: { kind: "returned_value" },
});

const updateBackupSettingsCommand = defineRendererCommand({
  key: "workbench_settings.backup.update",
  channel: "settings:backup:update",
  authority: "main",
  owner: "BackupSettings",
  protocol: { kind: "returned_value" },
});

const updateHistorySettingsCommand = defineRendererCommand({
  key: "workbench_settings.history.update",
  channel: "settings:history:update",
  authority: "main",
  owner: "BackupSettings",
  protocol: { kind: "returned_value" },
});

const restoreBackupCommand = defineRendererCommand({
  key: "backup.restore",
  channel: "backup:restore",
  authority: "main",
  owner: "BackupRuntime",
  protocol: { kind: "returned_value" },
});

const deleteBackupCommand = defineRendererCommand({
  key: "backup.delete",
  channel: "backup:delete",
  authority: "main",
  owner: "BackupRuntime",
  protocol: { kind: "returned_value" },
});

const updateCodexPermissionConfigValueCommand = defineRendererCommand({
  key: "workbench_settings.codex_permission_config.update",
  channel: "codex:permission:config-value:set",
  authority: "main",
  owner: "CodexPermissionSettings",
  protocol: { kind: "returned_value" },
});

const updateCodexPermissionModeCommand = defineRendererCommand({
  key: "workbench_settings.codex_permission_mode.update",
  channel: "codex:permission:mode:set",
  authority: "main",
  owner: "CodexPermissionSettings",
  protocol: { kind: "returned_value" },
});

const updateGitSettingsCommand = defineRendererCommand({
  key: "workbench_settings.git.update",
  channel: "settings:git:update",
  authority: "main",
  owner: "WorkbenchSettings",
  protocol: { kind: "returned_value" },
});

const updateAcpAgentSettingsCommand = defineRendererCommand({
  key: "workbench_settings.acp_agents.update",
  channel: "settings:acp-agents:update",
  authority: "main",
  owner: "AgentBackendSettings",
  protocol: { kind: "returned_value" },
});

const applyAgentImportCommand = defineRendererCommand({
  key: "agent_import.apply",
  channel: "agent-import:apply",
  authority: "main",
  owner: "AgentImportSettings",
  protocol: { kind: "returned_value" },
});

const unarchiveChatCommand = defineRendererCommand({
  key: "archived_chats.unarchive",
  channel: "codex:thread:unarchive",
  authority: "external",
  owner: "ArchivedChatsSettings",
  protocol: { kind: "returned_value" },
});

const deleteArchivedChatCommand = defineRendererCommand({
  key: "archived_chats.delete",
  channel: "codex:thread:delete-archived",
  authority: "external",
  owner: "ArchivedChatsSettings",
  protocol: { kind: "returned_value" },
});

export const readDiagnosticsSettings = () => invokeRendererQuery("settings:diagnostics:get");

export const updateDiagnosticsSettings = (input: UpdateDiagnosticsSettingsInput) =>
  invokePlainCommand(updateDiagnosticsSettingsCommand, input);

export const readTelemetrySettings = () => invokeRendererQuery("settings:telemetry:get");

export const updateTelemetrySettings = (input: UpdateTelemetrySettingsInput) =>
  invokePlainCommand(updateTelemetrySettingsCommand, input);

export const readBackupSettings = () => invokeRendererQuery("settings:backup:get");

export const updateBackupSettings = (input: UpdateBackupSettingsInput) =>
  invokePlainCommand(updateBackupSettingsCommand, input);

export const readHistorySettings = () => invokeRendererQuery("settings:history:get");

export const updateHistorySettings = (input: UpdateHistorySettingsInput) =>
  invokePlainCommand(updateHistorySettingsCommand, input);

export const restoreBackup = (input: RestoreBackupInput) =>
  invokePlainCommand(restoreBackupCommand, input);

export const deleteBackup = (backupId: string) => invokePlainCommand(deleteBackupCommand, backupId);

export const readThirdPartyNotices = () => invokeRendererQuery("settings:third-party-notices:get");

export const readCodexPermissionState = (projectId: string | null) =>
  invokeRendererQuery("codex:permission:state:get", projectId);

export const updateCodexPermissionConfigValue = (
  projectId: string | null,
  keyPath: string,
  value: unknown,
) => invokePlainCommand(updateCodexPermissionConfigValueCommand, projectId, keyPath, value);

export const updateCodexPermissionMode = (
  projectId: string | null,
  mode: "auto" | "guardian-approvals" | "full-access" | "custom",
) => invokePlainCommand(updateCodexPermissionModeCommand, projectId, mode);

export const revealFileInManager = (path: string) => openFileLink({ path }, "fileManager");

export const readGitSettings = () => invokeRendererQuery("settings:git:get");

export const updateGitSettings = (input: UpdateCodexGitSettingsInput) =>
  invokePlainCommand(updateGitSettingsCommand, input);

export const readAcpAgentSettings = () => invokeRendererQuery("settings:acp-agents:get");

export const updateAcpAgentSettings = (input: UpdateAcpAgentSettingsInput) =>
  invokePlainCommand(updateAcpAgentSettingsCommand, input);

export const scanAgentImport = (sourceKind: AgentImportSourceKind) =>
  invokeRendererQuery("agent-import:scan", { sourceKind });

export const scanPickedAgentImportHome = (sourceKind: AgentImportSourceKind) =>
  invokeRendererQuery("agent-import:scan-picked-home", { sourceKind });

export const applyAgentImport = (scanId: string, itemIds: readonly string[]) =>
  invokePlainCommand(applyAgentImportCommand, { itemIds, scanId });

export const readArchivedChats = (refresh: boolean) =>
  invokeRendererQuery("codex:sidebar:snapshot", { includeArchived: true, refresh });

export const unarchiveChat = (threadId: string) =>
  invokePlainCommand(unarchiveChatCommand, threadId);

export const deleteArchivedChat = (threadId: string) =>
  invokePlainCommand(deleteArchivedChatCommand, threadId);
