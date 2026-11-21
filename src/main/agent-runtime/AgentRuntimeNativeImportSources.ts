import { agentDefinition } from "../../shared/agents/registry";
import { dirname, join, resolve } from "node:path";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import type { InsightsUsageSource } from "../../shared/insights";
import { z } from "zod";
import type { NativeSessionSource } from "../../shared/native-session-catalog";
import { antigravityAgent } from "../../shared/agents/antigravity";
import { CODEX_BINDING } from "../../shared/agents/codex";
import { antigravityHistoryHome } from "../agent-backend/antigravity/AntigravityHistoryHome";

/** The Runtime instance whose history holds a native conversation; Codex has one shared home. */
export const nativeImportProviderId = (source: NativeSessionSource): string =>
  source.instanceConfigId ?? CODEX_BINDING.instanceId;

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
  readonly platform: string;
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
    const history = agentDefinition(provider.driver).capabilities.nativeHistory;
    if (history === "codex")
      return { providerInstanceId, driver: provider.driver, homePath: input.codexHome };
    // Every Antigravity profile reads the person's own history, wherever its sign-in lives.
    if (history === antigravityAgent.capabilities.nativeHistory)
      return {
        providerInstanceId,
        driver: provider.driver,
        homePath: antigravityHistoryHome({
          platform: input.platform,
          environment: input.environment,
          homeDirectory: input.homeDirectory,
        }),
      };
    if (history !== "claude")
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
    const ledger = agentDefinition(provider.driver).capabilities.insightsLedger;
    if (ledger === "claude") {
      const value = configured || variables.CLAUDE_CONFIG_DIR;
      if (value) add({ provider: "claude", home: directory(value), origin });
    } else if (ledger === "codex") {
      const value = configured || variables.CODEX_HOME;
      if (value) add({ provider: "codex", home: directory(value), origin });
    }
  }
  return [...sources.values()];
}
