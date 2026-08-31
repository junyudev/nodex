import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { readDatabaseViewWindow } from "./api";
import { invokeRendererQuery as invoke } from "./renderer-command";
import { queryKeys } from "./query-keys";
import { preferNewestProjectSessionSummaryWindow } from "./project-session-summary-window";
import type {
  CodexAutomationRunsInboxResponse,
  CodexComposerChatGptConversationListResult,
  CodexComposerPlugin,
  CodexComposerSiteListResult,
  CodexComposerSkill,
  CodexModelOption,
  CodexScheduledAutomationListResponse,
  ProtocolMcpResourceReadResponse,
  ProtocolAppInfo,
  ProtocolExperimentalFeature,
  ProtocolListMcpServerStatusResponse,
  ProjectListOptions,
  Project,
  ProjectActivitySummaryResult,
  PageChatActivitySummaryResult,
  PageChatWindow,
  PageChatWindowInput,
  ProjectWindow,
  ProjectSession,
  ProjectSessionSummaryWindow,
  WorktreeEnvironmentConfigRecord,
  WorktreeEnvironmentOption,
  WorktreeEnvironmentSettingsSnapshot,
  WorkspaceDirectoryEntriesInput,
  WorkspaceDirectoryEntriesResult,
  WorkspaceFileBinaryReadResult,
  WorkspaceFileMetadata,
  WorkspaceFileMetadataInput,
  WorkspaceFileReadResult,
  WorkspaceFileRequest,
  WorkspaceFileSearchInput,
  WorkspaceFileSearchResult,
  WorkspaceFileTextReadInput,
} from "./types";
import type { GitRepositoryIdentity } from "../../shared/git-repository-identity";
import type { LocalPathPresentationContext } from "../../shared/local-path-presentation";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import type { ProtocolMcpResourceReadParams } from "../../shared/types";
import type { CodexHooksListInput, CodexHooksListResponse } from "../../shared/codex-hooks";
import type { DatabaseViewWindowSnapshot } from "../../shared/database-views";
import {
  admitResourceAuthorityQuery,
  resourceAuthorityQueryMeta,
} from "./resource-authority-query-cache";
import { normalizePageChatPageIds, readPageChatActivitySummaryBatches } from "./page-chat-queries";
import { readPageChatActivitySummaries, readPageChatWindow } from "./page-chat-runtime";

const MCP_CATALOG_STALE_TIME_MS = 5 * 60_000;

const resolveBoardAuthority = (_queryKey: readonly unknown[], data: unknown) => {
  const snapshot = data as DatabaseViewWindowSnapshot | undefined;
  return snapshot ? { authorizations: [snapshot.authorization] } : null;
};

export function projectsListQueryOptions(options: ProjectListOptions = {}) {
  const includeArchived = options.includeArchived === true;
  return infiniteQueryOptions({
    queryKey: queryKeys.projects.list(includeArchived),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ProjectWindow> =>
      (await invoke("projects:list", {
        includeArchived,
        after: pageParam,
        first: 100,
      })) as ProjectWindow,
    getNextPageParam: (window) => window.nextCursor ?? undefined,
  });
}

export function projectDetailQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => invoke("projects:get", projectId) as Promise<Project | null>,
    staleTime: 30_000,
  });
}

export function projectActivitySummariesQueryOptions(projectIds: readonly string[]) {
  return queryOptions({
    queryKey: queryKeys.projectActivity.summaries(projectIds),
    queryFn: () =>
      invoke("projects:activity-summaries", [
        ...projectIds,
      ]) as Promise<ProjectActivitySummaryResult>,
    enabled: projectIds.length > 0,
    staleTime: 30_000,
  });
}

export function pageChatActivitySummariesQueryOptions(
  pageAccessProjectId: string,
  pageIds: readonly string[],
) {
  const normalizedPageIds = normalizePageChatPageIds(pageIds);
  return queryOptions({
    queryKey: queryKeys.pageChats.activity(pageAccessProjectId, normalizedPageIds),
    queryFn: (): Promise<PageChatActivitySummaryResult> =>
      readPageChatActivitySummaryBatches(
        { pageAccessProjectId, pageIds: normalizedPageIds },
        readPageChatActivitySummaries,
      ),
    enabled: pageAccessProjectId.trim().length > 0 && normalizedPageIds.length > 0,
    staleTime: 30_000,
  });
}

