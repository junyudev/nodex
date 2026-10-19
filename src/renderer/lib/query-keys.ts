import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { ProtocolMcpResourceReadParams } from "../../shared/types";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type {
  WorkspaceDirectoryEntriesInput,
  WorkspaceFileMetadataInput,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
} from "./types";
import { normalizePageChatPageIds } from "./page-chat-queries";

function normalizeHostId(hostId: string | undefined): string {
  return hostId ?? "local";
}

function normalizeNullable(value: string | null | undefined): string {
  return value ?? "";
}

export const queryKeys = {
  agentRuntime: {
    providers: () => ["agentRuntime", "providers"] as const,
  },
  projects: {
    all: () => ["projects"] as const,
    lists: () => ["projects", "list"] as const,
    list: (includeArchived = false) => ["projects", "list", includeArchived] as const,
    detail: (projectId: string) => ["projects", "detail", projectId] as const,
  },
  pageKeys: {
    all: () => ["pageKeys"] as const,
    prefixPreview: (
      projectId: string | undefined,
      databaseId: string | undefined,
      nameHint: string,
      requestedPrefix: string | undefined,
    ) =>
      [
        "pageKeys",
        "prefixPreview",
        normalizeNullable(projectId),
        normalizeNullable(databaseId),
        nameHint,
        normalizeNullable(requestedPrefix),
      ] as const,
    namespace: (databaseId: string) => ["pageKeys", "namespace", databaseId] as const,
  },
  pageSearch: {
    destinations: (projectIds: readonly string[], normalizedQuery: string) =>
      ["pageSearch", "destinations", [...projectIds].sort(), normalizedQuery] as const,
  },
  boards: {
    all: () => ["boards"] as const,
    byProject: (projectId: string) => ["boards", "byProject", projectId] as const,
  },
  blockDocuments: {
    all: () => ["blockDocuments"] as const,
    owned: (routingContext: ContentRoutingContext, ownerBlockId: string) =>
      ["blockDocuments", "owned", routingContext, ownerBlockId] as const,
  },
  pageTargets: {
    byId: (routingContext: ContentRoutingContext, targetBlockId: string) =>
      ["pageTargets", routingContext, targetBlockId] as const,
  },
  pageOwnershipPaths: {
    all: () => ["pageOwnershipPaths"] as const,
    byScope: (routingContext: ContentRoutingContext) =>
      ["pageOwnershipPaths", routingContext] as const,
    byPage: (routingContext: ContentRoutingContext, targetPageId: string) =>
      ["pageOwnershipPaths", routingContext, targetPageId] as const,
  },
  blockReferences: {
    databaseView: (
      routingContext: ContentRoutingContext,
      databaseViewId: string,
      hostBlockId?: string,
    ) =>
      [
        "blockReferences",
        "databaseView",
        routingContext,
        databaseViewId,
        normalizeNullable(hostBlockId),
      ] as const,
  },
  libraryDatabases: {
    all: () => ["libraryDatabases"] as const,
    descriptor: (projectId: string | undefined, databaseId: string | null, viewId: string | null) =>
      [
        "libraryDatabases",
        "descriptor",
        normalizeNullable(projectId),
        normalizeNullable(databaseId),
        normalizeNullable(viewId),
      ] as const,
    view: (projectId: string | undefined, viewId: string | null) =>
      [
        "libraryDatabases",
        "view",
        normalizeNullable(projectId),
        normalizeNullable(viewId),
      ] as const,
  },
  library: {
    all: () => ["libraryNavigation"] as const,
    metadata: () => ["libraryNavigation", "metadata"] as const,
    children: (parentKey: string, input: unknown) =>
      ["libraryNavigation", "children", parentKey, input] as const,
    childrenPages: (parentKey: string, input: unknown) =>
      ["libraryNavigation", "childrenPages", parentKey, input] as const,
    standaloneRoots: (input: unknown) => ["libraryNavigation", "standaloneRoots", input] as const,
    standaloneRootPages: (input: unknown) =>
      ["libraryNavigation", "standaloneRootPages", input] as const,
    catalog: (input: unknown) => ["libraryNavigation", "catalog", input] as const,
    catalogPages: (input: unknown) => ["libraryNavigation", "catalogPages", input] as const,
    moveDestinations: (target: unknown, input: unknown) =>
      ["libraryNavigation", "moveDestinations", target, input] as const,
    moveDestinationPages: (target: unknown, input: unknown) =>
      ["libraryNavigation", "moveDestinationPages", target, input] as const,
    pageRelocationDestinations: (pageId: string, input: unknown) =>
      ["libraryNavigation", "pageRelocationDestinations", pageId, input] as const,
    path: (target: unknown) => ["libraryNavigation", "path", target] as const,
    canvasTarget: (canvasId: string) => ["libraryNavigation", "canvasTarget", canvasId] as const,
    pageDetail: (pageId: string) => ["libraryPages", "detail", pageId] as const,
    pageDocument: (pageId: string) => ["libraryPages", "document", pageId] as const,
    pageBacklinks: (routingContext: unknown, pageId: string) =>
      ["libraryPages", "backlinks", routingContext, pageId] as const,
    pageFiles: (routingContext: unknown, pageId: string) =>
      ["libraryPages", "files", routingContext, pageId] as const,
    pageFilesWindow: (routingContext: unknown, pageId: string, query: string) =>
      ["libraryPages", "files", routingContext, pageId, query] as const,
  },
  libraryFiles: {
    file: (routingContext: unknown, fileId: string) =>
      ["libraryFiles", "file", routingContext, fileId] as const,
    all: () => ["libraryFiles"] as const,
    catalog: (routingContext: unknown, lifecycle: string, usage: string, query: string) =>
      ["libraryFiles", "catalog", routingContext, lifecycle, usage, query] as const,
    usages: (routingContext: unknown, fileId: string) =>
      ["libraryFiles", "usages", routingContext, fileId] as const,
    versions: (routingContext: unknown, fileId: string) =>
      ["libraryFiles", "versions", routingContext, fileId] as const,
  },
  projectSessions: {
    all: () => ["projectSessions"] as const,
    summaries: (projectId: string | null) =>
      ["projectSessions", "summaries", normalizeNullable(projectId)] as const,
    detail: (sessionId: string) => ["projectSessions", "detail", sessionId] as const,
  },
  projectActivity: {
    all: () => ["projectActivity"] as const,
    summaries: (projectIds: readonly string[]) =>
      ["projectActivity", "summaries", ...[...projectIds].sort()] as const,
  },
  inbox: {
    all: () => ["inbox"] as const,
    summary: (scope: string) => ["inbox", "summary", scope] as const,
    counts: () => ["inbox", "counts"] as const,
    window: (scope: string, filter: string) => ["inbox", "window", scope, filter] as const,
    settings: () => ["inbox", "settings"] as const,
  },
  threadExecution: {
    all: () => ["threadExecution"] as const,
    location: (threadId: string) => ["threadExecution", "location", threadId] as const,
  },
  pageChats: {
    all: () => ["pageChats"] as const,
    activity: (pageAccessProjectId: string, pageIds: readonly string[]) =>
      ["pageChats", "activity", pageAccessProjectId, ...normalizePageChatPageIds(pageIds)] as const,
    detail: (pageAccessProjectId: string, pageId: string, includeArchived = false, first = 50) =>
      ["pageChats", "detail", pageAccessProjectId, pageId, includeArchived, first] as const,
  },
  settings: {
    all: () => ["settings"] as const,
    windowRestore: () => ["settings", "windowRestore"] as const,
    threadNotifications: () => ["settings", "threadNotifications"] as const,
    thirdPartyNotices: () => ["settings", "thirdPartyNotices"] as const,
    commandKeymap: () => ["codex-command-keymap-state"] as const,
  },
  git: {
    all: () => ["git"] as const,
    branchState: (cwd: string) => ["git", "branchState", cwd] as const,
    repositoryIdentity: (cwd: string) => ["git", "repositoryIdentity", cwd] as const,
  },
  shell: {
    pathContext: () => ["shell", "pathContext"] as const,
  },
  localEnvironments: {
    all: () => ["localEnvironments"] as const,
    options: (projectId: string) => ["localEnvironments", "options", projectId] as const,
    configs: (projectId: string) => ["localEnvironments", "configs", projectId] as const,
    configScope: (projectId: string) => ["localEnvironments", "config", projectId] as const,
    config: (projectId: string, configPath?: string | null) =>
      ["localEnvironments", "config", projectId, normalizeNullable(configPath)] as const,
  },
  mcp: {
    all: () => ["mcp"] as const,
    apps: () => ["mcp", "apps"] as const,
    statuses: () => ["mcp", "statuses"] as const,
    resource: (params: ProtocolMcpResourceReadParams) =>
      [
        "mcp",
        "resource",
        normalizeNullable(params.threadId),
        normalizeNullable(params.originCallId),
        normalizeNullable(params.connectorId),
        params.server,
        params.uri,
      ] as const,
  },
  codexSidebar: {
    all: () => ["codexSidebar"] as const,
    snapshot: () => ["codexSidebar", "snapshot"] as const,
    pinnedThreads: () => ["codexSidebar", "pinnedThreads"] as const,
  },
  codexModels: {
    all: () => ["codexModels"] as const,
    list: () => ["codexModels", "list"] as const,
  },
  codexComposerPlugins: {
    all: () => ["codexComposerPlugins"] as const,
    list: (cwds: readonly string[], hostId = DEFAULT_CODEX_HOST_ID) =>
      ["codexComposerPlugins", "list", hostId, ...cwds] as const,
  },
  codexComposerSkills: {
    all: () => ["codexComposerSkills"] as const,
    list: (cwds: readonly string[], hostId = DEFAULT_CODEX_HOST_ID) =>
      ["codexComposerSkills", "list", hostId, ...cwds] as const,
  },
  codexComposerSites: {
    all: () => ["codexComposerSites"] as const,
    list: () => ["codexComposerSites", "list"] as const,
  },
  codexComposerChatGptConversations: {
    all: () => ["codexComposerChatGptConversations"] as const,
    list: (query: string) => ["codexComposerChatGptConversations", "list", query] as const,
  },
  codexExperimentalFeatures: {
    all: () => ["codexExperimentalFeatures"] as const,
    list: () => ["codexExperimentalFeatures", "list"] as const,
  },
  codexHooks: {
    all: () => ["codexHooks"] as const,
    host: (hostId: string) => ["codexHooks", hostId] as const,
    list: (hostId: string, cwds: readonly string[]) => ["codexHooks", hostId, cwds] as const,
  },
  codexScheduledAutomations: {
    all: () => ["codexScheduledAutomations"] as const,
    list: () => ["codexScheduledAutomations", "list"] as const,
  },
  codexAutomationRuns: {
    all: () => ["codexAutomationRuns"] as const,
    inbox: (limit: number) => ["codexAutomationRuns", "inbox", limit] as const,
  },
  codexBackgroundTerminals: {
    all: () => ["codexBackgroundTerminals"] as const,
    processManager: (threads: readonly { threadId: string; title: string }[]) =>
      [
        "codexBackgroundTerminals",
        "processManager",
        ...threads.map((thread) => `${thread.threadId}\u0000${thread.title}`),
      ] as const,
  },
  workspaceFiles: {
    all: () => ["workspaceFiles"] as const,
    directory: (input: WorkspaceDirectoryEntriesInput) =>
      [
        "workspaceFiles",
        "directory",
        normalizeHostId(input.hostId),
        input.workspaceRoot,
        input.directoryPath ?? "",
        input.includeHidden ?? false,
        input.directoriesOnly ?? false,
      ] as const,
    metadata: (input: WorkspaceFileMetadataInput) =>
      [
        "workspaceFiles",
        "metadata",
        normalizeHostId(input.hostId),
        input.path,
        input.contentSampleByteLimit ?? 0,
        input.contentSampleMaxFileBytes ?? 0,
      ] as const,
    text: (input: WorkspaceFileTextReadInput) =>
      [
        "workspaceFiles",
        "text",
        normalizeHostId(input.hostId),
        input.path,
        input.maxBytes,
      ] as const,
    binary: (input: WorkspaceFileRequest) =>
      ["workspaceFiles", "binary", normalizeHostId(input.hostId), input.path] as const,
  },
  codexConversationImageAssets: {
    resolve: (pointer: string) => ["file", "image-src", pointer, "codex"] as const,
  },
};
