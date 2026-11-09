import { readModelCatalogForHost } from "../features/local-conversation/renderer-native-catalog";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { readDatabaseViewWindow } from "./api";
import { invokeRendererQuery as invoke } from "./renderer-command";
import { isHostedChat } from "./hosted-chat";
import { queryKeys } from "./query-keys";
import { preferNewestProjectSessionSummaryWindow } from "./project-session-summary-window";
import type {
  AutomationRunsInboxResponse,
  CodexComposerChatGptConversationListResult,
  CodexComposerPlugin,
  CodexComposerSiteListResult,
  CodexComposerSkill,
  AutomationListResponse,
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
  ProjectSessionSummaryWindowInput,
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
  WorkspaceFileTextReadInput,
} from "./types";
import type { GitRepositoryIdentity } from "../../shared/git-repository-identity";
import type { LocalPathPresentationContext } from "../../shared/local-path-presentation";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import type { ProtocolMcpResourceReadParams } from "../../shared/types";
import type { CodexHooksListInput, CodexHooksListResponse } from "../../shared/codex-hooks";
import { normalizePageChatPageIds, readPageChatActivitySummaryBatches } from "./page-chat-queries";
import { readPageChatActivitySummaries, readPageChatWindow } from "./page-chat-runtime";

const MCP_CATALOG_STALE_TIME_MS = 5 * 60_000;

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

export function pageChatActivitySummariesQueryOptions(pageIds: readonly string[]) {
  const normalizedPageIds = normalizePageChatPageIds(pageIds);
  return queryOptions({
    queryKey: queryKeys.pageChats.activity(normalizedPageIds),
    queryFn: (): Promise<PageChatActivitySummaryResult> =>
      readPageChatActivitySummaryBatches(
        { pageIds: normalizedPageIds },
        readPageChatActivitySummaries,
      ),
    enabled: normalizedPageIds.length > 0,
    staleTime: 30_000,
  });
}

export function pageChatWindowQueryOptions(input: Omit<PageChatWindowInput, "after">) {
  const pageId = input.pageId;
  const includeArchived = input.includeArchived === true;
  const first = input.first ?? 50;
  return infiniteQueryOptions({
    queryKey: queryKeys.pageChats.detail(pageId, includeArchived, first),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }): Promise<PageChatWindow> =>
      readPageChatWindow({
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
    queryFn: async () => await readDatabaseViewWindow(projectId, { first: 50 }),
  });
}