export function pageChatWindowQueryOptions(input: Omit<PageChatWindowInput, "after">) {
  const pageAccessProjectId = input.pageAccessProjectId;
  const pageId = input.pageId;
  const includeArchived = input.includeArchived === true;
  const first = input.first ?? 50;
  return infiniteQueryOptions({
    queryKey: queryKeys.pageChats.detail(pageAccessProjectId, pageId, includeArchived, first),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }): Promise<PageChatWindow> =>
      readPageChatWindow({
        pageAccessProjectId,
        pageId,
        includeArchived,
        after: pageParam,
        first,
      }),
    getNextPageParam: (window) => window.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function boardByProjectQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.boards.byProject(projectId),
    queryFn: async () =>
      admitResourceAuthorityQuery(
        await readDatabaseViewWindow(projectId, { first: 50 }),
        resolveBoardAuthority,
      ),
    meta: resourceAuthorityQueryMeta(resolveBoardAuthority),
  });
}

export function projectSessionSummariesQueryOptions(projectId: string | null) {
  const queryKey = queryKeys.projectSessions.summaries(projectId);
  return queryOptions({
    queryKey,
    queryFn: async ({ client, queryKey: activeQueryKey }): Promise<ProjectSessionSummaryWindow> => {
      const incoming = (await invoke("workspace:tasks:list", projectId, {
        first: 50,
      })) as ProjectSessionSummaryWindow;
      return preferNewestProjectSessionSummaryWindow(
        client.getQueryData<ProjectSessionSummaryWindow>(activeQueryKey),
        incoming,
      );
    },
    staleTime: 30_000,
  });
}

export function projectSessionDetailQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.projectSessions.detail(sessionId),
    queryFn: () => invoke("project-sessions:get", sessionId) as Promise<ProjectSession | null>,
    staleTime: 30_000,
  });
}

export function commandKeymapStateQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.settings.commandKeymap(),
    queryFn: () => invoke("codex-command-keymap-state") as Promise<CommandKeymapState>,
    staleTime: 60_000,
  });
}

export function codexScheduledAutomationsListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.codexScheduledAutomations.list(),
    queryFn: async () => {
      const response = (await invoke(
        "codex:scheduled-automations:list",
      )) as CodexScheduledAutomationListResponse;
      return response.items;
    },
    staleTime: 30_000,
  });
}

export function codexAutomationRunsInboxQueryOptions(limit = 200) {
  return queryOptions({
    queryKey: queryKeys.codexAutomationRuns.inbox(limit),
    queryFn: () =>
      invoke(
        "codex:automation-runs:inbox-items",
        limit,
      ) as Promise<CodexAutomationRunsInboxResponse>,
    staleTime: 30_000,
  });
}

export function codexModelsListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.codexModels.list(),
    queryFn: () => invoke("codex:model:list") as Promise<CodexModelOption[]>,
    staleTime: 60_000,
  });
}

export function codexComposerPluginsListQueryOptions(cwds: readonly string[]) {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean))).sort();

  return queryOptions({
    queryKey: queryKeys.codexComposerPlugins.list(normalizedCwds),
    queryFn: () =>
      invoke("codex:composer-plugins:list", { cwds: normalizedCwds }) as Promise<
        CodexComposerPlugin[]
      >,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function codexComposerSkillsListQueryOptions(cwds: readonly string[]) {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean))).sort();

  return queryOptions({
    queryKey: queryKeys.codexComposerSkills.list(normalizedCwds),
    queryFn: () =>
      invoke("codex:composer-skills:list", { cwds: normalizedCwds }) as Promise<
        CodexComposerSkill[]
      >,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function codexComposerSitesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.codexComposerSites.list(),
    queryFn: () => invoke("codex:composer-sites:list") as Promise<CodexComposerSiteListResult>,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function codexComposerChatGptConversationsListQueryOptions(query: string) {
  const normalizedQuery = query.trim();
  return queryOptions({
    queryKey: queryKeys.codexComposerChatGptConversations.list(normalizedQuery),
    queryFn: () =>
      invoke("codex:composer-chatgpt-conversations:list", {
        query: normalizedQuery,
      }) as Promise<CodexComposerChatGptConversationListResult>,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function codexExperimentalFeaturesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.codexExperimentalFeatures.list(),
    queryFn: async () => {
      try {
        return (await invoke("codex:experimental-features:list")) as ProtocolExperimentalFeature[];
      } catch {
        return [];
      }
    },
    staleTime: 60_000,
  });
}

export function codexHooksListQueryOptions(input: CodexHooksListInput) {
  const { hostId, cwds } = input;
  return queryOptions({
    queryKey: queryKeys.codexHooks.list(hostId, cwds),
    queryFn: () => invoke("codex:hooks:list", { hostId, cwds }) as Promise<CodexHooksListResponse>,
    enabled: hostId.trim().length > 0 && cwds.length > 0,
    refetchOnWindowFocus: true,
    staleTime: 5 * 60_000,
  });
}

export function gitRepositoryIdentityQueryOptions(cwd: string) {
  return queryOptions({
    queryKey: queryKeys.git.repositoryIdentity(cwd),
    queryFn: () => invoke("git:repository:identity", cwd) as Promise<GitRepositoryIdentity | null>,
    enabled: cwd.trim().length > 0,
    staleTime: 5 * 60_000,
  });
}

export function localPathPresentationContextQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.shell.pathContext(),
    queryFn: () => invoke("shell:path-context:get") as Promise<LocalPathPresentationContext>,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function localEnvironmentConfigsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.localEnvironments.configs(projectId),
    queryFn: () =>
      invoke("worktrees:environments:configs:list", projectId) as Promise<
        WorktreeEnvironmentConfigRecord[]
      >,
    enabled: projectId.trim().length > 0,
  });
}

