import path from "node:path";
import { z } from "zod";
import {
  AGENT_ENVIRONMENT_LIMIT,
  AgentEnvironmentValueSchema,
} from "../../shared/agent-environment";
import {
  ACP_AGENT_INSTANCE_LIMIT,
  AcpAgentInstanceFields,
  AcpAgentSettingsUpdateSchema,
  acpEnvironmentNameError,
  isAcpProfileEnvironmentName,
  type AcpAgentSettings,
  type UpdateAcpAgentSettingsInput,
} from "../../shared/acp-agent-settings";
import { CLAUDE_ACP_AGENT_DEFINITION } from "../../shared/acp-agent-definitions";
import {
  presentAgentEnvironment,
  resolveAgentEnvironment,
  writeAgentEnvironments,
  type AgentEnvironmentStorage,
} from "./agent-environment-storage";

const name = z.string().superRefine((value, context) => {
  const message = acpEnvironmentNameError(value);
  if (message) context.addIssue({ code: "custom", message });
});
const storedEnvironment = z.discriminatedUnion("sensitive", [
  z.object({ name, sensitive: z.literal(false), value: AgentEnvironmentValueSchema }).strict(),
  z.object({ name, sensitive: z.literal(true), secretRef: z.uuid() }).strict(),
]);
const storedInstance = z
  .object({
    ...AcpAgentInstanceFields,
    environment: z
      .array(storedEnvironment)
      .max(AGENT_ENVIRONMENT_LIMIT)
      .refine(
        (values) => new Set(values.map(({ name }) => name.toUpperCase())).size === values.length,
      ),
  })
  .strict();
const legacyInstance = z
  .object({
    id: AcpAgentInstanceFields.id,
    agentDefinitionId: AcpAgentInstanceFields.agentDefinitionId,
    packageRoot: z.string().refine(path.isAbsolute),
    nodeExecutable: z.string().refine(path.isAbsolute),
    enabled: z.boolean(),
    credentials: AcpAgentInstanceFields.credentials,
    proxy: AcpAgentInstanceFields.proxy,
  })
  .strict()
  .transform(({ packageRoot, nodeExecutable, ...instance }) => ({
    ...instance,
    displayName:
      instance.agentDefinitionId === CLAUDE_ACP_AGENT_DEFINITION.id
        ? CLAUDE_ACP_AGENT_DEFINITION.title
        : instance.agentDefinitionId,
    source: {
      kind: "local" as const,
      executable: nodeExecutable,
      args: [path.join(packageRoot, CLAUDE_ACP_AGENT_DEFINITION.entryRelativePath)],
    },
    environment: [],
    customModels: [],
  }));
const storedInstances = z
  .array(z.union([storedInstance, legacyInstance]))
  .max(ACP_AGENT_INSTANCE_LIMIT)
  .refine((instances) => new Set(instances.map(({ id }) => id)).size === instances.length);
export type StoredAcpInstances = z.infer<typeof storedInstances>;
type Storage = Omit<AgentEnvironmentStorage, "backend">;
export function readStoredAcpInstances(value: unknown): StoredAcpInstances {
  const result = storedInstances.safeParse(value ?? []);
  if (!result.success) throw new Error("Invalid saved ACP Agent settings.");
  return result.data;
}
export const presentAcpInstances = (instances: StoredAcpInstances): AcpAgentSettings => ({
  instances: instances.map((instance) => ({
    ...instance,
    environment: presentAgentEnvironment(instance.environment),
  })),
});
export function writeAcpInstances(
  source: Storage,
  input: UpdateAcpAgentSettingsInput,
  previous: StoredAcpInstances,
  publish: (next: StoredAcpInstances) => void,
): void {
  const result = AcpAgentSettingsUpdateSchema.safeParse(input);
  if (!result.success) throw new Error("Invalid ACP Agent settings.");
  for (const instance of result.data.instances) {
    const old = previous.find(({ id }) => id === instance.id);
    if (old && old.agentDefinitionId !== instance.agentDefinitionId)
      throw new Error("An existing Agent instance cannot change its identity. Add a new instance.");
    if (
      old?.source.kind === "registry" &&
      instance.source.kind === "registry" &&
      old.source.agentId !== instance.source.agentId
    )
      throw new Error(
        "An existing Agent instance cannot change its registry Agent. Add a new instance.",
      );
  }
  for (const instance of result.data.instances) {
    const old = previous.find(({ id }) => id === instance.id);
    if (!old) continue;
    const roots = (entry: {
      credentials: unknown;
      environment: readonly { name: string; sensitive: boolean; value?: string | null }[];
    }) =>
      JSON.stringify({
        credentials: entry.credentials,
        directories: entry.environment
          .filter(({ name, sensitive }) => !sensitive && isAcpProfileEnvironmentName(name))
          .map(({ name, value }) => [name, value])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      });
    if (roots(old) !== roots(instance))
      throw new Error(
        "An existing Agent instance cannot change its profile location. Add a new instance.",
      );
  }
  writeAgentEnvironments({ ...source, backend: "acp" }, result.data.instances, previous, publish);
}
/** Secrets are resolved only inside Main, immediately before configuring the Runtime. */
export function resolveAcpLaunchConfiguration(
  source: Storage,
  instances: StoredAcpInstances,
  id: string,
) {
  const stored = instances.find((instance) => instance.id === id);
  if (!stored?.enabled) throw new Error("ACP Agent instance is unavailable or disabled.");
  return {
    instance: presentAcpInstances([stored]).instances[0]!,
    environment: resolveAgentEnvironment({ ...source, backend: "acp" }, stored),
  };
}
