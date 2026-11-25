import type {
  CodexExecutionHostSettings,
  ManagedWorktreeRecord,
  ManagedWorktreeRestoreResult,
  ManagedWorktreeSettings,
  UpdateManagedWorktreeSettingsInput,
  UpdateWorktreeEnvironmentConfigInput,
  WorktreeEnvironmentConfigRecord,
  ThreadWorkspaceAvailability,
  WorktreeEnvironmentSaveResult,
} from "./types";
import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
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

/**
 * The one query for a chat's working directory. Every observer shares these options, so a
 * passive reader never replaces the fetch the composer's check relies on.
 */
export function threadWorkspaceAvailabilityQuery(threadId: string) {
  return queryOptions({
    queryKey: queryKeys.threadExecution.workspace(threadId),
    queryFn: async () => await readThreadWorkspaceAvailability(threadId),
    staleTime: 0,
    retry: false,
  });
}

/** Whether a chat's working directory is still there, and how to recover when it isn't. */
export function readThreadWorkspaceAvailability(
  threadId: string,
): Promise<ThreadWorkspaceAvailability> {
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
