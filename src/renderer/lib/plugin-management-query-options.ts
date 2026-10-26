import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  PluginContext,
  ResolvedPluginContext,
  PluginQueries,
  PersonalPluginCursor,
  PluginSearchScope,
} from "../../shared/codex-plugin-management";
import { queryPluginManagement } from "./plugin-management-adapter";
import { pluginManagementKeys } from "./plugin-management-query-keys";
const MINUTE = 60_000;
const freshness = {
  "app-tools": 5 * MINUTE,
  marketplaces: MINUTE,
  apps: 5 * MINUTE,
  "mcp-servers": 5 * MINUTE,
  "recommended-skills": 5 * MINUTE,
  "creation-capabilities": MINUTE,
  "plugin-hooks": 5 * MINUTE,
  context: 0,
  capabilities: 0,
  list: 360 * MINUTE,
  installed: MINUTE,
  read: MINUTE,
  search: MINUTE,
  skills: 5 * MINUTE,
  "skill-contents": 5 * MINUTE,
  hooks: MINUTE,
  "public-home": 60 * MINUTE,
  category: MINUTE,
  personal: MINUTE,
  "personal-page": MINUTE,
  "marketplace-removal-preview": 0,
} satisfies Record<keyof PluginQueries, number>;
export const pluginCapabilitiesOptions = (context: PluginContext, scope?: ResolvedPluginContext) =>
  queryOptions({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, "capabilities")
      : pluginManagementKeys.capabilities(context),
    queryFn: () => queryPluginManagement("capabilities", context),
    staleTime: 0,
    retry: false,
  });
export const pluginContextOptions = (context: PluginContext) =>
  queryOptions({
    queryKey: pluginManagementKeys.context(context),
    queryFn: () => queryPluginManagement("context", context),
    staleTime: 0,
    retry: false,
  });
export function pluginQueryOptions<K extends keyof PluginQueries>(
  scope: ResolvedPluginContext | undefined,
  context: PluginContext,
  resource: K,
  args: Omit<PluginQueries[K]["input"], keyof PluginContext>,
) {
  return queryOptions({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, resource, args)
      : ["plugin-management-pending", context.hostId, context.projectId, resource, args],
    enabled: scope !== undefined,
    queryFn: () =>
      queryPluginManagement(resource, {
        hostId: context.hostId,
        projectId: context.projectId,
        ...args,
      } as PluginQueries[K]["input"]),
    staleTime: freshness[resource],
    gcTime: resource === "public-home" ? 60 * MINUTE : 5 * MINUTE,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export const pluginPageOptions = (
  scope: ResolvedPluginContext | undefined,
  context: PluginContext,
  resource: "category" | "search",
  args: { slug?: string; search?: string; term?: string; scope?: PluginSearchScope },
) =>
  infiniteQueryOptions({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, resource, args)
      : ["plugin-management-pending", context.hostId, context.projectId, resource, args],
    enabled: scope !== undefined,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      resource === "category"
        ? queryPluginManagement("category", {
            hostId: context.hostId,
            projectId: context.projectId,
            slug: args.slug ?? "",
            search: args.search,
            cursor: pageParam,
          })
        : queryPluginManagement("search", {
            hostId: context.hostId,
            projectId: context.projectId,
            term: args.term ?? "",
            scope: args.scope ?? "global",
            cursor: pageParam,
          }),
    getNextPageParam: (page, _pages, current) =>
      page.nextCursor === current ? undefined : (page.nextCursor ?? undefined),
    staleTime: MINUTE,
    gcTime: 5 * MINUTE,
    retry: false,
    placeholderData: (previous, previousQuery) =>
      scope &&
      JSON.stringify(previousQuery?.queryKey.slice(0, 7)) ===
        JSON.stringify(pluginManagementKeys.scope(scope))
        ? previous
        : undefined,
  });
export const personalPluginPageOptions = (
  scope: ResolvedPluginContext | undefined,
  context: PluginContext,
  feed: "created" | "shared",
) =>
  infiniteQueryOptions({
    queryKey: scope
      ? pluginManagementKeys.resource(scope, "personal-page", { feed })
      : ["plugin-management-pending", context.hostId, context.projectId, "personal-page", feed],
    enabled: scope !== undefined,
    initialPageParam: null as PersonalPluginCursor | null,
    queryFn: ({ pageParam }) =>
      queryPluginManagement("personal-page", {
        hostId: context.hostId,
        projectId: context.projectId,
        feed,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: MINUTE,
    retry: false,
  });
