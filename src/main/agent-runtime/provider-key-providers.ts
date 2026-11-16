import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import {
  providerKeyBaseUrl,
  providerKeyClaudeModelEnvironment,
  providerKeyRuntimeInstanceId,
  providerKeyTarget,
  type ProviderKeyConnection,
} from "../../shared/provider-keys";
import { isolatedProviderEnvironment } from "./isolated-provider-environment";

export function providerKeyProviders(input: {
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly connections: readonly ProviderKeyConnection[];
  readonly keys: ReadonlyMap<string, Redacted.Redacted>;
}) {
  return Object.fromEntries(
    input.connections.map((connection) => {
      const { id, displayName, models } = connection;
      const key = connection.enabled ? input.keys.get(id) : undefined;
      const homePath = join(input.home, "account", "keys", id, "claude");
      return [
        providerKeyRuntimeInstanceId(connection),
        {
          driver: "claudeAgent" as const,
          displayName,
          enabled: key !== undefined,
          modelAllowlist: models.map((model) => model.id),
          config: {
            isolated: true,
            binaryPath: "",
            homePath,
            customModels: models.map(({ id, name }) => ({ slug: id, name })),
          },
          environment: key
            ? isolatedProviderEnvironment(
                input.environment,
                {
                  CLAUDE_CONFIG_DIR: homePath,
                  ANTHROPIC_BASE_URL: providerKeyBaseUrl(providerKeyTarget(connection)),
                  ANTHROPIC_AUTH_TOKEN: Redacted.value(key),
                  ...providerKeyClaudeModelEnvironment(models),
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
                },
                ["ANTHROPIC_AUTH_TOKEN"],
              )
            : [],
        },
      ];
    }),
  );
}
