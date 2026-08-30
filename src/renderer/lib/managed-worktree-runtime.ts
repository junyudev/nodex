import type {
  CodexExecutionHostSettings,
  ManagedWorktreeAvailability,
  ManagedWorktreeRecord,
  ManagedWorktreeRestoreResult,
  ManagedWorktreeSettings,
  UpdateManagedWorktreeSettingsInput,
  UpdateWorktreeEnvironmentConfigInput,
  WorktreeEnvironmentConfigRecord,
  WorktreeEnvironmentSaveResult,
} from "./types";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const updateManagedWorktreeSettingsCommand = defineRendererCommand({
  key: "managed_worktree.settings.update",
  channel: "worktrees:settings:update",
  authority: "main",
  owner: "ManagedWorktreeRuntime",
  protocol: { kind: "returned_value" },
});

const deleteManagedWorktreeCommand = defineRendererCommand({
  key: "managed_worktree.delete",
  channel: "worktrees:delete",
  authority: "external",
  owner: "ManagedWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const restoreManagedWorktreeCommand = defineRendererCommand({
  key: "managed_worktree.restore",
  channel: "worktrees:thread:restore",
  authority: "external",
  owner: "ManagedWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const saveWorktreeEnvironmentConfigCommand = defineRendererCommand({
  key: "managed_worktree.environment_config.save",
  channel: "worktrees:environments:config:save",
  authority: "external",
  owner: "LocalEnvironmentConfigs",
  protocol: { kind: "returned_value" },
});

export interface ManagedWorktreesSettingsService {
  getSettings(): Promise<ManagedWorktreeSettings>;
  getExecutionHosts(): Promise<CodexExecutionHostSettings>;
  updateSettings(input: UpdateManagedWorktreeSettingsInput): Promise<ManagedWorktreeSettings>;
  list(hostId: string): Promise<ManagedWorktreeRecord[]>;
  delete(hostId: string, worktreePath: string): Promise<boolean>;
}

export const managedWorktreeSettingsService: ManagedWorktreesSettingsService = {
  getSettings: async () => await invokeRendererQuery("worktrees:settings:get"),
  getExecutionHosts: async () => await invokeRendererQuery("worktrees:execution-hosts:get"),
  updateSettings: async (input) =>
    await invokePlainCommand(updateManagedWorktreeSettingsCommand, input),
  list: async (hostId) => await invokeRendererQuery("worktrees:list", hostId),
  delete: async (hostId, worktreePath) =>
    await invokePlainCommand(deleteManagedWorktreeCommand, hostId, worktreePath),
};

export function readManagedWorktreeAvailability(
  threadId: string,
): Promise<ManagedWorktreeAvailability> {
  return invokeRendererQuery("worktrees:thread:availability", threadId);
}

export function restoreManagedWorktree(threadId: string): Promise<ManagedWorktreeRestoreResult> {
  return invokePlainCommand(restoreManagedWorktreeCommand, threadId);
}

export function saveWorktreeEnvironmentConfig(
  input: UpdateWorktreeEnvironmentConfigInput,
): Promise<WorktreeEnvironmentSaveResult> {
  return invokePlainCommand(saveWorktreeEnvironmentConfigCommand, input);
}

export function listWorktreeEnvironmentConfigs(
  projectId: string,
): Promise<WorktreeEnvironmentConfigRecord[]> {
  return invokeRendererQuery("worktrees:environments:configs:list", projectId);
}

export function listWorktreeEnvironmentConfigsForWorkspace(
  hostId: string,
  workspaceRoot: string,
): Promise<WorktreeEnvironmentConfigRecord[]> {
  return invokeRendererQuery(
    "worktrees:environments:configs:list-for-workspace",
    hostId,
    workspaceRoot,
  );
}
