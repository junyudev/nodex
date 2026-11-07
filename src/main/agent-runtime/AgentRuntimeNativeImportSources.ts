import { dirname, join, resolve } from "node:path";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import type { InsightsUsageSource } from "../../shared/insights";
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

/**
 * Every home whose transcripts count toward Insights. A person's own Agent homes are always read,
 * even without a configured provider, since that history predates Nodex. Homes only Nodex writes
 * to, managed accounts and the Profile's own Agent home, hold nothing but Nodex's work.
 */
export function insightsUsageSources(input: {
  readonly configuration: AgentRuntimeConfiguration;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly codexHome: string;
}): readonly InsightsUsageSource[] {
  const home = input.environment.HOME ?? input.homeDirectory;
  const directory = (value: string) =>
    resolve(value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
  const sources = new Map<string, InsightsUsageSource>();
  const add = (source: InsightsUsageSource) => {
    const key = `${source.provider}\u0000${source.home}`;
    if (source.origin === "nodex" || !sources.has(key)) sources.set(key, source);
  };
  add({
    provider: "claude",
    home: directory(input.environment.CLAUDE_CONFIG_DIR || join(home, ".claude")),
    origin: "external",
  });
  add({ provider: "codex", home: input.codexHome, origin: "external" });
  add({
    provider: "codex",
    home: join(dirname(input.configuration.home), "agent"),
    origin: "nodex",
  });
  for (const provider of Object.values(input.configuration.providers)) {
    const variables = Object.fromEntries(
      provider.environment?.map(({ name, value }) => [name, value]) ?? [],
    );
    const configured = claudeHome.safeParse(provider.config).data?.homePath?.trim() ?? "";
    const origin = provider.source === "nodex" ? "nodex" : "external";
    if (provider.driver === "claudeAgent") {
      const value = configured || variables.CLAUDE_CONFIG_DIR;
      if (value) add({ provider: "claude", home: directory(value), origin });
    } else if (provider.driver === "codex") {
      const value = configured || variables.CODEX_HOME;
      if (value) add({ provider: "codex", home: directory(value), origin });
    }
  }
  return [...sources.values()];
}
