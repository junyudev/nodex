import { z } from "zod";
import {
  AntigravityAgentInstanceFields,
  AntigravityAgentSettingsUpdateSchema,
  type AntigravityAgentSettings,
  type UpdateAntigravityAgentSettingsInput,
} from "../../shared/antigravity-agent-settings";
import {
  resolveAgentEnvironment,
  writeAgentEnvironments,
  type AgentEnvironmentStorage,
  type StoredAgentEnvironment,
} from "./agent-environment-storage";

const StoredInstancesSchema = z
  .array(
    z
      .object({
        ...AntigravityAgentInstanceFields,
        apiKeyRef: z.uuid().nullable().default(null),
      })
      .strict(),
  )
  .max(32)
  .refine((instances) => new Set(instances.map(({ id }) => id)).size === instances.length);
type StoredInstances = z.infer<typeof StoredInstancesSchema>;
type Storage = Omit<AgentEnvironmentStorage, "backend">;
const environmentInstances = (instances: StoredInstances) =>
  instances.map(({ apiKeyRef, ...instance }) => ({
    ...instance,
    environment: apiKeyRef
      ? [{ name: "apiKey", sensitive: true as const, secretRef: apiKeyRef }]
      : [],
  }));
export function readStoredAntigravityInstances(value: unknown): StoredInstances {
  const result = StoredInstancesSchema.safeParse(value ?? []);
  if (!result.success) throw new Error("Invalid saved Antigravity settings.");
  return result.data;
}
export const presentAntigravityInstances = (
  instances: StoredInstances,
): AntigravityAgentSettings => ({
  instances: instances.map(({ apiKeyRef, ...instance }) => ({
    ...instance,
    apiKey: null,
    hasApiKey: apiKeyRef !== null,
  })),
});
/** Reuse the Profile's encrypted, instance-bound secret transaction without exposing an environment editor. */
export function writeAntigravityInstances(
  source: Storage,
  input: UpdateAntigravityAgentSettingsInput,
  previous: StoredInstances,
  publish: (next: StoredInstances) => void,
): void {
  const result = AntigravityAgentSettingsUpdateSchema.safeParse(input);
  if (!result.success) throw new Error("Invalid Antigravity settings.");
  const instances = result.data.instances.map(({ apiKey, ...instance }) => ({
    ...instance,
    environment:
      apiKey === "" ||
      (apiKey === null && !previous.find(({ id }) => id === instance.id)?.apiKeyRef)
        ? []
        : [{ name: "apiKey", sensitive: true as const, value: apiKey }],
  }));
  writeAgentEnvironments(
    { ...source, backend: "antigravity" },
    instances,
    environmentInstances(previous),
    (next) => {
      publish(
        next.map(({ environment, ...instance }) => ({
          ...instance,
          apiKeyRef: secretReference(environment),
        })),
      );
    },
  );
}
const secretReference = (environment: readonly StoredAgentEnvironment[]) => {
  const key = environment[0];
  return key?.sensitive ? key.secretRef : null;
};
/** Private Main-only launch credentials. Never return this through settings IPC. */
export function resolveAntigravityLaunchConfiguration(
  source: Storage,
  instances: StoredInstances,
  id: string,
) {
  const stored = instances.find((instance) => instance.id === id);
  if (!stored?.enabled) throw new Error("Antigravity instance is unavailable or disabled.");
  const credentials = resolveAgentEnvironment(
    { ...source, backend: "antigravity" },
    environmentInstances([stored])[0]!,
  );
  return {
    instance: presentAntigravityInstances([stored]).instances[0]!,
    apiKey: credentials.apiKey ?? "",
  };
}
