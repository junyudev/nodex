import type {
  EffectivePluginContributions,
  LocalPluginSource,
  PluginCleanupWarning,
  PluginWriterStatus,
} from "./installation-registry";
import type { AgentPluginMcpServer, AgentPluginPackage, AgentPluginReadResult } from "./types";

export type PluginMcpReview = {
  readonly key: string;
  readonly transport:
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: readonly string[];
        readonly cwd: string;
      }
    | {
        readonly type: "streamable-http" | "sse";
        readonly url: string;
      };
  readonly configuration: readonly string[];
};

export type PluginPackageReview = Pick<
  AgentPluginPackage,
  "identity" | "layout" | "skills" | "hooks" | "apps" | "digest" | "diagnostics"
> & {
  readonly displayName?: string;
  readonly mcpServers: readonly PluginMcpReview[];
};

export type PluginPreview =
  | { readonly status: "loaded"; readonly package: PluginPackageReview }
  | Extract<AgentPluginReadResult, { status: "rejected" }>;

export interface InstalledAgentPlugin {
  readonly id: string;
  readonly source: LocalPluginSource;
  readonly package: PluginPackageReview;
  readonly projectEnabled: boolean;
  readonly effective:
    | (Omit<EffectivePluginContributions, "mcpServers"> & {
        readonly mcpServers: readonly PluginMcpReview[];
      })
    | null;
}

export interface AgentPluginList {
  readonly installations: readonly InstalledAgentPlugin[];
  readonly writerStatus: PluginWriterStatus;
}

export type AgentPluginFailure = {
  readonly code: string;
  readonly message: string;
  readonly reasons?: Extract<PluginPreview, { status: "rejected" }>["reasons"];
};

export type AgentPluginResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentPluginFailure };

interface MutationReceipt {
  readonly cleanupWarnings: readonly PluginCleanupWarning[];
}

export interface AgentPluginIpcApi {
  "agent-plugins:list": {
    args: [input: { projectId: string | null }];
    result: AgentPluginResult<AgentPluginList>;
  };
  "agent-plugins:pick-folder": { args: []; result: AgentPluginResult<string | null> };
  "agent-plugins:preview": {
    args: [input: { directory: string }];
    result: AgentPluginResult<PluginPreview>;
  };
  "agent-plugins:install": {
    args: [input: { directory: string; previewDigest: string }];
    result: AgentPluginResult<MutationReceipt>;
  };
  "agent-plugins:set-project-enabled": {
    args: [input: { id: string; projectId: string; enabled: boolean }];
    result: AgentPluginResult<void>;
  };
  "agent-plugins:reload": {
    args: [input: { id: string }];
    result: AgentPluginResult<MutationReceipt>;
  };
  "agent-plugins:uninstall": {
    args: [input: { id: string; data: "keep" | "delete" }];
    result: AgentPluginResult<MutationReceipt>;
  };
  "agent-plugins:repair-writer": { args: []; result: AgentPluginResult<void> };
}

/** Only display declarations. Runtime configuration and arbitrary vendor extensions stay on the Host. */
export function describePluginMcp({
  key,
  transport,
  variables,
}: AgentPluginMcpServer): PluginMcpReview {
  const names = variables.map(({ name }) => name);
  if (transport.type === "stdio") {
    return {
      key,
      transport: {
        type: "stdio",
        command: transport.command,
        args: transport.args,
        cwd: transport.cwd,
      },
      configuration: [...new Set([...Object.keys(transport.env), ...names])],
    };
  }
  return {
    key,
    transport: { type: transport.type, url: transport.url.replace(/[?#].*$/u, "") },
    configuration: [...new Set([...Object.keys(transport.headers), ...names])],
  };
}

export function describePluginPackage(pkg: AgentPluginPackage): PluginPackageReview {
  return {
    identity: pkg.identity,
    displayName: pkg.presentation?.displayName,
    layout: pkg.layout,
    skills: pkg.skills,
    hooks: pkg.hooks,
    apps: pkg.apps,
    digest: pkg.digest,
    diagnostics: pkg.diagnostics,
    mcpServers: pkg.mcpServers.map(describePluginMcp),
  };
}
