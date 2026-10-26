import { useEffect, useState } from "react";
import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  PluginContext,
  PluginPage,
  PersonalPluginPage,
  PluginCategoryMetadata,
  PluginRow,
  PluginSelector,
  SkillContentsSelector,
  PluginCommands,
  MarketplaceRemovalProgress,
  MarketplaceRemovalPreview,
  PluginManagementCapabilities,
  PublicPluginSections,
  PersonalPlugins,
  PluginDetailView,
  SkillsView,
  PluginSearchScope,
} from "../../../shared/codex-plugin-management";
import {
  dedupePluginRows,
  selectInstalledPlugins,
  selectSkills,
  selectSkillsBrowse,
} from "./model/selectors";
import {
  acquirePluginManagementSubscription,
  runPluginMutation,
} from "../../lib/plugin-management-cache";
import {
  personalPluginPageOptions,
  pluginCapabilitiesOptions,
  pluginContextOptions,
  pluginPageOptions,
  pluginQueryOptions,
} from "../../lib/plugin-management-query-options";
import { pluginManagementKeys } from "../../lib/plugin-management-query-keys";
export type * from "../../../shared/codex-plugin-management";
export { selectorToRouteTarget, routeTargetToSelector } from "./model/selectors";
function infiniteState<T>(query: UseInfiniteQueryResult<InfiniteData<T>>) {
  return {
    data: query.data,
    error: query.error,
    status: query.status,
    fetchStatus: query.fetchStatus,
    isPending: query.isPending,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isRefetching: query.isRefetching,
    isPlaceholderData: query.isPlaceholderData,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
  };
}
export type PluginRowsQuery = UseQueryResult<readonly PluginRow[]>;
export type PluginInfiniteQuery = ReturnType<typeof infiniteState<PluginPage>> & {
  readonly rows: readonly PluginRow[];
  readonly category: PluginCategoryMetadata | undefined;
};
export type PersonalInfiniteQuery = ReturnType<typeof infiniteState<PersonalPluginPage>> & {
  readonly rows: readonly PluginRow[];
};
type Command<K extends keyof PluginCommands> = (
  input: Omit<PluginCommands[K]["input"], keyof PluginContext>,
) => Promise<PluginCommands[K]["output"]>;
export interface PluginManagement {
  readonly setAppToolEnabled: Command<"app-tool-enabled">;
  readonly setAppEnabled: Command<"app-enabled">;
  readonly trustAllPluginHooks: Command<"plugin-hooks-trust">;
  readonly setPluginMcpServerEnabled: Command<"plugin-mcp-enabled">;
  readonly install: Command<"install">;
  readonly uninstall: Command<"uninstall">;
  readonly setPluginEnabled: Command<"set-enabled">;
  readonly setSkillEnabled: Command<"skill-enabled">;
  readonly addMarketplace: Command<"marketplace-add">;
  readonly removeMarketplace: Command<"marketplace-remove">;
  readonly upgradeMarketplaces: Command<"marketplace-upgrade">;
  readonly disconnectApp: Command<"app-disconnect">;
  readonly saveMcpServer: Command<"mcp-save">;
  readonly removeMcpServer: Command<"mcp-remove">;
  readonly setMcpServerEnabled: Command<"mcp-enabled">;
  readonly loginMcpServer: Command<"mcp-login">;
  readonly installRecommendedSkill: Command<"skill-install">;
  readonly uninstallSkill: Command<"skill-uninstall">;
  readonly preparePluginHelper: Command<"prepare-helper">;
  readonly refresh: () => Promise<PluginCommands["refresh"]["output"]>;
}
export function usePluginCapabilities(
  context: PluginContext,
): UseQueryResult<PluginManagementCapabilities> {
  const client = useQueryClient();
  useEffect(() => acquirePluginManagementSubscription(client), [client]);
  return useQuery(pluginCapabilitiesOptions(context, useScope(context)));
}
function useScope(context: PluginContext) {
  const client = useQueryClient();
  useEffect(() => acquirePluginManagementSubscription(client), [client]);
  return useQuery(pluginContextOptions(context)).data;
}
export function usePublicPluginSections(
  context: PluginContext,
): UseQueryResult<PublicPluginSections> {
  return useQuery(pluginQueryOptions(useScope(context), context, "public-home", {}));
}
export function usePluginCategory(
  context: PluginContext,
  input: { slug: string; search?: string },
): PluginInfiniteQuery {
  const query = useInfiniteQuery(pluginPageOptions(useScope(context), context, "category", input));
  return {
    ...infiniteState(query),
    rows: dedupePluginRows(query.data?.pages.flatMap((page) => page.rows) ?? []),
    category: query.data?.pages.find((page) => page.category)?.category,
  };
}
export function usePersonalPlugins(context: PluginContext): UseQueryResult<PersonalPlugins> {
  return useQuery(pluginQueryOptions(useScope(context), context, "personal", {}));
}
function usePersonalPage(
  context: PluginContext,
  feed: "created" | "shared",
): PersonalInfiniteQuery {
  const query = useInfiniteQuery(personalPluginPageOptions(useScope(context), context, feed));
  return {
    ...infiniteState(query),
    rows: dedupePluginRows(query.data?.pages.flatMap((page) => page.rows) ?? []),
  };
}
export function useCreatedPlugins(context: PluginContext): PersonalInfiniteQuery {
  return usePersonalPage(context, "created");
}
export function useSharedPlugins(context: PluginContext): PersonalInfiniteQuery {
  return usePersonalPage(context, "shared");
}
export function useInstalledPlugins(
  context: PluginContext,
  input: { search?: string } = {},
): PluginRowsQuery {
  return useQuery({
    ...pluginQueryOptions(useScope(context), context, "installed", {}),
    select: (inventory) => selectInstalledPlugins(inventory.rows, input.search),
  });
}
export function usePluginSearch(
  context: PluginContext,
  term: string,
  options: { scope?: PluginSearchScope } = {},
): PluginInfiniteQuery {
  const [debounced, setDebounced] = useState(term.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 200);
    return () => clearTimeout(timer);
  }, [term]);
  const query = useInfiniteQuery(
    pluginPageOptions(useScope(context), context, "search", {
      term: debounced,
      scope: options.scope ?? "global",
    }),
  );
  return {
    ...infiniteState(query),
    rows: dedupePluginRows(query.data?.pages.flatMap((page) => page.rows) ?? []),
    category: undefined,
  };
}
export function usePluginDetail(
  context: PluginContext,
  selector: PluginSelector,
  options: { readonly refreshAppConnectionsOnFocus?: boolean } = {},
): UseQueryResult<PluginDetailView> {
  return useQuery({
    ...pluginQueryOptions(useScope(context), context, "read", {
      ...selector,
      forceRefreshApps: options.refreshAppConnectionsOnFocus ?? false,
    }),
    refetchOnWindowFocus: options.refreshAppConnectionsOnFocus ? "always" : false,
  });
}
export function useSkills(context: PluginContext): UseQueryResult<SkillsView> {
  return useQuery({
    ...pluginQueryOptions(useScope(context), context, "skills", {}),
    select: selectSkills,
  });
}
export function useSkillContents(
  context: PluginContext,
  selector: SkillContentsSelector,
): UseQueryResult<import("../../../shared/codex-plugin-settings").SkillContentsResult> {
  return useQuery(pluginQueryOptions(useScope(context), context, "skill-contents", selector));
}
export function useMarketplaceRemovalPreview(
  context: PluginContext,
  marketplaceName: string,
  marketplacePath?: string | null,
): UseQueryResult<MarketplaceRemovalPreview> {
  return useQuery(
    pluginQueryOptions(useScope(context), context, "marketplace-removal-preview", {
      marketplaceName,
      ...(marketplacePath === undefined ? {} : { marketplacePath }),
    }),
  );
}
export function useMarketplaceRemovalProgress(
  context: PluginContext,
  operationId: string | null = null,
): UseQueryResult<MarketplaceRemovalProgress | null> {
  const scope = useScope(context);
  return useQuery({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, "marketplace-progress", operationId)
      : ["plugin-management-progress-pending", context.hostId, operationId],
    queryFn: (): MarketplaceRemovalProgress | null => null,
    initialData: null,
    enabled: false,
  });
}
export function useMarketplaces(context: PluginContext) {
  return useQuery(pluginQueryOptions(useScope(context), context, "marketplaces", {}));
}
export function usePluginApps(
  context: PluginContext,
  input: { appIds?: readonly string[]; forceRefresh?: boolean; refreshOnFocus?: boolean } = {},
) {
  return useQuery({
    ...pluginQueryOptions(useScope(context), context, "apps", {
      appIds: input.appIds,
      forceRefresh: input.forceRefresh || input.refreshOnFocus,
    }),
    refetchOnWindowFocus: input.refreshOnFocus ? "always" : false,
  });
}
export function usePluginMcpServers(context: PluginContext) {
  return useQuery(pluginQueryOptions(useScope(context), context, "mcp-servers", {}));
}
export function usePluginAppTools(
  context: PluginContext,
  appId: string,
): UseQueryResult<import("../../../shared/codex-plugin-settings").PluginAppToolsView> {
  const scope = useScope(context);
  return useQuery({
    ...pluginQueryOptions(scope, context, "app-tools", { appId }),
    enabled: scope !== undefined && appId.length > 0,
  });
}
export function useRecommendedSkills(context: PluginContext, input: { refresh?: boolean } = {}) {
  return useQuery(pluginQueryOptions(useScope(context), context, "recommended-skills", input));
}
export function usePluginCreationCapabilities(context: PluginContext) {
  return useQuery(pluginQueryOptions(useScope(context), context, "creation-capabilities", {}));
}
export function usePluginHooks(context: PluginContext, selector: PluginSelector) {
  return useQuery(pluginQueryOptions(useScope(context), context, "plugin-hooks", selector));
}
export function useMcpOauthCompletion(context: PluginContext) {
  const scope = useScope(context);
  return useQuery({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, "mcp-oauth-completion")
      : ["plugin-mcp-oauth-pending", context.hostId, context.projectId],
    queryFn: ():
      | import("@nodex/codex-app-server-protocol/v2/McpServerOauthLoginCompletedNotification").McpServerOauthLoginCompletedNotification
      | null => null,
    initialData: null,
    enabled: false,
  });
}
export function useRecommendedSkillInstallIds(context: PluginContext) {
  const scope = useScope(context);
  return useQuery({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, "recommended-installs")
      : ["plugin-recommended-installs-pending", context.hostId, context.projectId],
    queryFn: (): readonly string[] => [],
    initialData: [] as readonly string[],
    enabled: false,
  });
}
export function useSkillsPageData(context: PluginContext, search = "") {
  const skills = useSkills(context);
  const recommended = useRecommendedSkills(context);
  const installedIds = useRecommendedSkillInstallIds(context);
  return {
    ...selectSkillsBrowse({
      skills: skills.data,
      recommended: recommended.data,
      search,
      installedRecommendedIds: installedIds.data,
    }),
    skillsQuery: skills,
    recommendedQuery: recommended,
  };
}
export function usePluginManagement(context: PluginContext): PluginManagement {
  const client = useQueryClient();
  useScope(context);
  return {
    install: (input) => runPluginMutation(client, context, "install", input),
    uninstall: (input) => runPluginMutation(client, context, "uninstall", input),
    setPluginEnabled: (input) => runPluginMutation(client, context, "set-enabled", input),
    setSkillEnabled: (input) => runPluginMutation(client, context, "skill-enabled", input),
    addMarketplace: (input) => runPluginMutation(client, context, "marketplace-add", input),
    removeMarketplace: (input) => runPluginMutation(client, context, "marketplace-remove", input),
    upgradeMarketplaces: (input) =>
      runPluginMutation(client, context, "marketplace-upgrade", input),
    disconnectApp: (input) => runPluginMutation(client, context, "app-disconnect", input),
    setAppEnabled: (input) => runPluginMutation(client, context, "app-enabled", input),
    setAppToolEnabled: (input) => runPluginMutation(client, context, "app-tool-enabled", input),
    trustAllPluginHooks: (input) => runPluginMutation(client, context, "plugin-hooks-trust", input),
    setPluginMcpServerEnabled: (input) =>
      runPluginMutation(client, context, "plugin-mcp-enabled", input),
    saveMcpServer: (input) => runPluginMutation(client, context, "mcp-save", input),
    removeMcpServer: (input) => runPluginMutation(client, context, "mcp-remove", input),
    setMcpServerEnabled: (input) => runPluginMutation(client, context, "mcp-enabled", input),
    loginMcpServer: (input) => runPluginMutation(client, context, "mcp-login", input),
    installRecommendedSkill: (input) => runPluginMutation(client, context, "skill-install", input),
    uninstallSkill: (input) => runPluginMutation(client, context, "skill-uninstall", input),
    preparePluginHelper: (input) => runPluginMutation(client, context, "prepare-helper", input),
    refresh: () => runPluginMutation(client, context, "refresh", {}),
  };
}
