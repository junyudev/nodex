import * as Redacted from "effect/Redacted";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import { codexAgent } from "../../shared/agents/codex";
import { shellQuote } from "../platform/node/NodexCliShell";
import { declaredProviderEnvironment } from "./provider-environment";

export type ManagedCodexComponent = {
  readonly codexBinary?: string;
  readonly codexUnavailable?: AgentRuntimeConfiguration["providers"][string]["componentUnavailable"];
  /** The search path the managed Codex needs when execution's own lacks its package tools. */
  readonly codexSearchPath?: string;
};

export function managedCodexProvider(
  input: ManagedCodexComponent & {
    readonly homePath: string;
    readonly displayName: string;
    readonly models: readonly { readonly slug: string; readonly name: string }[];
    readonly key: Redacted.Redacted | undefined;
    readonly keyVariable: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly baseUrl: string;
    readonly overrides?: readonly string[];
  },
) {
  const { homePath, key, keyVariable, providerId } = input;
  const overrides = [
    `model_provider=${JSON.stringify(providerId)}`,
    `model_providers.${providerId}={name=${JSON.stringify(input.providerName)},base_url=${JSON.stringify(input.baseUrl)},wire_api="responses",env_key=${JSON.stringify(keyVariable)},requires_openai_auth=false,supports_websockets=false}`,
    'cli_auth_credentials_store="ephemeral"',
    `sqlite_home=${JSON.stringify(homePath)}`,
    ...(input.overrides ?? []),
  ];
  return {
    driver: codexAgent.driver,
    displayName: input.displayName,
    enabled: key !== undefined,
    ...(input.codexUnavailable ? { componentUnavailable: input.codexUnavailable } : {}),
    modelAllowlist: input.models.map(({ slug }) => slug),
    environment: key
      ? declaredProviderEnvironment(
          {
            CODEX_HOME: homePath,
            CODEX_SQLITE_HOME: homePath,
            [keyVariable]: Redacted.value(key),
            ...(input.codexSearchPath ? { PATH: input.codexSearchPath } : {}),
          },
          [keyVariable],
        )
      : [],
    config: {
      setupMode: "existing" as const,
      isolated: true,
      ...(input.codexBinary ? { binaryPath: input.codexBinary } : {}),
      homePath,
      // Values use TOML basic strings. Escape apostrophes before the runtime's argv tokenizer.
      launchArgs: overrides
        .flatMap((value) => ["-c", shellQuote(value.replaceAll("'", "\\u0027"))])
        .join(" "),
      customModels: input.models,
    },
  };
}
