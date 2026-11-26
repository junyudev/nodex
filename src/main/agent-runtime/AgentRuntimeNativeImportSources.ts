import { agentDefinition } from "../../shared/agents/registry";
import { posix, win32 } from "node:path";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import type { InsightsUsageSource } from "../../shared/insights";
import { z } from "zod";
import type { NativeSessionSource } from "../../shared/native-session-catalog";
import { antigravityAgent } from "../../shared/agents/antigravity";
import { CODEX_BINDING } from "../../shared/agents/codex";
import { antigravityHistoryHome } from "../agent-backend/antigravity/AntigravityHistoryHome";
import { hostEnvironmentValue } from "../platform/node/HostExecutableSearch";

/** The Runtime instance whose history holds a native conversation; Codex has one shared home. */
export const nativeImportProviderId = (source: NativeSessionSource): string =>
  source.instanceConfigId ?? CODEX_BINDING.instanceId;

const claudeHome = z.object({ homePath: z.string().optional() });
interface NativeImportSource {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly homePath: string | null;
}

interface NativeHistoryHost {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homeDirectory: string;
}

function nativeHistoryPaths({ environment, platform, homeDirectory }: NativeHistoryHost) {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  // Match Claude's native account home. A shell may supply a different HOME on Windows.
  const home =
    hostEnvironmentValue(environment, windows ? "USERPROFILE" : "HOME", platform) || homeDirectory;
  const configuredDirectory = (value: string) =>
    path.resolve(
      value === "~"
        ? home
        : value.startsWith("~/") || (windows && value.startsWith("~\\"))
          ? path.join(home, value.slice(2))
          : value,
    );
  // A provider's variables are typed into Nodex, where no shell expands `~`.
  const claudeEnvironmentDirectory = (scope: NativeHistoryHost["environment"]) => {
    const value = hostEnvironmentValue(scope, "CLAUDE_CONFIG_DIR", platform)?.trim();
    return value ? configuredDirectory(value) : undefined;
  };
  return {
    path,
    configuredDirectory,
    instanceClaudeDirectory: (configured: string, variables: NativeHistoryHost["environment"]) =>
      configured ? configuredDirectory(configured) : claudeEnvironmentDirectory(variables),
    defaultClaudeDirectory:
      claudeEnvironmentDirectory(environment) ?? path.resolve(path.join(home, ".claude")),
  };
}

/** The Claude Code history home when the launcher supplies no per-profile override. */
export const defaultClaudeNativeHistoryHome = (host: NativeHistoryHost): string =>
  nativeHistoryPaths(host).defaultClaudeDirectory;

/** Resolves native import locations from the exact physical provider configuration. */
export function nativeImportSources(
  input: NativeHistoryHost & {
    readonly configuration: AgentRuntimeConfiguration;
    readonly codexHome: string;
  },
): readonly NativeImportSource[] {
  const paths = nativeHistoryPaths(input);
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
        homePath: antigravityHistoryHome(input),
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
      homePath:
        paths.instanceClaudeDirectory(configured, variables) ?? paths.defaultClaudeDirectory,
    };
  });
}

/**
 * Every home whose transcripts count toward Insights. A person's own Agent homes are always read,
 * even without a configured provider, since that history predates Nodex. Homes only Nodex writes
 * to, managed accounts and the Profile's own Agent home, hold nothing but Nodex's work.
 */
export function insightsUsageSources(
  input: NativeHistoryHost & {
    readonly configuration: AgentRuntimeConfiguration;
    readonly codexHome: string;
  },
): readonly InsightsUsageSource[] {
  const paths = nativeHistoryPaths(input);
  const sources = new Map<string, InsightsUsageSource>();
  const add = (source: InsightsUsageSource) => {
    const key = `${source.provider}\u0000${source.home}`;
    if (source.origin === "nodex" || !sources.has(key)) sources.set(key, source);
  };
  add({
    provider: "claude",
    home: paths.defaultClaudeDirectory,
    origin: "external",
  });
  add({ provider: "codex", home: input.codexHome, origin: "external" });
  add({
    provider: "codex",
    home: paths.path.join(paths.path.dirname(input.configuration.home), "agent"),
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
      const home = paths.instanceClaudeDirectory(configured, variables);
      if (home) add({ provider: "claude", home, origin });
    } else if (ledger === "codex") {
      const value = configured || variables.CODEX_HOME;
      if (value) add({ provider: "codex", home: paths.configuredDirectory(value), origin });
    }
  }
  return [...sources.values()];
}
