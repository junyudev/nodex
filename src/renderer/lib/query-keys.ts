import { spaceQueryKey } from "./renderer-space";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { AgentRuntimeAttachmentReference } from "../../shared/agent-runtime-attachments";
import type {
  ProjectSessionSummaryWindowInput,
  ProtocolMcpResourceReadParams,
} from "../../shared/types";
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
    providers: () => spaceQueryKey(["agentRuntime", "providers"] as const),
    claudeUsage: () => spaceQueryKey(["agentRuntime", "claudeUsage"] as const),
    memberActionsAll: () => spaceQueryKey(["agentRuntime", "memberActions"] as const),
    memberActionsOf: (sessionId: string) =>
      spaceQueryKey(["agentRuntime", "memberActions", sessionId] as const),
    memberActions: (sessionId: string, runIds: readonly string[]) =>
      spaceQueryKey(["agentRuntime", "memberActions", sessionId, runIds] as const),
  },
  projects: {
    all: () => spaceQueryKey(["projects"] as const),
    bootstrap: () => spaceQueryKey(["projects", "bootstrap"] as const),
    lists: () => spaceQueryKey(["projects", "list"] as const),
    list: (includeArchived = false) =>
      spaceQueryKey(["projects", "list", includeArchived] as const),
    detail: (projectId: string) => spaceQueryKey(["projects", "detail", projectId] as const),
  },
  pageKeys: {
    all: () => spaceQueryKey(["pageKeys"] as const),
    prefixPreview: (
      projectId: string | undefined,
      databaseId: string | undefined,
      nameHint: string,
      requestedPrefix: string | undefined,
    ) =>
      spaceQueryKey([
        "pageKeys",
        "prefixPreview",
        normalizeNullable(projectId),
        normalizeNullable(databaseId),
        nameHint,
        normalizeNullable(requestedPrefix),
      ] as const),
    namespace: (databaseId: string) =>
      spaceQueryKey(["pageKeys", "namespace", databaseId] as const),
  },
  pageSearch: {
    destinations: (projectIds: readonly string[], normalizedQuery: string) =>
      spaceQueryKey([
        "pageSearch",
        "destinations",
        [...projectIds].sort(),
        normalizedQuery,
      ] as const),
  },
  destinationStages: {
    byProject: (projectId: string, libraryId: string, databaseId: string, viewId: string | null) =>
      spaceQueryKey(["destinationStages", projectId, libraryId, databaseId, viewId] as const),
  },
  boards: {
    all: () => spaceQueryKey(["boards"] as const),
    byProject: (projectId: string) => spaceQueryKey(["boards", "byProject", projectId] as const),
  },
  blockDocuments: {
    all: () => spaceQueryKey(["blockDocuments"] as const),
    owned: (routingContext: ContentRoutingContext, ownerBlockId: string) =>
      spaceQueryKey(["blockDocuments", "owned", routingContext, ownerBlockId] as const),
  },
  pageTargets: {
    byId: (routingContext: ContentRoutingContext, targetBlockId: string) =>
      spaceQueryKey(["pageTargets", routingContext, targetBlockId] as const),
  },
  pageOwnershipPaths: {
    all: () => spaceQueryKey(["pageOwnershipPaths"] as const),
    byScope: (routingContext: ContentRoutingContext) =>
      spaceQueryKey(["pageOwnershipPaths", routingContext] as const),
    byPage: (routingContext: ContentRoutingContext, targetPageId: string) =>
      spaceQueryKey(["pageOwnershipPaths", routingContext, targetPageId] as const),
  },
  blockReferences: {
    databaseView: (
      routingContext: ContentRoutingContext,
      databaseViewId: string,
      hostBlockId?: string,
    ) =>
      spaceQueryKey([
        "blockReferences",
        "databaseView",
        routingContext,
        databaseViewId,
        normalizeNullable(hostBlockId),
      ] as const),
  },
  libraryDatabases: {
    all: () => spaceQueryKey(["libraryDatabases"] as const),
    descriptor: (projectId: string | undefined, databaseId: string | null, viewId: string | null) =>
      spaceQueryKey([
        "libraryDatabases",
        "descriptor",
        normalizeNullable(projectId),
        normalizeNullable(databaseId),
        normalizeNullable(viewId),
      ] as const),
    view: (projectId: string | undefined, viewId: string | null) =>
      spaceQueryKey([
        "libraryDatabases",
        "view",
        normalizeNullable(projectId),
        normalizeNullable(viewId),
      ] as const),
  },
  library: {
    all: () => spaceQueryKey(["libraryNavigation"] as const),
    metadata: () => spaceQueryKey(["libraryNavigation", "metadata"] as const),
    children: (parentKey: string, input: unknown) =>
      spaceQueryKey(["libraryNavigation", "children", parentKey, input] as const),
    childrenPages: (parentKey: string, input: unknown) =>
      spaceQueryKey(["libraryNavigation", "childrenPages", parentKey, input] as const),
    standaloneRoots: (input: unknown) =>
      spaceQueryKey(["libraryNavigation", "standaloneRoots", input] as const),
    standaloneRootPages: (input: unknown) =>
      spaceQueryKey(["libraryNavigation", "standaloneRootPages", input] as const),
    catalog: (input: unknown) => spaceQueryKey(["libraryNavigation", "catalog", input] as const),
    catalogPages: (input: unknown) =>
      spaceQueryKey(["libraryNavigation", "catalogPages", input] as const),
    moveDestinations: (target: unknown, input: unknown) =>
      spaceQueryKey(["libraryNavigation", "moveDestinations", target, input] as const),
    moveDestinationPages: (target: unknown, input: unknown) =>
      spaceQueryKey(["libraryNavigation", "moveDestinationPages", target, input] as const),
    pageRelocationDestinations: (pageId: string, input: unknown) =>
      spaceQueryKey(["libraryNavigation", "pageRelocationDestinations", pageId, input] as const),
    path: (target: unknown) => spaceQueryKey(["libraryNavigation", "path", target] as const),
    canvasTarget: (canvasId: string) =>
      spaceQueryKey(["libraryNavigation", "canvasTarget", canvasId] as const),
    pageDetail: (pageId: string) => spaceQueryKey(["libraryPages", "detail", pageId] as const),
    pageDocument: (pageId: string) => spaceQueryKey(["libraryPages", "document", pageId] as const),
    pageBacklinks: (routingContext: unknown, pageId: string) =>
      spaceQueryKey(["libraryPages", "backlinks", routingContext, pageId] as const),
    pageFiles: (routingContext: unknown, pageId: string) =>
      spaceQueryKey(["libraryPages", "files", routingContext, pageId] as const),
    pageFilesWindow: (routingContext: unknown, pageId: string, query: string) =>
      spaceQueryKey(["libraryPages", "files", routingContext, pageId, query] as const),
  },
  libraryFiles: {
    file: (routingContext: unknown, fileId: string) =>
      spaceQueryKey(["libraryFiles", "file", routingContext, fileId] as const),
    all: () => spaceQueryKey(["libraryFiles"] as const),
    catalog: (routingContext: unknown, lifecycle: string, usage: string, query: string) =>
      spaceQueryKey(["libraryFiles", "catalog", routingContext, lifecycle, usage, query] as const),
    usages: (routingContext: unknown, fileId: string) =>
      spaceQueryKey(["libraryFiles", "usages", routingContext, fileId] as const),
    versions: (routingContext: unknown, fileId: string) =>
      spaceQueryKey(["libraryFiles", "versions", routingContext, fileId] as const),
  },
  projectSessions: {
    all: () => spaceQueryKey(["projectSessions"] as const),
    summaries: (
      projectId: string | null,
      placementScope: NonNullable<ProjectSessionSummaryWindowInput["placementScope"]> = "all",
      order: NonNullable<ProjectSessionSummaryWindowInput["order"]> = "activity",
    ) =>
      spaceQueryKey([
        "projectSessions",
        "summaries",
        normalizeNullable(projectId),
        placementScope,
        order,
      ] as const),
    detail: (sessionId: string) => spaceQueryKey(["projectSessions", "detail", sessionId] as const),
    start: (sessionId: string) => spaceQueryKey(["projectSessions", "start", sessionId] as const),
    sideChats: (sourceSessionId: string) =>
      spaceQueryKey(["projectSessions", "sideChats", sourceSessionId] as const),
  },
  projectActivity: {
    all: () => spaceQueryKey(["projectActivity"] as const),
    summaries: (projectIds: readonly string[]) =>
      spaceQueryKey(["projectActivity", "summaries", ...[...projectIds].sort()] as const),
  },
  inbox: {
    all: () => spaceQueryKey(["inbox"] as const),
    summary: (scope: string) => spaceQueryKey(["inbox", "summary", scope] as const),
    counts: () => spaceQueryKey(["inbox", "counts"] as const),
    window: (scope: string) => spaceQueryKey(["inbox", "window", scope] as const),
    later: (scope: string) => spaceQueryKey(["inbox", "later", scope] as const),
    settings: () => spaceQueryKey(["inbox", "settings"] as const),
    activity: (scope: string, filter: string) =>
      spaceQueryKey(["inbox", "activity", scope, filter] as const),
  },
  conversationIdentity: {
    all: () => spaceQueryKey(["conversationIdentity"] as const),
    thread: (threadId: string) => spaceQueryKey(["conversationIdentity", threadId] as const),
  },
  threadExecution: {
    all: () => spaceQueryKey(["threadExecution"] as const),
    location: (threadId: string) =>
      spaceQueryKey(["threadExecution", "location", threadId] as const),
  },
  pageChats: {
    all: () => spaceQueryKey(["pageChats"] as const),
    activity: (pageIds: readonly string[]) =>
      spaceQueryKey(["pageChats", "activity", ...normalizePageChatPageIds(pageIds)] as const),
    detail: (pageId: string, includeArchived = false, first = 50) =>
      spaceQueryKey(["pageChats", "detail", pageId, includeArchived, first] as const),
  },
  settings: {
    all: () => spaceQueryKey(["settings"] as const),
    windowRestore: () => spaceQueryKey(["settings", "windowRestore"] as const),
    threadNotifications: () => spaceQueryKey(["settings", "threadNotifications"] as const),
    thirdPartyNotices: () => spaceQueryKey(["settings", "thirdPartyNotices"] as const),
    commandKeymap: () => spaceQueryKey(["codex-command-keymap-state"] as const),
  },
  git: {
    all: () => spaceQueryKey(["git"] as const),
    branchState: (cwd: string) => spaceQueryKey(["git", "branchState", cwd] as const),
    repositoryIdentity: (cwd: string) => spaceQueryKey(["git", "repositoryIdentity", cwd] as const),
  },
  shell: {
    pathContext: () => spaceQueryKey(["shell", "pathContext"] as const),
  },
  localEnvironments: {
    all: () => spaceQueryKey(["localEnvironments"] as const),
    options: (projectId: string) =>
      spaceQueryKey(["localEnvironments", "options", projectId] as const),
    configs: (projectId: string) =>
      spaceQueryKey(["localEnvironments", "configs", projectId] as const),
    configScope: (projectId: string) =>
      spaceQueryKey(["localEnvironments", "config", projectId] as const),
    config: (projectId: string, configPath?: string | null) =>
      spaceQueryKey([
        "localEnvironments",
        "config",
        projectId,
        normalizeNullable(configPath),
      ] as const),
  },
  mcp: {
    all: () => spaceQueryKey(["mcp"] as const),
    apps: () => spaceQueryKey(["mcp", "apps"] as const),
    statuses: () => spaceQueryKey(["mcp", "statuses"] as const),
    resource: (params: ProtocolMcpResourceReadParams) =>
      spaceQueryKey([
        "mcp",
        "resource",
        normalizeNullable(params.threadId),
        normalizeNullable(params.originCallId),
        normalizeNullable(params.connectorId),
        params.server,
        params.uri,
      ] as const),
  },
  codexSidebar: {
    all: () => spaceQueryKey(["codexSidebar"] as const),
    snapshot: () => spaceQueryKey(["codexSidebar", "snapshot"] as const),
    pinnedThreads: () => spaceQueryKey(["codexSidebar", "pinnedThreads"] as const),
  },
  codexModels: {
    all: () => spaceQueryKey(["codexModels"] as const),
    list: () => spaceQueryKey(["codexModels", "list"] as const),
  },
  codexComposerPlugins: {
    all: () => spaceQueryKey(["codexComposerPlugins"] as const),
    list: (cwds: readonly string[], hostId = DEFAULT_CODEX_HOST_ID) =>
      spaceQueryKey(["codexComposerPlugins", "list", hostId, ...cwds] as const),
  },
  codexComposerSkills: {
    all: () => spaceQueryKey(["codexComposerSkills"] as const),
    list: (cwds: readonly string[], hostId = DEFAULT_CODEX_HOST_ID) =>
      spaceQueryKey(["codexComposerSkills", "list", hostId, ...cwds] as const),
  },
  codexComposerSites: {
    all: () => spaceQueryKey(["codexComposerSites"] as const),
    list: () => spaceQueryKey(["codexComposerSites", "list"] as const),
  },
  codexComposerChatGptConversations: {
    all: () => spaceQueryKey(["codexComposerChatGptConversations"] as const),
    list: (query: string) =>
      spaceQueryKey(["codexComposerChatGptConversations", "list", query] as const),
  },
  codexExperimentalFeatures: {
    all: () => spaceQueryKey(["codexExperimentalFeatures"] as const),
    list: () => spaceQueryKey(["codexExperimentalFeatures", "list"] as const),
  },
  codexHooks: {
    all: () => spaceQueryKey(["codexHooks"] as const),
    host: (hostId: string) => spaceQueryKey(["codexHooks", hostId] as const),
    list: (hostId: string, cwds: readonly string[]) =>
      spaceQueryKey(["codexHooks", hostId, cwds] as const),
  },
  automations: {
    all: () => spaceQueryKey(["automations"] as const),
    list: () => spaceQueryKey(["automations", "list"] as const),
    decisions: (automationId: string) =>
      spaceQueryKey(["automations", "decisions", automationId] as const),
  },
  sources: {
    all: () => spaceQueryKey(["sources"] as const),
    automationOptions: () => spaceQueryKey(["sources", "automationOptions"] as const),
  },
  automationRuns: {
    all: () => spaceQueryKey(["automationRuns"] as const),
    inbox: (limit: number) => spaceQueryKey(["automationRuns", "inbox", limit] as const),
  },
  codexBackgroundTerminals: {
    all: () => spaceQueryKey(["codexBackgroundTerminals"] as const),
    processManager: (threads: readonly { threadId: string; title: string }[]) =>
      spaceQueryKey([
        "codexBackgroundTerminals",
        "processManager",
        ...threads.map((thread) => `${thread.threadId}\u0000${thread.title}`),
      ] as const),
  },
  workspaceFiles: {
    all: () => spaceQueryKey(["workspaceFiles"] as const),
    directory: (input: WorkspaceDirectoryEntriesInput) =>
      spaceQueryKey([
        "workspaceFiles",
        "directory",
        normalizeHostId(input.hostId),
        input.workspaceRoot,
        input.directoryPath ?? "",
        input.includeHidden ?? false,
        input.directoriesOnly ?? false,
      ] as const),
    metadata: (input: WorkspaceFileMetadataInput) =>
      spaceQueryKey([
        "workspaceFiles",
        "metadata",
        normalizeHostId(input.hostId),
        input.path,
        input.contentSampleByteLimit ?? 0,
        input.contentSampleMaxFileBytes ?? 0,
      ] as const),
    text: (input: WorkspaceFileTextReadInput) =>
      spaceQueryKey([
        "workspaceFiles",
        "text",
        normalizeHostId(input.hostId),
        input.path,
        input.maxBytes,
      ] as const),
    binary: (input: WorkspaceFileRequest) =>
      spaceQueryKey([
        "workspaceFiles",
        "binary",
        normalizeHostId(input.hostId),
        input.path,
      ] as const),
  },
  codexConversationImageAssets: {
    resolve: (pointer: string) => spaceQueryKey(["file", "image-src", pointer, "codex"] as const),
  },
  conversationImages: {
    file: (hostId: string, conversationId: string | null, sourceIdentity: string, path: string) =>
      spaceQueryKey([
        "workspaceFiles",
        "binary",
        hostId,
        path,
        conversationId,
        sourceIdentity,
      ] as const),
    managed: (hostId: string, conversationId: string | null, source: string) =>
      spaceQueryKey(["conversationImages", "managed", hostId, conversationId, source] as const),
    attachment: (
      hostId: string,
      conversationId: string | null,
      sourceIdentity: string,
      reference: AgentRuntimeAttachmentReference,
    ) =>
      spaceQueryKey([
        "conversationImages",
        "attachment",
        hostId,
        conversationId,
        sourceIdentity,
        reference,
      ] as const),
  },
};
