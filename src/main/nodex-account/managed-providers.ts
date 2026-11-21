import { isolatedProviderEnvironment } from "../agent-runtime/isolated-provider-environment";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import type {
  AgentRuntimeOperations,
  AgentRuntimeConfiguration,
} from "@nodex/agent-runtime/contracts";
import type { NodexAccountIdentity } from "../../shared/nodex-account";
import { NODEX_MODELS, isNodexProviderId } from "../../shared/nodex-models";
import type { NodexModelAccess } from "../platform/NodexModelAccessPlatform";
import { shellQuote } from "../platform/node/NodexCliShell";

export const managedNodexAccountId = (identity: NodexAccountIdentity) =>
  createHash("sha256")
    .update(JSON.stringify([identity.issuer, identity.subject]))
    .digest("hex")
    .slice(0, 32);

/** A late live or cached catalog cannot reintroduce retired account instances. */
export function projectManagedNodexCatalog(
  providers: AgentRuntimeOperations["providers.read"]["output"],
  managed: { readonly identity: NodexAccountIdentity; readonly access: NodexModelAccess } | null,
) {
  const account = managed ? managedNodexAccountId(managed.identity) : null;
  return providers.filter(
    (provider) =>
      (provider.source !== "nodex" && !isNodexProviderId(provider.instanceId)) ||
      (account !== null &&
        (provider.instanceId === `nodex_codex_${account}` ||
          provider.instanceId === `nodex_claude_${account}`)),
  );
}

export function managedNodexProviders(input: {
  readonly home: string;
  readonly codexBinary?: string;
  readonly codexUnavailable?: AgentRuntimeConfiguration["providers"][string]["componentUnavailable"];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly managed: {
    readonly identity: NodexAccountIdentity;
    readonly access: NodexModelAccess;
  } | null;
}): AgentRuntimeConfiguration["providers"] {
  if (!input.managed) return {};
  const { identity, access } = input.managed;
  const account = managedNodexAccountId(identity);
  const root = join(input.home, "account", "models", account);
  const environment = (values: Record<string, string>) =>
    isolatedProviderEnvironment(input.environment, values, [
      "NODEX_GATEWAY_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  const models = NODEX_MODELS.filter((model) =>
    access.models.some((allowed) => allowed.id === model.id && allowed.protocol === model.protocol),
  );
  const codexModels = models.filter((model) => model.protocol === "openai");
  const claudeModels = models.filter((model) => model.protocol === "anthropic");
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  const overrides = [
    'model_provider="nodex"',
    `model_providers.nodex={name="Nodex",base_url=${JSON.stringify(access.openaiBaseUrl)},wire_api="responses",env_key="NODEX_GATEWAY_API_KEY",requires_openai_auth=false}`,
    'cli_auth_credentials_store="ephemeral"',
    `sqlite_home=${JSON.stringify(codexHome)}`,
  ];
  return {
    ...(codexModels.length
      ? {
          [`nodex_codex_${account}`]: {
            driver: "codex",
            source: "nodex",
            displayName: "Nodex",
            enabled: true,
            ...(input.codexUnavailable ? { componentUnavailable: input.codexUnavailable } : {}),
            modelAllowlist: codexModels.map((model) => model.id),
            environment: environment({
              CODEX_HOME: codexHome,
              CODEX_SQLITE_HOME: codexHome,
              NODEX_GATEWAY_API_KEY: Redacted.value(access.apiKey),
            }),
            config: {
              setupMode: "existing",
              isolated: true,
              ...(input.codexBinary ? { binaryPath: input.codexBinary } : {}),
              homePath: codexHome,
              launchArgs: overrides.flatMap((value) => ["-c", shellQuote(value)]).join(" "),
              customModels: codexModels.map((model) => ({ slug: model.id, name: model.label })),
            },
          },
        }
      : {}),
    ...(claudeModels.length
      ? {
          [`nodex_claude_${account}`]: {
            driver: "claudeAgent",
            source: "nodex",
            displayName: "Nodex",
            enabled: true,
            modelAllowlist: claudeModels.map((model) => model.id),
            environment: environment({
              CLAUDE_CONFIG_DIR: claudeHome,
              ANTHROPIC_BASE_URL: access.anthropicBaseUrl,
              ANTHROPIC_AUTH_TOKEN: Redacted.value(access.apiKey),
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            }),
            config: {
              isolated: true,
              binaryPath: "",
              homePath: claudeHome,
              customModels: claudeModels.map((model) => ({ slug: model.id, name: model.label })),
            },
          },
        }
      : {}),
  };
}