export function localEnvironmentOptionsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.localEnvironments.options(projectId),
    queryFn: () =>
      invoke("worktrees:environments:list", projectId) as Promise<WorktreeEnvironmentOption[]>,
    enabled: projectId.trim().length > 0,
  });
}

export function localEnvironmentSnapshotQueryOptions(
  projectId: string,
  configPath?: string | null,
) {
  return queryOptions({
    queryKey: queryKeys.localEnvironments.config(projectId, configPath),
    queryFn: () =>
      invoke(
        "worktrees:environments:config:read",
        projectId,
        configPath,
      ) as Promise<WorktreeEnvironmentSettingsSnapshot>,
    enabled: projectId.trim().length > 0,
  });
}

export function mcpServerStatusesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.mcp.statuses(),
    queryFn: () =>
      invoke("codex:mcp-server-statuses:list") as Promise<ProtocolListMcpServerStatusResponse>,
    staleTime: MCP_CATALOG_STALE_TIME_MS,
  });
}

export function mcpAppsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.mcp.apps(),
    queryFn: () => invoke("codex:mcp-apps:list") as Promise<ProtocolAppInfo[]>,
    retry: false,
    staleTime: MCP_CATALOG_STALE_TIME_MS,
  });
}

export function mcpResourceQueryOptions(params: ProtocolMcpResourceReadParams) {
  return queryOptions({
    queryKey: queryKeys.mcp.resource(params),
    queryFn: () =>
      invoke("codex:mcp-resource:read", params) as Promise<ProtocolMcpResourceReadResponse>,
    enabled: params.server.trim().length > 0 && params.uri.trim().length > 0,
  });
}

export function workspaceDirectoryQueryOptions(input: WorkspaceDirectoryEntriesInput) {
  return queryOptions({
    queryKey: queryKeys.workspaceFiles.directory(input),
    queryFn: () =>
      invoke("workspace-directory-entries", input) as Promise<WorkspaceDirectoryEntriesResult>,
  });
}

export function workspaceFileSearchQueryOptions(input: WorkspaceFileSearchInput) {
  return queryOptions({
    queryKey: queryKeys.workspaceFiles.search(input),
    queryFn: () => invoke("workspace-file-search", input) as Promise<WorkspaceFileSearchResult>,
  });
}

export function workspaceFileMetadataQueryOptions(input: WorkspaceFileMetadataInput) {
  return queryOptions({
    queryKey: queryKeys.workspaceFiles.metadata(input),
    queryFn: () => invoke("read-file-metadata", input) as Promise<WorkspaceFileMetadata>,
  });
}

export function workspaceFileTextQueryOptions(input: WorkspaceFileTextReadInput) {
  return queryOptions({
    queryKey: queryKeys.workspaceFiles.text(input),
    queryFn: () => invoke("read-file", input) as Promise<WorkspaceFileReadResult>,
  });
}

export function workspaceFileBinaryQueryOptions(input: WorkspaceFileRequest) {
  return queryOptions({
    queryKey: queryKeys.workspaceFiles.binary(input),
    queryFn: () => invoke("read-file-binary", input) as Promise<WorkspaceFileBinaryReadResult>,
  });
}
