import { join, resolve } from "node:path";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeNativeHistorySource } from "./AgentRuntimeProfileSnapshot";
import { z } from "zod";

const claudeHome = z.object({ homePath: z.string().optional() });
const restoredHome = z.object({
  restoredHistoryPath: z.string().optional(),
  homePath: z.string().optional(),
  hostAuthentication: z.boolean().optional(),
});

/** Captures only native history locations from the exact physical provider configuration. */
export function nativeHistorySources(input: {
  readonly configuration: AgentRuntimeConfiguration;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly codexHome: string;
}): readonly AgentRuntimeNativeHistorySource[] {
  const home = input.environment.HOME ?? input.homeDirectory;
  const directory = (value: string) =>
    resolve(value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
  return Object.entries(input.configuration.providers).map(([providerInstanceId, provider]) => {
    const restored = restoredHome.safeParse(provider.config);
    const retained = restored.success ? restored.data : undefined;
    if (provider.driver === "codex" && retained?.hostAuthentication && retained.homePath)
      return {
        providerInstanceId,
        driver: provider.driver,
        homePath: directory(retained.homePath),
      };
    if (provider.driver === "codex")
      return { providerInstanceId, driver: provider.driver, homePath: input.codexHome };
    if (provider.driver !== "claudeAgent")
      return { providerInstanceId, driver: provider.driver, homePath: null };
    if (retained?.restoredHistoryPath)
      return {
        providerInstanceId,
        driver: provider.driver,
        homePath: directory(retained.restoredHistoryPath),
      };
    const variables = Object.fromEntries(
      provider.environment?.map(({ name, value }) => [name, value]) ?? [],
    );
    const settings = claudeHome.safeParse(provider.config);
    if (!settings.success) throw new Error("Claude native history location is unavailable");
    const configured = settings.data.homePath?.trim() ?? "";
    return {
      providerInstanceId,
      driver: provider.driver,
      homePath: directory(
        configured ||
          variables.CLAUDE_CONFIG_DIR ||
          input.environment.CLAUDE_CONFIG_DIR ||
          join(home, ".claude"),
      ),
    };
  });
}
