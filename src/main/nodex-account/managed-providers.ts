import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  AgentRuntimeOperations,
  AgentRuntimeConfiguration,
} from "@nodex/agent-runtime/contracts";
import type { NodexAccountIdentity } from "../../shared/nodex-account";
import { NODEX_MODELS, isNodexProviderId } from "../../shared/nodex-models";
import type { NodexModelAccess } from "../platform/NodexModelAccessPlatform";
import {
  managedCodexProvider,
  type ManagedCodexComponent,
} from "../agent-runtime/managed-codex-provider";
import { managedClaudeProvider } from "../agent-runtime/managed-claude-provider";

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

export function managedNodexProviders(
  input: ManagedCodexComponent & {
    readonly home: string;
    readonly managed: {
      readonly identity: NodexAccountIdentity;
      readonly access: NodexModelAccess;
    } | null;
  },
): AgentRuntimeConfiguration["providers"] {
  if (!input.managed) return {};
  const { identity, access } = input.managed;
  const account = managedNodexAccountId(identity);
  const root = join(input.home, "account", "models", account);
  const models = NODEX_MODELS.filter((model) =>
    access.models.some((allowed) => allowed.id === model.id && allowed.protocol === model.protocol),
  );
  const codexModels = models.filter((model) => model.protocol === "openai");
  const claudeModels = models.filter((model) => model.protocol === "anthropic");
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  return {
    ...(codexModels.length
      ? {
          [`nodex_codex_${account}`]: {
            ...managedCodexProvider({
              ...input,
              homePath: codexHome,
              displayName: "Nodex",
              models: codexModels.map(({ id, label }) => ({ slug: id, name: label })),
              key: access.apiKey,
              keyVariable: "NODEX_GATEWAY_API_KEY",
              providerId: "nodex",
              providerName: "Nodex",
              baseUrl: access.openaiBaseUrl,
            }),
            source: "nodex",
          },
        }
      : {}),
    ...(claudeModels.length
      ? {
          [`nodex_claude_${account}`]: {
            ...managedClaudeProvider({
              homePath: claudeHome,
              displayName: "Nodex",
              models: claudeModels.map((model) => ({ slug: model.id, name: model.label })),
              key: access.apiKey,
              baseUrl: access.anthropicBaseUrl,
            }),
            source: "nodex",
          },
        }
      : {}),
  };
}
