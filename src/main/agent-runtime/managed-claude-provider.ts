import * as Redacted from "effect/Redacted";
import { claudeAgent } from "../../shared/agents/claude";
import { declaredProviderEnvironment } from "./provider-environment";

/**
 * Claude Code that Nodex runs on an endpoint it chose, in the instance's own configuration home:
 * it reads none of the person's Claude settings and only the credential declared here.
 */
export function managedClaudeProvider(input: {
  readonly homePath: string;
  readonly displayName: string;
  readonly models: readonly { readonly slug: string; readonly name: string }[];
  readonly key: Redacted.Redacted | undefined;
  readonly baseUrl: string;
  /** Further settings, such as which models Claude Code's own model names resolve to. */
  readonly settings?: Readonly<Record<string, string>>;
}) {
  const { homePath, key } = input;
  return {
    driver: claudeAgent.driver,
    displayName: input.displayName,
    enabled: key !== undefined,
    modelAllowlist: input.models.map(({ slug }) => slug),
    environment: key
      ? declaredProviderEnvironment(
          {
            CLAUDE_CONFIG_DIR: homePath,
            ANTHROPIC_BASE_URL: input.baseUrl,
            ANTHROPIC_AUTH_TOKEN: Redacted.value(key),
            ...input.settings,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          },
          ["ANTHROPIC_AUTH_TOKEN"],
        )
      : [],
    config: {
      isolated: true,
      binaryPath: "",
      homePath,
      customModels: input.models,
    },
  };
}