export function projectSessionSummariesQueryOptions(
  projectId: string | null,
  placementScope: NonNullable<ProjectSessionSummaryWindowInput["placementScope"]> = "all",
  order: NonNullable<ProjectSessionSummaryWindowInput["order"]> = "activity",
) {
  const queryKey = queryKeys.projectSessions.summaries(projectId, placementScope, order);
  return queryOptions({
    queryKey,
    queryFn: async ({ client, queryKey: activeQueryKey }): Promise<ProjectSessionSummaryWindow> => {
      const incoming = (await invoke("workspace:tasks:list", projectId, {
        first: 50,
        placementScope,
        order,
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

/**
 * What this Member may do in a chat on its Space's host beyond replying, decided by the Space's
 * Core with the rules it applies when the host carries each action out. A chat on this computer
 * belongs to its only Member, who may do all of it.
 */
export function hostedChatMemberActionsQueryOptions(
  sessionId: string | null,
  /** The Runs whose opening message the reader might edit; Core checks at most 200. */
  runIds: readonly string[] = [],
) {
  const latest = runIds.slice(-200);
  return queryOptions({
    queryKey: queryKeys.agentRuntime.memberActions(sessionId ?? "", latest),
    queryFn: () =>
      invoke("agent-runtime:session:member-actions", {
        sessionId: sessionId ?? "",
        runIds: latest,
      }),
    enabled: sessionId !== null && isHostedChat(),
    staleTime: 30_000,
  });
}

/** Why a chat its Inbox decision started has not run yet; Core reads it for any reader. */
export function projectSessionStartQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.projectSessions.start(sessionId),
    queryFn: () => invoke("project-sessions:start", sessionId),
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

export function automationsListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.automations.list(),
    queryFn: async () => {
      const response = (await invoke("automations:list")) as AutomationListResponse;
      return response.items;
    },
    staleTime: 30_000,
  });
}

export function automationDecisionsQueryOptions(automationId: string) {
  return queryOptions({
    queryKey: queryKeys.automations.decisions(automationId),
    queryFn: async () => {
      const response = await invoke("automations:decisions:list", { automationId, limit: 20 });
      return response.items;
    },
    staleTime: 10_000,
  });
}

export function automationRunsInboxQueryOptions(limit = 200) {
  return queryOptions({
    queryKey: queryKeys.automationRuns.inbox(limit),
    queryFn: () =>
      invoke("automations:runs:inbox-items", limit) as Promise<AutomationRunsInboxResponse>,
    staleTime: 30_000,
  });
}

export function codexModelsListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.codexModels.list(),
    queryFn: ({ signal }) => readModelCatalogForHost(DEFAULT_CODEX_HOST_ID, signal),
    staleTime: 60_000,
  });
}

export function codexComposerPluginsListQueryOptions(
  cwds: readonly string[],
  hostId = DEFAULT_CODEX_HOST_ID,
) {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)));

  return queryOptions({
    queryKey: queryKeys.codexComposerPlugins.list(normalizedCwds, hostId),
    queryFn: () =>
      invoke("codex:composer-plugins:list", { hostId, cwds: normalizedCwds }) as Promise<
        CodexComposerPlugin[]
      >,
    // This desktop's own Agent catalogs; a hosted chat's come from its Space host.
    enabled: !isHostedChat(),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function codexComposerSkillsListQueryOptions(
  cwds: readonly string[],
  hostId = DEFAULT_CODEX_HOST_ID,
) {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)));

  return queryOptions({
    queryKey: queryKeys.codexComposerSkills.list(normalizedCwds, hostId),
    queryFn: () =>
      invoke("codex:composer-skills:list", { hostId, cwds: normalizedCwds }) as Promise<
        CodexComposerSkill[]
      >,
    enabled: !isHostedChat(),
    retry: false,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function codexComposerSitesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.codexComposerSites.list(),
    queryFn: () => invoke("codex:composer-sites:list") as Promise<CodexComposerSiteListResult>,
    enabled: !isHostedChat(),
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
    enabled: !isHostedChat(),
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
    // A hosted chat's folder is on its Space host; this computer has no repository there.
    enabled: cwd.trim().length > 0 && !isHostedChat(),
    staleTime: 5 * 60_000,
  });
}

export function localPathPresentationContextQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.shell.pathContext(),
    queryFn: () => invoke("shell:path-context:get") as Promise<LocalPathPresentationContext>,
    // Paths in a hosted chat belong to its Space host, never to this desktop's home.
    enabled: !isHostedChat(),
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
    enabled: !isHostedChat(),
    staleTime: MCP_CATALOG_STALE_TIME_MS,
  });
}

export function mcpAppsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.mcp.apps(),
    queryFn: () => invoke("codex:mcp-apps:list") as Promise<ProtocolAppInfo[]>,
    enabled: !isHostedChat(),
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

/** Listings read again when a tree shows them after five seconds; nothing watches the folder. */
export function workspaceDirectoryQueryOptions(input: WorkspaceDirectoryEntriesInput) {
  return queryOptions({
    queryKey: queryKeys.workspaceFiles.directory(input),
    queryFn: () =>
      invoke("workspace-directory-entries", input) as Promise<WorkspaceDirectoryEntriesResult>,
    staleTime: 5_000,
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

export function workspaceFileBinaryQueryOptions(
  input: WorkspaceFileRequest,
  /** A conversation's reads are kept apart per source, so a new source never sees older bytes. */
  cacheScope?: { conversationId: string | null; sourceIdentity: string },
) {
  return queryOptions({
    queryKey: cacheScope
      ? queryKeys.conversationImages.file(
          input.hostId ?? "local",
          cacheScope.conversationId,
          cacheScope.sourceIdentity,
          input.path,
        )
      : queryKeys.workspaceFiles.binary(input),
    queryFn: () => invoke("read-file-binary", input) as Promise<WorkspaceFileBinaryReadResult>,
  });
}
