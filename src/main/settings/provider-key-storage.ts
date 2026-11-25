import { isProviderInstanceId } from "@nodex/agent-runtime/contracts";
import { z } from "zod";
import { claudeAgent } from "../../shared/agents/claude";
import {
  PROVIDER_KEY_LIMIT,
  PROVIDER_KEY_MODEL_LIMIT,
  ProviderKeyModelSchema,
  ProviderKeyTargetSchema,
  providerKeyRuntimeInstanceId,
  providerKeyTarget,
  type ProviderKeyConnection,
} from "../../shared/provider-keys";
import {
  resolveAgentEnvironment,
  writeAgentEnvironments,
  type AgentEnvironmentStorage,
} from "./agent-environment-storage";

/** Connections saved before the Agent choice existed ran on Claude Code, and keep its history. */
const StoredTargetSchema = z.preprocess(
  (value) =>
    value !== null && typeof value === "object" && !("agent" in value)
      ? { ...value, agent: claudeAgent.driver }
      : value,
  ProviderKeyTargetSchema,
);

const StoredConnectionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/u),
    target: StoredTargetSchema,
    displayName: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
    models: z.array(ProviderKeyModelSchema).min(1).max(PROVIDER_KEY_MODEL_LIMIT),
    keyHint: z.string().max(4),
    secretRef: z.uuid(),
  })
  .strict()
  .refine(({ id, target }) =>
    isProviderInstanceId(providerKeyRuntimeInstanceId({ id, preset: target.preset })),
  );

type StoredConnection = z.infer<typeof StoredConnectionSchema>;
type Source = Omit<AgentEnvironmentStorage, "backend">;
const keyName = "ANTHROPIC_AUTH_TOKEN";

export function readStoredProviderKeys(value: unknown): StoredConnection[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, PROVIDER_KEY_LIMIT).flatMap((entry) => {
    const parsed = StoredConnectionSchema.safeParse(entry);
    if (!parsed.success || ids.has(parsed.data.id)) return [];
    ids.add(parsed.data.id);
    return [parsed.data];
  });
}

export function presentProviderKeys(stored: readonly StoredConnection[]) {
  return {
    connections: stored.map(
      ({ target, id, displayName, enabled, models, keyHint }): ProviderKeyConnection => ({
        id,
        preset: target.preset,
        agent: target.agent,
        displayName,
        enabled,
        models,
        keyHint,
        endpoint: target.preset === "custom" ? null : target.endpoint,
        baseUrl: target.preset === "custom" ? target.baseUrl : null,
      }),
    ),
  };
}

const asEnvironment = ({ id, secretRef }: StoredConnection) => ({
  id,
  environment: [{ name: keyName, sensitive: true as const, secretRef }],
});

export function resolveProviderKeySecret(
  source: Source,
  stored: readonly StoredConnection[],
  id: string,
): string {
  const entry = stored.find((connection) => connection.id === id);
  if (!entry) throw new Error("This API key connection no longer exists.");
  return resolveAgentEnvironment({ ...source, backend: "provider-keys" }, asEnvironment(entry))[
    keyName
  ]!;
}

export function writeProviderKeys(
  source: Source,
  previous: readonly StoredConnection[],
  connections: readonly ProviderKeyConnection[],
  replacement: { readonly id: string; readonly value: string } | undefined,
  publish: (next: StoredConnection[]) => void,
): void {
  writeAgentEnvironments(
    { ...source, backend: "provider-keys" },
    connections.map(({ id }) => ({
      id,
      environment: [
        {
          name: keyName,
          sensitive: true as const,
          value: replacement?.id === id ? replacement.value : null,
        },
      ],
    })),
    previous.map(asEnvironment),
    (next) => {
      publish(
        connections.map((connection, index) => {
          const { id, displayName, enabled, models, keyHint } = connection;
          const key = next[index]!.environment[0]!;
          if (!key.sensitive) throw new Error("Expected encrypted API key storage.");
          return StoredConnectionSchema.parse({
            id,
            target: providerKeyTarget(connection),
            displayName,
            enabled,
            models,
            keyHint,
            secretRef: key.secretRef,
          });
        }),
      );
    },
  );
}
