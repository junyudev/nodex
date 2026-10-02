import path from "node:path";
import { z } from "zod";
import {
  AGENT_ENVIRONMENT_LIMIT,
  AgentEnvironmentValueSchema,
} from "../../shared/agent-environment";
import {
  OpenCodeAgentInstanceFields,
  OpenCodeAgentSettingsUpdateSchema,
  openCodeEnvironmentNameError,
  defaultOpenCodeInstance,
  type OpenCodeAgentSettings,
  type UpdateOpenCodeAgentSettingsInput,
} from "../../shared/opencode-agent-settings";
import {
  presentAgentEnvironment,
  resolveAgentEnvironment,
  writeAgentEnvironments,
  type AgentEnvironmentStorage,
} from "./agent-environment-storage";

const nameSchema = z.string().superRefine((name, context) => {
  const message = openCodeEnvironmentNameError(name);
  if (message) context.addIssue({ code: "custom", message });
});
const StoredEnvironmentSchema = z.discriminatedUnion("sensitive", [
  z
    .object({ name: nameSchema, sensitive: z.literal(false), value: AgentEnvironmentValueSchema })
    .strict(),
  z.object({ name: nameSchema, sensitive: z.literal(true), secretRef: z.uuid() }).strict(),
]);
const StoredInstancesSchema = z
  .array(
    z
      .object({
        ...OpenCodeAgentInstanceFields,
        profileDirectory: OpenCodeAgentInstanceFields.profileDirectory
          .refine((value) => value === null || path.isAbsolute(value))
          .default(null),
        serverUrl: OpenCodeAgentInstanceFields.serverUrl.default(null),
        environment: z
          .array(StoredEnvironmentSchema)
          .max(AGENT_ENVIRONMENT_LIMIT)
          .default([])
          .refine((values) => new Set(values.map(({ name }) => name)).size === values.length),
      })
      .strict(),
  )
  .max(32)
  .refine((instances) => new Set(instances.map(({ id }) => id)).size === instances.length);
type StoredInstances = z.infer<typeof StoredInstancesSchema>;
type Storage = Omit<AgentEnvironmentStorage, "backend">;
export function readStoredOpenCodeInstances(value: unknown): StoredInstances {
  const result = StoredInstancesSchema.safeParse(value ?? [defaultOpenCodeInstance()]);
  if (!result.success) throw new Error("Invalid saved OpenCode settings.");
  return result.data;
}
export const presentOpenCodeInstances = (instances: StoredInstances): OpenCodeAgentSettings => ({
  instances: instances.map((instance) => ({
    ...instance,
    environment: presentAgentEnvironment(instance.environment),
  })),
});
export function writeOpenCodeInstances(
  source: Storage,
  input: UpdateOpenCodeAgentSettingsInput,
  previous: StoredInstances,
  publish: (next: StoredInstances) => void,
): void {
  const result = OpenCodeAgentSettingsUpdateSchema.safeParse(input);
  if (!result.success) throw new Error("Invalid OpenCode settings.");
  const normalized = result.data.instances.map((instance) => {
    const directory = instance.profileDirectory;
    if (directory?.startsWith("~/") && !source.hostHomeDirectory)
      throw new Error(
        "The host home directory is unavailable. Use an absolute OpenCode profile path.",
      );
    const profileDirectory = directory?.startsWith("~/")
      ? path.resolve(source.hostHomeDirectory!, directory.slice(2))
      : directory;
    if (profileDirectory && !path.isAbsolute(profileDirectory))
      throw new Error("OpenCode profile directory must be absolute or start with ~/.");
    return { ...instance, profileDirectory };
  });
  writeAgentEnvironments({ ...source, backend: "opencode" }, normalized, previous, publish);
}
/** Resolve credentials and the isolated profile only inside Main. */
export function resolveOpenCodeLaunchConfiguration(
  source: Storage,
  instances: StoredInstances,
  id: string,
) {
  const stored = instances.find((instance) => instance.id === id);
  if (!stored?.enabled) throw new Error("OpenCode instance is unavailable or disabled.");
  return {
    instance: presentOpenCodeInstances([stored]).instances[0]!,
    profileDirectory:
      stored.profileDirectory ??
      path.join(path.dirname(source.settingsPath), "agents", "opencode", id),
    environment: resolveAgentEnvironment({ ...source, backend: "opencode" }, stored),
  };
}
