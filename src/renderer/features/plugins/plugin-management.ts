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
import { dedupePluginRows, selectInstalledPlugins, selectSkills } from "./model/selectors";
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
  readonly install: Command<"install">;
  readonly uninstall: Command<"uninstall">;
  readonly setPluginEnabled: Command<"set-enabled">;
  readonly setSkillEnabled: Command<"skill-enabled">;
  readonly addMarketplace: Command<"marketplace-add">;
  readonly removeMarketplace: Command<"marketplace-remove">;
  readonly upgradeMarketplaces: Command<"marketplace-upgrade">;
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
): UseQueryResult<PluginDetailView> {
  return useQuery(pluginQueryOptions(useScope(context), context, "read", selector));
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
): UseQueryResult<{ readonly contents: string | null }> {
  return useQuery(pluginQueryOptions(useScope(context), context, "skill-contents", selector));
}
export function useMarketplaceRemovalPreview(
  context: PluginContext,
  marketplaceName: string,
): UseQueryResult<MarketplaceRemovalPreview> {
  return useQuery(
    pluginQueryOptions(useScope(context), context, "marketplace-removal-preview", {
      marketplaceName,
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
export function usePluginManagement(context: PluginContext): PluginManagement {
  const client = useQueryClient();
  usePluginCapabilities(context);
  return {
    install: (input) => runPluginMutation(client, context, "install", input),
    uninstall: (input) => runPluginMutation(client, context, "uninstall", input),
    setPluginEnabled: (input) => runPluginMutation(client, context, "set-enabled", input),
    setSkillEnabled: (input) => runPluginMutation(client, context, "skill-enabled", input),
    addMarketplace: (input) => runPluginMutation(client, context, "marketplace-add", input),
    removeMarketplace: (input) => runPluginMutation(client, context, "marketplace-remove", input),
    upgradeMarketplaces: (input) =>
      runPluginMutation(client, context, "marketplace-upgrade", input),
    refresh: () => runPluginMutation(client, context, "refresh", {}),
  };
}
