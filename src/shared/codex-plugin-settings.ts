import type { ConnectorMetadata } from "@nodex/codex-app-server-protocol/v2/ConnectorMetadata";
import type { InstalledApp } from "@nodex/codex-app-server-protocol/v2/InstalledApp";
import type { McpServerStatus } from "@nodex/codex-app-server-protocol/v2/McpServerStatus";
import type { McpServerOauthLoginParams } from "@nodex/codex-app-server-protocol/v2/McpServerOauthLoginParams";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { ConfigEdit } from "@nodex/codex-app-server-protocol/v2/ConfigEdit";
import type {
  PluginContext,
  PluginFailure,
  PluginListResponse,
  PluginMarketplaceIdentity,
  PluginMutationResult,
  PluginRow,
  PluginSelector,
  PluginAppConnectionState,
} from "./codex-plugin-management";

export interface ConfiguredMarketplace extends PluginMarketplaceIdentity {
  readonly sourceType: "local" | "git" | null;
  readonly source: string | null;
  readonly refName: string | null;
  readonly configured: boolean;
  readonly builtIn: boolean;
  readonly canUpgrade: boolean;
  readonly canRemove: boolean;
  readonly pluginCount: number;
}
export interface MarketplacesView {
  readonly marketplaces: readonly ConfiguredMarketplace[];
  readonly loadErrors: PluginListResponse["marketplaceLoadErrors"];
}
export interface PluginAppRow {
  readonly id: string;
  readonly name: string;
  readonly metadata: ConnectorMetadata | null;
  readonly runtime: InstalledApp | null;
  readonly enabled: boolean;
  readonly callable: boolean;
  readonly logoUrl: string | null;
  readonly logoDarkUrl: string | null;
  readonly connectionState: PluginAppConnectionState;
  readonly connections: readonly { readonly id: string; readonly name: string | null }[];
  readonly canDisconnect: boolean;
}
export interface PluginAppsView {
  readonly apps: readonly PluginAppRow[];
  readonly missingAppIds: readonly string[];
  readonly connectionError: PluginFailure | null;
  readonly connect: { readonly supported: boolean; readonly reason: string | null };
}
/** Native config declarations remain JSON; plugin MCP names never become executable declarations. */
export type PluginMcpDeclaration = Readonly<Record<string, ConfigEdit["value"]>>;
export interface PluginMcpServer {
  readonly name: string;
  readonly declaration: PluginMcpDeclaration | null;
  readonly status: McpServerStatus | null;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly pluginId: string | null;
}
export interface PluginMcpServersView {
  readonly servers: readonly PluginMcpServer[];
}
export interface RecommendedSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly shortDescription: string | null;
}
export interface RecommendedSkillsView {
  readonly skills: readonly RecommendedSkill[];
  readonly error: PluginFailure | null;
  readonly source: "git" | "cache" | "bundled";
}
export interface SkillContentsView {
  readonly contents: string | null;
  readonly files: readonly string[];
}
export type PluginCreationHelper = "plugin-creator" | "record-and-replay";
export interface PluginHelperCapability {
  readonly available: boolean;
  readonly reason: PluginFailure | null;
  readonly plugin: PluginRow | null;
}
export interface PluginCreationCapabilities {
  readonly createPlugin: PluginHelperCapability;
  readonly recordSkill: PluginHelperCapability;
}
export interface PreparedPluginHelper {
  readonly nativeId: string;
  readonly displayName: string;
  readonly draft: string;
}
export interface PluginHooksView {
  readonly hooks: readonly HookMetadata[];
  readonly needsReviewCount: number;
}
export interface PluginSettingsQueries {
  marketplaces: { input: PluginContext; output: MarketplacesView };
  apps: {
    input: PluginContext & { readonly appIds?: readonly string[]; readonly forceRefresh?: boolean };
    output: PluginAppsView;
  };
  "mcp-servers": { input: PluginContext; output: PluginMcpServersView };
  "recommended-skills": {
    input: PluginContext & { readonly refresh?: boolean };
    output: RecommendedSkillsView;
  };
  "creation-capabilities": { input: PluginContext; output: PluginCreationCapabilities };
  "plugin-hooks": { input: PluginContext & PluginSelector; output: PluginHooksView };
}
export interface PluginSettingsCommands {
  "app-disconnect": {
    input: PluginContext & { readonly appId: string; readonly linkId?: string };
    output: PluginMutationResult;
  };
  "mcp-save": {
    input: PluginContext & {
      readonly name: string;
      readonly previousName?: string;
      readonly declaration: PluginMcpDeclaration;
    };
    output: PluginMutationResult;
  };
  "mcp-remove": { input: PluginContext & { readonly name: string }; output: PluginMutationResult };
  "mcp-enabled": {
    input: PluginContext & { readonly name: string; readonly enabled: boolean };
    output: PluginMutationResult;
  };
  "mcp-login": {
    input: PluginContext &
      Pick<McpServerOauthLoginParams, "name" | "clientRegistration" | "scopes">;
    output: PluginMutationResult<{ readonly authorizationUrl: string }>;
  };
  "skill-install": {
    input: PluginContext & {
      readonly id: string;
      readonly scope: "user" | "project";
      readonly cwd?: string;
    };
    output: PluginMutationResult<{ readonly path: string }>;
  };
  "skill-uninstall": {
    input: PluginContext & { readonly path: string };
    output: PluginMutationResult;
  };
  "prepare-helper": {
    input: PluginContext & {
      readonly helper: PluginCreationHelper;
      readonly installAttemptId: string;
    };
    output: PluginMutationResult<PreparedPluginHelper>;
  };
}
