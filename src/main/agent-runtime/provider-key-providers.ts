import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import { codexAgent } from "../../shared/agents/codex";
import { claudeAgent } from "../../shared/agents/claude";
import {
  providerKeyBaseUrl,
  providerKeyClaudeModelEnvironment,
  providerKeyRuntimeInstanceId,
  providerKeyTarget,
  type ProviderKeyConnection,
} from "../../shared/provider-keys";
import { isolatedProviderEnvironment } from "./isolated-provider-environment";
import { managedCodexProvider, type ManagedCodexComponent } from "./managed-codex-provider";
import { providerKeyCodexCatalog } from "./provider-key-codex-catalog";

export function providerKeyComponentDemand(
  connections: readonly Pick<ProviderKeyConnection, "agent" | "enabled">[],
) {
  const agents = new Set(connections.filter(({ enabled }) => enabled).map(({ agent }) => agent));
  return { codex: agents.has(codexAgent.driver), claudeCode: agents.has(claudeAgent.driver) };
}

const codexKeyVariable = "CODEX_PROVIDER_API_KEY";

export function providerKeyProviders(
  input: ManagedCodexComponent & {
    readonly home: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly codexEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly connections: readonly ProviderKeyConnection[];
    readonly keys: ReadonlyMap<string, Redacted.Redacted>;
  },
) {
  const catalogs: { readonly path: string; readonly contents: string }[] = [];
  const entries = input.connections.map((connection) => {
    const { id, displayName, models } = connection;
    const key = connection.enabled ? input.keys.get(id) : undefined;
    const instanceId = providerKeyRuntimeInstanceId(connection);
    const root = join(input.home, "account", "keys", id);
    const baseUrl = providerKeyBaseUrl(providerKeyTarget(connection));
    const customModels = models.map(({ id, name }) => ({ slug: id, name }));
    if (connection.agent === codexAgent.driver) {
      const homePath = join(root, codexAgent.driver);
      const catalog = providerKeyCodexCatalog(homePath, connection.preset, models);
      if (catalog && key) catalogs.push(catalog);
      return [
        instanceId,
        managedCodexProvider({
          codexBinary: input.codexBinary,
          codexUnavailable: input.codexUnavailable,
          environment: input.codexEnvironment ?? input.environment,
          homePath,
          displayName,
          models: customModels,
          key: catalog ? key : undefined,
          keyVariable: codexKeyVariable,
          providerId: "key_connection",
          providerName: displayName,
          baseUrl,
          overrides: catalog
            ? [
                `model_catalog_json=${JSON.stringify(catalog.path)}`,
                `model=${JSON.stringify(catalog.model)}`,
                `review_model=${JSON.stringify(catalog.quickModel)}`,
                // These Guardian classifiers hardcode OpenAI model IDs.
                "features.guardianv2=false",
                "features.guardianv2_decisions_comparison=false",
                "features.guardianv3=false",
                "features.memories=false",
                "features.apps=false",
                'web_search="disabled"',
                "features.standalone_web_search=false",
                "analytics.enabled=false",
                "feedback.enabled=false",
                `shell_environment_policy.exclude=[${JSON.stringify(codexKeyVariable)}]`,
              ]
            : [],
        }),
      ] as const;
    }
    const homePath = join(root, "claude");
    return [
      instanceId,
      {
        driver: claudeAgent.driver,
        displayName,
        enabled: key !== undefined,
        modelAllowlist: models.map((model) => model.id),
        config: {
          isolated: true,
          binaryPath: "",
          homePath,
          customModels,
        },
        environment: key
          ? isolatedProviderEnvironment(
              input.environment,
              {
                CLAUDE_CONFIG_DIR: homePath,
                ANTHROPIC_BASE_URL: baseUrl,
                ANTHROPIC_AUTH_TOKEN: Redacted.value(key),
                ...providerKeyClaudeModelEnvironment(models),
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              },
              ["ANTHROPIC_AUTH_TOKEN"],
            )
          : [],
      },
    ] as const;
  });
  const providers = Object.fromEntries<(typeof entries)[number][1]>(entries);
  return { providers, catalogs };
}
