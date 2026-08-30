import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveWorktreeEnvironmentConfig } from "./managed-worktree-runtime";
import {
  localEnvironmentConfigsQueryOptions,
  localEnvironmentOptionsQueryOptions,
  localEnvironmentSnapshotQueryOptions,
} from "./query-options";
import { queryKeys } from "./query-keys";
import type { UpdateWorktreeEnvironmentConfigInput } from "./types";

interface QueryEnabledOptions {
  enabled?: boolean;
}

export function useLocalEnvironmentConfigs(projectId: string, options: QueryEnabledOptions = {}) {
  const enabled = options.enabled !== false && projectId.trim().length > 0;
  return useQuery({
    ...localEnvironmentConfigsQueryOptions(projectId),
    enabled,
  });
}

export function useLocalEnvironmentOptions(projectId: string, options: QueryEnabledOptions = {}) {
  const enabled = options.enabled !== false && projectId.trim().length > 0;
  return useQuery({
    ...localEnvironmentOptionsQueryOptions(projectId),
    enabled,
  });
}

export function useLocalEnvironmentSnapshot(
  projectId: string,
  configPath?: string | null,
  options: QueryEnabledOptions = {},
) {
  const enabled = options.enabled !== false && projectId.trim().length > 0;
  return useQuery({
    ...localEnvironmentSnapshotQueryOptions(projectId, configPath),
    enabled,
  });
}

export function useSaveLocalEnvironmentConfigMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateWorktreeEnvironmentConfigInput) =>
      saveWorktreeEnvironmentConfig(input),
    onSuccess: async (result, input) => {
      if (result.type === "conflict") return;

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.localEnvironments.configScope(input.projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.localEnvironments.configs(input.projectId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.localEnvironments.options(input.projectId),
          exact: true,
        }),
      ]);
    },
  });
}
