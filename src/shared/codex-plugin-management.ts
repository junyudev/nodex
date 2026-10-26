import type { PluginSettingsQueries, PluginSettingsCommands } from "./codex-plugin-settings";
export type * from "./codex-plugin-settings";
import type { PluginSearchScope } from "@nodex/codex-app-server-protocol/v2/PluginSearchScope";
import type { PluginSummary } from "@nodex/codex-app-server-protocol/v2/PluginSummary";
import type { PluginDetail } from "@nodex/codex-app-server-protocol/v2/PluginDetail";
import type { PluginListResponse } from "@nodex/codex-app-server-protocol/v2/PluginListResponse";
import type { PluginInstalledResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstalledResponse";
import type { PluginInstallResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstallResponse";
import type { MarketplaceAddParams } from "@nodex/codex-app-server-protocol/v2/MarketplaceAddParams";
import type { MarketplaceAddResponse } from "@nodex/codex-app-server-protocol/v2/MarketplaceAddResponse";
import type { MarketplaceUpgradeParams } from "@nodex/codex-app-server-protocol/v2/MarketplaceUpgradeParams";
import type { MarketplaceUpgradeResponse } from "@nodex/codex-app-server-protocol/v2/MarketplaceUpgradeResponse";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { HooksListResponse } from "@nodex/codex-app-server-protocol/v2/HooksListResponse";

export type { PluginSummary, PluginDetail, PluginSearchScope, PluginListResponse };
export interface PluginContext {
  readonly hostId: string;
  readonly projectId: string | null;
}
export interface ResolvedPluginContext extends PluginContext {
  readonly hostGeneration: number;
  readonly accountEpoch: number;
  readonly bindingRevision: number | null;
  readonly cwds: readonly string[];
}
export type PluginSelector =
  | {
      readonly marketplacePath: string;
      readonly remoteMarketplaceName?: never;
      readonly pluginName: string;
    }
  | {
      readonly marketplacePath?: never;
      readonly remoteMarketplaceName: string;
      readonly pluginName: string;
    };
export interface PluginRouteTarget {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly marketplace:
    | { readonly kind: "local"; readonly marketplacePath: string }
    | { readonly kind: "remote"; readonly remoteMarketplaceName: string };
}
export interface PluginMarketplaceIdentity {
  readonly name: string;
  readonly path: string | null;
  readonly displayName: string | null;
}
export type PluginActionState =
  | "install"
  | "installed_menu"
  | "admin_disabled"
  | "unavailable"
  | "loading";
export type PluginAppConnectionState =
  | "unknown"
  | "connected"
  | "admin_disabled"
  | "authentication_required"
  | "unavailable";
export interface PluginRow {
  readonly appConnectionError?: PluginFailure | null;
  readonly appConnectionStates?: Readonly<Record<string, PluginAppConnectionState>>;
  readonly summary: PluginSummary;
  readonly marketplace: PluginMarketplaceIdentity;
  readonly selector: PluginSelector;
  readonly stableIdentity: string;
  readonly nativeId: string;
  readonly logoUrl: string | null;
  readonly logoDarkUrl: string | null;
  readonly composerIconUrl: string | null;
  readonly managed: boolean;
  readonly canUninstall: boolean;
  readonly canSetEnabled: boolean;
  readonly installState: "installed" | "not_installed" | "unknown";
  readonly actionState: PluginActionState;
  readonly isPersonal: boolean;
  readonly isOfficial: boolean;
}
export interface PluginInventory<T = PluginListResponse | PluginInstalledResponse> {
  readonly response: T;
  readonly rows: readonly PluginRow[];
  readonly context: ResolvedPluginContext;
}
export interface PluginManagementCapabilities {
  readonly context: ResolvedPluginContext;
  readonly nativeSearch: boolean;
  readonly publicHome: boolean;
  readonly category: boolean;
  readonly personal: boolean;
  readonly shared: boolean;
  readonly remoteToggle: boolean;
  readonly workspace: boolean;
  readonly workspaceCreated: boolean;
}
export type PluginFailureCode =
  | "invalid_input"
  | "project_unavailable"
  | "host_unavailable"
  | "unsupported"
  | "auth_required"
  | "account_changed"
  | "policy_denied"
  | "protected"
  | "not_found"
  | "inventory_unavailable"
  | "config_conflict"
  | "mutation_outcome_unknown"
  | "service_unavailable";
export interface PluginFailure {
  readonly marketplaceErrors?: readonly import("@nodex/codex-app-server-protocol/v2/MarketplaceUpgradeErrorInfo").MarketplaceUpgradeErrorInfo[];
  readonly code: PluginFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}
export type PluginRefreshResource = "plugins" | "skills" | "apps" | "hooks" | "mcp";
export type PluginMutationResult<T = void> =
  | {
      readonly status: "success" | "success-with-refresh-warning";
      readonly value: T;
      readonly refreshFailures: readonly PluginRefreshResource[];
    }
  | { readonly status: "protected" | "policy_denied" | "failed"; readonly error: PluginFailure };
export interface PluginSection {
  readonly id: string;
  readonly title: string;
  readonly urlSlug: string | null;
  readonly plugins: readonly PluginRow[];
}
export interface PublicPluginSections {
  readonly source: "service" | "local";
  readonly sections: readonly PluginSection[];
}
export interface PluginCategoryMetadata {
  readonly title: string;
  readonly description?: string;
}
export interface PluginPage {
  readonly rows: readonly PluginRow[];
  readonly nextCursor: string | null;
  readonly category?: PluginCategoryMetadata;
}
export interface PersonalPluginPage {
  readonly rows: readonly PluginRow[];
  readonly nextCursor: PersonalPluginCursor | null;
}
export interface PersonalPluginCursor {
  readonly workspaceCreatedPageToken: string | null;
  readonly userPageToken: string | null;
}
export interface PersonalPlugins {
  readonly createdByYou: readonly PluginRow[];
  readonly sharedWithYou: readonly PluginRow[];
  readonly marketplaces: readonly {
    readonly identity: PluginMarketplaceIdentity;
    readonly label: string;
    readonly plugins: readonly PluginRow[];
  }[];
}
export interface PluginDetailView {
  readonly appConnectionStates?: Readonly<Record<string, PluginAppConnectionState>>;
  readonly scheduledTasks?: PluginDetail["scheduledTasks"];
  readonly appTemplates?: PluginDetail["appTemplates"];
  readonly onboardingSkill?: PluginDetail["onboardingSkill"];
  readonly worksWith?: import("./codex-plugin-settings").PluginDependenciesView;
  readonly appConnectionError?: PluginFailure | null;
  readonly detail: PluginDetail;
  readonly row: PluginRow;
  readonly summary: PluginSummary;
  readonly description: string | null;
  readonly skills: PluginDetail["skills"];
  readonly apps: PluginDetail["apps"];
  readonly mcpServers: PluginDetail["mcpServers"];
  readonly hooks: PluginDetail["hooks"];
  readonly info: {
    readonly capabilities: readonly string[];
    readonly developer: string | null;
    readonly category: string | null;
    readonly version: string | null;
    readonly websiteUrl: string | null;
    readonly privacyPolicyUrl: string | null;
    readonly termsOfServiceUrl: string | null;
    readonly defaultPrompts: readonly string[];
    readonly brandColor: string | null;
    readonly logoUrl: string | null;
    readonly logoDarkUrl: string | null;
  };
}
export interface SkillsView {
  readonly installed: readonly SkillMetadata[];
  readonly personal: readonly SkillMetadata[];
  readonly system: readonly SkillMetadata[];
  readonly project: readonly SkillMetadata[];
  readonly admin: readonly SkillMetadata[];
  readonly matchKeys: readonly string[];
}
export type SkillContentsSelector =
  | { readonly path: string }
  | {
      readonly remoteMarketplaceName: string;
      readonly remotePluginId: string;
      readonly skillName: string;
    };
export type SkillEnabledSelector = (
  | { readonly path: string; readonly name?: never }
  | { readonly name: string; readonly path?: never }
) & { readonly enabled: boolean };
export interface MarketplaceRemovalPreview {
  readonly marketplaceName: string;
  readonly marketplacePath?: string | null;
  readonly plugins?: readonly PluginRow[];
  readonly pluginIds: readonly string[];
  readonly protected: boolean;
}
export interface MarketplaceRemovalProgress extends MarketplaceRemovalPreview {
  readonly context?: ResolvedPluginContext;
  readonly phase?: "uninstalling" | "removing" | "complete" | "failed";
  readonly operationId: string;
  readonly completedPluginIds: readonly string[];
  readonly remainingPluginIds: readonly string[];
  readonly removed: boolean;
  readonly outcome: PluginMutationResult;
}
export interface PluginManagementChanged {
  readonly hostId: string;
  readonly accountEpoch: number;
  readonly hostGeneration?: number;
  readonly kind: "plugins" | "skills" | "apps" | "mcp" | "account" | "connection";
  readonly mcpOauthCompletion?: import("@nodex/codex-app-server-protocol/v2/McpServerOauthLoginCompletedNotification").McpServerOauthLoginCompletedNotification;
  readonly progress?: MarketplaceRemovalProgress;
}
export interface PluginQueries extends PluginSettingsQueries {
  context: { input: PluginContext; output: ResolvedPluginContext };
  capabilities: { input: PluginContext; output: PluginManagementCapabilities };
  list: {
    input: PluginContext & { readonly forceRefetch?: boolean };
    output: PluginInventory<PluginListResponse>;
  };
  installed: { input: PluginContext; output: PluginInventory<PluginInstalledResponse> };
  read: { input: PluginContext & PluginSelector; output: PluginDetailView };
  search: {
    input: PluginContext & {
      readonly term: string;
      readonly cursor?: string | null;
      readonly scope?: PluginSearchScope;
    };
    output: PluginPage;
  };
  skills: { input: PluginContext & { readonly forceReload?: boolean }; output: SkillsListResponse };
  "skill-contents": {
    input: PluginContext & SkillContentsSelector;
    output: import("./codex-plugin-settings").SkillContentsView;
  };
  hooks: { input: PluginContext; output: HooksListResponse };
  "public-home": { input: PluginContext; output: PublicPluginSections };
  category: {
    input: PluginContext & {
      readonly slug: string;
      readonly search?: string;
      readonly cursor?: string | null;
    };
    output: PluginPage;
  };
  personal: { input: PluginContext; output: PersonalPlugins };
  "personal-page": {
    input: PluginContext & {
      readonly feed: "created" | "shared";
      readonly cursor?: PersonalPluginCursor | null;
    };
    output: PersonalPluginPage;
  };
  "marketplace-removal-preview": {
    input: PluginContext & {
      readonly marketplaceName: string;
      readonly marketplacePath?: string | null;
    };
    output: MarketplaceRemovalPreview;
  };
}
export interface PluginCommands extends PluginSettingsCommands {
  install: {
    input: PluginContext & PluginSelector & { readonly installAttemptId: string };
    output: PluginMutationResult<PluginInstallResponse>;
  };
  uninstall: { input: PluginContext & { readonly pluginId: string }; output: PluginMutationResult };
  "set-enabled": {
    input: PluginContext & { readonly pluginId: string; readonly enabled: boolean };
    output: PluginMutationResult;
  };
  "skill-enabled": { input: PluginContext & SkillEnabledSelector; output: PluginMutationResult };
  "marketplace-add": {
    input: PluginContext & MarketplaceAddParams;
    output: PluginMutationResult<MarketplaceAddResponse>;
  };
  "marketplace-remove": {
    input: PluginContext & {
      readonly marketplaceName: string;
      readonly marketplacePath?: string | null;
      readonly operationId?: string;
    };
    output: MarketplaceRemovalProgress;
  };
  "marketplace-upgrade": {
    input: PluginContext & MarketplaceUpgradeParams;
    output: PluginMutationResult<MarketplaceUpgradeResponse>;
  };
  refresh: { input: PluginContext; output: PluginMutationResult };
}
export type PluginManagementIpcApi = {
  [K in keyof PluginQueries as `codex:plugins:${K}`]: {
    args: [PluginQueries[K]["input"]];
    result: PluginQueries[K]["output"];
  };
} & {
  [K in keyof PluginCommands as `codex:plugins:${K}`]: {
    args: [PluginCommands[K]["input"]];
    result: PluginCommands[K]["output"];
  };
};
