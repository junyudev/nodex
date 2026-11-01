import { join, resolve } from "node:path";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import { z } from "zod";

const claudeHome = z.object({ homePath: z.string().optional() });
interface NativeImportSource {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly homePath: string | null;
}

/** Resolves native import locations from the exact physical provider configuration. */
export function nativeImportSources(input: {
  readonly configuration: AgentRuntimeConfiguration;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly codexHome: string;
}): readonly NativeImportSource[] {
  const home = input.environment.HOME ?? input.homeDirectory;
  const directory = (value: string) =>
    resolve(value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
  return Object.entries(input.configuration.providers).map(([providerInstanceId, provider]) => {
    // Managed providers do not expose user-account conversations for import.
    if (provider.source === "nodex")
      return { providerInstanceId, driver: provider.driver, homePath: null };
    if (provider.driver === "codex")
      return { providerInstanceId, driver: provider.driver, homePath: input.codexHome };
    if (provider.driver !== "claudeAgent")
      return { providerInstanceId, driver: provider.driver, homePath: null };
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
