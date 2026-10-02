import path from "node:path";
import { z } from "zod";
import {
  CLAUDE_ENVIRONMENT_LIMIT,
  ClaudeAgentInstanceFields,
  ClaudeAgentSettingsUpdateSchema,
  ClaudeEnvironmentNameSchema,
  ClaudeEnvironmentValueSchema,
  defaultClaudeInstance,
  type ClaudeAgentSettings,
  type UpdateClaudeAgentSettingsInput,
} from "../../shared/claude-agent-settings";
import {
  presentAgentEnvironment,
  resolveAgentEnvironment,
  writeAgentEnvironments,
  type AgentEnvironmentStorage,
} from "./agent-environment-storage";
const StoredEnvironmentSchema = z.discriminatedUnion("sensitive", [
  z
    .object({
      name: ClaudeEnvironmentNameSchema,
      sensitive: z.literal(false),
      value: ClaudeEnvironmentValueSchema,
    })
    .strict(),
  z
    .object({
      name: ClaudeEnvironmentNameSchema,
      sensitive: z.literal(true),
      secretRef: z.string().uuid(),
    })
    .strict(),
]);
const StoredInstancesSchema = z
  .array(
    z
      .object({
        ...ClaudeAgentInstanceFields,
        configDirectory: ClaudeAgentInstanceFields.configDirectory.refine(
          (value) => value === "" || path.isAbsolute(value),
        ),
        environment: z
          .array(StoredEnvironmentSchema)
          .max(CLAUDE_ENVIRONMENT_LIMIT)
          .default([])
          .refine((values) => new Set(values.map(({ name }) => name)).size === values.length),
      })
      .strict(),
  )
  .max(32)
  .refine((instances) => new Set(instances.map(({ id }) => id)).size === instances.length);
type StoredInstances = z.infer<typeof StoredInstancesSchema>;
export type ClaudeEnvironmentStorage = Omit<AgentEnvironmentStorage, "backend">;
export function readStoredClaudeInstances(value: unknown): StoredInstances {
  const result = StoredInstancesSchema.safeParse(value ?? [defaultClaudeInstance()]);
  if (!result.success) throw new Error("Invalid saved Claude Code settings.");
  return result.data;
}

export const presentClaudeInstances = (instances: StoredInstances): ClaudeAgentSettings => ({
  instances: instances.map((instance) => ({
    ...instance,
    environment: presentAgentEnvironment(instance.environment),
  })),
});

/** Publish references last so failed writes leave the previous configuration usable. */
export function writeClaudeInstances(
  source: ClaudeEnvironmentStorage,
  input: UpdateClaudeAgentSettingsInput,
  previous: StoredInstances,
  publish: (next: StoredInstances) => void,
): void {
  const result = ClaudeAgentSettingsUpdateSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid Claude environment. Check names, duplicate variables and value limits.",
    );
  const normalized = result.data.instances.map((instance) => {
    const directory = instance.configDirectory;
    if (directory.startsWith("~/") && !source.hostHomeDirectory)
      throw new Error(
        "The host home directory is unavailable. Use an absolute Claude config path.",
      );
    const configDirectory = directory.startsWith("~/")
      ? path.resolve(source.hostHomeDirectory!, directory.slice(2))
      : directory;
    if (configDirectory && !path.isAbsolute(configDirectory))
      throw new Error("Claude config directory must be absolute or start with ~/.");
    return { ...instance, configDirectory };
  });
  writeAgentEnvironments({ ...source, backend: "claude" }, normalized, previous, publish);
}
/** Main-only launch read. Never expose the resolved environment through settings IPC. */
export function resolveClaudeLaunchConfiguration(
  source: ClaudeEnvironmentStorage,
  instances: StoredInstances,
  id: string,
) {
  const stored = instances.find((instance) => instance.id === id);
  if (!stored?.enabled) throw new Error("Claude instance is unavailable or disabled.");
  return {
    instance: presentClaudeInstances([stored]).instances[0]!,
    environment: resolveAgentEnvironment({ ...source, backend: "claude" }, stored),
  };
}
