import { live as spaceAdministration } from "./SpaceAdministrationIpc";
import { live as memberAttention } from "./RemoteMemberAttentionIpc";
import { live as turnNotifications } from "../host-runtime/NodexEntryNotifications";
import { projectAutomation } from "../../host/automation-application/AutomationProjection";
import { live as applicationProjection } from "./RemoteSpaceProjection";
import { spacePathKey } from "./space-path-key";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { join } from "node:path";
import { MainConfig } from "../app/MainConfig";
import { CoreModules, live as coreModulesLive } from "../core-runtime/CoreModules";
import { live as projectionDeliveryLive } from "../core-runtime/ProjectionDeliveryRuntime";
import { CoreEventHub, live as coreEventHubLive } from "../core-runtime/CoreEventHub";
import { UnreadBadge } from "../host-runtime/UnreadBadgeRuntime";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { live as documentLive } from "../core-runtime/DocumentLiveRuntime";
import { desktopDocumentSessionRuntimeLive } from "../core-client/desktop-document-sync-bridge";
import { rendererLocalCommitApply } from "../core-client/types";
import { acceptWorkInputSchema } from "../../shared/work-application";
import { LibraryModule, live as libraryLive } from "../library-application/LibraryModule";
import { live as databaseLive } from "../database-application/DatabaseModule";
import { live as exportsLive } from "../library-application/FileExportRuntime";
import { live as historyLive } from "../host-runtime/EditorHistoryRuntime";
import { live as rendererClientsLive } from "../host-runtime/RendererClientRuntime";
import { liveForSpace as pageHtmlLive } from "../host-runtime/PageFileHtmlRuntime";
import { liveForSpace as notifierLive } from "../platform/electron/DatabaseNotifications";
import { ProjectWorkspace, live as workspaceLive } from "../project-application/ProjectWorkspace";
import { ElectronIpc, ElectronSpaceIpc } from "../platform/electron/ElectronIpc";
import * as CoreMutationIpc from "../ipc/handlers/CoreMutationIpc";
import * as CoreDocumentIpc from "../ipc/handlers/CoreDocumentIpc";
import * as DatabaseProjectionIpc from "../ipc/handlers/DatabaseProjectionIpc";
import * as ProjectionDeliveryIpc from "../ipc/handlers/ProjectionDeliveryIpc";
import * as PageSearchIpc from "../ipc/handlers/PageSearchIpc";
import * as DocumentRecoveryIpc from "../ipc/handlers/DocumentRecoveryIpc";
import * as FilesIpc from "../ipc/handlers/FilesIpc";
import * as StructuralClipboardIpc from "../ipc/handlers/StructuralClipboardIpc";
import { live as structuralClipboardLive } from "../host-runtime/StructuralClipboardRuntime";
import { createOperationId } from "../core-runtime/operation-identity";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import * as PageFileHtmlIpc from "../ipc/handlers/PageFileHtmlIpc";
import {
  archivedRuntimeChatItem,
  projectCoreWorkspaceTask,
} from "../codex-application/CodexThreadCatalogProjection";
import type { CodexSidebarSnapshot } from "../../shared/types";
import { SpaceConnectionRegistry } from "./SpaceConnectionRegistry";
import { makeSpaceIpcCollector } from "./SpaceIpcCollector";
import * as RemoteHostIpc from "./RemoteHostIpc";
import * as RemotePresenceReporter from "./RemotePresenceReporter";
import * as ChatMemberActionsIpc from "../ipc/handlers/ChatMemberActionsIpc";
import {
  inboxCountsFromCore,
  activityWindowFromCore,
  inboxItemFromCore,
  inboxScopeToCore,
  inboxSummaryFromCore,
  inboxPageBasisToCore,
} from "../core-client/inbox-adapter";
import {
  ActivityWindowInputSchema,
  InboxSummaryInputSchema,
  InboxWindowInputSchema,
  InboxEditInputSchema,
  InboxPageIdsInputSchema,
  InboxSetStateInputSchema,
  InboxSetKindInputSchema,
  InboxSetImportantInputSchema,
  InboxUndoInputSchema,
  RetryProblemInputSchema,
} from "../../shared/schemas/inbox";

export class RemoteSpaceDesktop extends Context.Service<
  RemoteSpaceDesktop,
  ReturnType<typeof makeSpaceIpcCollector> & {
    readonly library: LibraryModule["Service"];
    readonly projects: ProjectWorkspace["Service"];
  }
>()("nodex/main/space-connections/RemoteSpaceDesktop") {}

const readModels = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const projects = yield* ProjectWorkspace;
    const core = yield* CoreModules;
    yield* ipc.handleQuery("automations:list", () =>
      core.automation
        .read({
          kind: "automations",
          include_deleted: false,
          search_query: null,
          window: { after: null, first: 200 },
        })
        .pipe(
          Effect.map((read) => {
            if (read.value.kind !== "automations" || read.value.window.next_cursor)
              throw new Error("Active Automations exceeded the bounded collection");
            return { items: read.value.window.items.map(projectAutomation) };
          }),
        ),
    );
    yield* ipc.handleQuery("work:turn", (_, pageId) =>
      core.workspace.read({ kind: "page_turn", page_id: pageId }, undefined, null).pipe(
        Effect.map((read) => {
          if (read.value.kind !== "page_turn") throw new Error("Invalid Page Turn");
          return {
            turn: read.value.turn,
            activeChat: read.value.active_chat ?? null,
            storeEpoch: read.store_epoch,
            commitSeq: read.commit_head,
          };
        }),
      ),
    );
    yield* ipc.handleLocalCommitCommand("work:accept", (_, input) =>
      Effect.gen(function* () {
        const parsed = acceptWorkInputSchema.parse(input);
        const apply = yield* core.workspace.apply(
          {
            operationId: parsed.operationId,
            intent: {
              kind: "accept_page_work",
              page_id: parsed.pageId,
              ...(parsed.turnEpisode ? { expected_turn_episode: parsed.turnEpisode } : {}),
            },
          },
          undefined,
          null,
        );
        return {
          ok: true as const,
          value: undefined,
          localCommit: rendererLocalCommitApply(apply),
        };
      }),
    );
    const mutate = (
      intent: ProjectWorkspaceApplyInput["intent"],
      operationId = createOperationId("inbox.person"),
    ) =>
      core.workspace.apply({ operationId, intent }, undefined, null).pipe(
        Effect.map((apply) => ({
          ok: true as const,
          value: undefined,
          localCommit: rendererLocalCommitApply(apply),
        })),
      );
    yield* ipc.handleLocalCommitCommand("inbox:edit", (_, input) => {
      const parsed = InboxEditInputSchema.parse(input);
      return mutate({
        kind: "edit_inbox_message",
        page_id: parsed.pageId,
        basis: inboxPageBasisToCore(parsed.basis),
        original_body: parsed.originalBody,
        body: parsed.body,
      });
    });
    yield* ipc.handleLocalCommitCommand("inbox:keep", (_, input) => {
      const parsed = InboxPageIdsInputSchema.parse(input);
      return mutate({ kind: "keep_inbox_entries", page_ids: parsed.pageIds });
    });
    yield* ipc.handleLocalCommitCommand("inbox:delete", (_, input) => {
      const parsed = InboxPageIdsInputSchema.parse(input);
      return mutate({ kind: "delete_inbox_messages", page_ids: parsed.pageIds });
    });
    yield* ipc.handleLocalCommitCommand("inbox:set-state", (_, input) => {
      const parsed = InboxSetStateInputSchema.parse(input);
      return mutate({
        kind: "set_inbox_entry_state",
        page_ids: parsed.pageIds,
        state: parsed.state,
      });
    });
    yield* ipc.handleLocalCommitCommand("inbox:set-kind", (_, input) => {
      const parsed = InboxSetKindInputSchema.parse(input);
      return mutate({
        kind: "set_inbox_entry_kind",
        page_id: parsed.pageId,
        entry_kind: parsed.kind,
      });
    });
    yield* ipc.handleLocalCommitCommand("inbox:set-important", (_, input) => {
      const parsed = InboxSetImportantInputSchema.parse(input);
      return mutate({
        kind: "set_inbox_entry_important",
        page_id: parsed.pageId,
        important: parsed.important,
      });
    });
    yield* ipc.handleLocalCommitCommand("inbox:retry-problem", (_, input) => {
      const parsed = RetryProblemInputSchema.parse(input);
      return mutate(
        { kind: "source", command: { kind: "retry_problem", problem_id: parsed.problemId } },
        parsed.operationId,
      );
    });
    yield* ipc.handleLocalCommitCommand("inbox:undo", (_, input) => {
      const parsed = InboxUndoInputSchema.parse(input);
      return mutate(
        { kind: "undo_inbox_decision", undo_token: parsed.undoToken },
        parsed.operationId,
      );
    });
    const contentProject = (project: import("../../shared/types").Project) => ({
      ...project,
      sources: project.sources.filter((source) => source.kind === "repository"),
      primaryWorkspaceRoot: null,
    });
    yield* ipc.handleQuery("projects:list", (_, input) =>
      projects
        .listProjectWindow(input)
        .pipe(Effect.map((window) => ({ ...window, items: window.items.map(contentProject) }))),
    );
    yield* ipc.handleQuery("projects:get", (_, id) =>
      projects
        .getProject(id)
        .pipe(Effect.map((project) => (project ? contentProject(project) : null))),
    );
    yield* ipc.handleQuery("projects:activity-summaries", (_, ids) =>
      projects.readProjectActivitySummaries(ids),
    );
    yield* ipc.handleQuery("page-chats:session-linked-pages", (_, input) =>
      projects.readSessionLinkedPageSummaries(input),
    );
    yield* ipc.handleQuery("page-chats:activity-summaries", (_, input) =>
      projects.readPageChatActivitySummaries(input),
    );
    yield* ipc.handleQuery("page-chats:list", (_, input) => projects.listPageChatWindow(input));
    yield* ipc.handleQuery("sidebar:builtin-order:list", (_, lane, input) =>
      projects.listBuiltinSidebarOrder(lane, input),
    );
    yield* ipc.handleQuery("sidebar-sections:list", (_, input) =>
      projects.listSidebarSections(input),
    );
    yield* ipc.handleQuery("sidebar-sections:items:list", (_, id, input) =>
      projects.listSidebarSectionItems(id, input),
    );
    yield* ipc.handleQuery("sidebar-sections:sessions:placements", (_, ids) =>
      projects.readSessionSidebarPlacements(ids),
    );
    yield* ipc.handleQuery("sidebar-sections:item:placement", (_, item) =>
      projects.readSidebarSectionPlacement(item),
    );
    yield* ipc.handleQuery("project-sessions:get", (_, id) => projects.getProjectSession(id));
    // Core reads why a hosted chat has not started for every Member; its retry goes to the host.
    yield* ipc.handleQuery("project-sessions:start", (_, id) => projects.readSessionStart(id));
    // Archived chats lists what this Member may restore: hosted chats they asked for, or every
    // one for a Space Owner. Core decides both, and the host restores them.
    yield* ipc.handleQuery("codex:sidebar:snapshot", (_, input) =>
      Effect.gen(function* () {
        const items: CodexSidebarSnapshot["items"] = [];
        let revision = 0;
        let after: string | null = null;
        const pages = input?.includeArchived ? 10 : 0;
        for (let page = 0; page < pages; page += 1) {
          const read: import("../core-client/types").ProjectWorkspaceReadSnapshot =
            yield* core.workspace.read(
              { kind: "session_window", archived: true, window: { after, first: 200 } },
              undefined,
              null,
            );
          if (read.value.kind !== "session_window") throw new Error("Invalid archived chats");
          revision = Math.max(revision, read.value.sessions.authority.projection_revision);
          for (const { task } of read.value.sessions.items) {
            const chat = projectCoreWorkspaceTask(task);
            if (chat.executionRef && chat.canManage) items.push(archivedRuntimeChatItem(chat));
          }
          after = read.value.sessions.next_cursor ?? null;
          if (!after) break;
        }
        return {
          items,
          pinnedThreadIds: [],
          projectAssignments: {},
          projectlessThreadIds: [],
          revision,
          generatedAt: Date.now(),
        } satisfies CodexSidebarSnapshot;
      }),
    );
    yield* ipc.handleQuery("workspace:tasks:list", (_, projectId, input) =>
      projects.listProjectSessionSummaryWindow(projectId, input),
    );
    yield* ipc.handleQuery("inbox:counts", () =>
      core.workspace.read({ kind: "inbox_counts" }, undefined, null).pipe(
        Effect.map((snapshot) => {
          if (snapshot.value.kind !== "inbox_counts") throw new Error("Invalid Inbox response");
          return inboxCountsFromCore(snapshot.value.counts);
        }),
      ),
    );
    yield* ipc.handleQuery("inbox:summary", (_, input) =>
      Effect.gen(function* () {
        const parsed = InboxSummaryInputSchema.parse(input);
        const snapshot = yield* core.workspace.read(
          { kind: "inbox_summary", scope: inboxScopeToCore(parsed.scope) },
          undefined,
          null,
        );
        if (snapshot.value.kind !== "inbox_summary") throw new Error("Invalid Inbox response");
        return inboxSummaryFromCore(snapshot.value.summary, snapshot.store_epoch);
      }),
    );
    yield* ipc.handleQuery("inbox:window", (_, input) =>
      Effect.gen(function* () {
        const parsed = InboxWindowInputSchema.parse({ ...input, filter: "inbox" });
        const snapshot = yield* core.workspace.read(
          {
            kind: "inbox_window",
            scope: inboxScopeToCore(parsed.scope),
            filter: parsed.filter,
            window: { first: parsed.first ?? 50, after: parsed.after ?? null },
          },
          undefined,
          null,
        );
        if (snapshot.value.kind !== "inbox_window") throw new Error("Invalid Inbox response");
        const rows = snapshot.value.items;
        return {
          items: rows.items.map(inboxItemFromCore),
          nextCursor: rows.next_cursor ?? null,
          projectionRevision: rows.authority.projection_revision,
          storeEpoch: snapshot.store_epoch,
        };
      }),
    );
    yield* ipc.handleQuery("inbox:entry", (_, pageId) =>
      core.workspace.read({ kind: "inbox_entry", page_id: pageId }, undefined, null).pipe(
        Effect.map((snapshot) => {
          if (snapshot.value.kind !== "inbox_entry") throw new Error("Invalid Inbox response");
          return snapshot.value.item ? inboxItemFromCore(snapshot.value.item) : null;
        }),
      ),
    );
    yield* ipc.handleQuery("inbox:activity", (_, input) =>
      Effect.gen(function* () {
        const parsed = ActivityWindowInputSchema.parse(input);
        const snapshot = yield* core.workspace.read(
          {
            kind: "activity_window",
            scope: inboxScopeToCore(parsed.scope),
            filter: parsed.filter,
            window: { first: parsed.first ?? 50, after: parsed.after ?? null },
          },
          undefined,
          null,
        );
        if (snapshot.value.kind !== "activity_window") throw new Error("Invalid Activity response");
        return activityWindowFromCore(snapshot.value.rows, snapshot.store_epoch);
      }),
    );
  }),
);

/** This Space's part of the app badge: the reader's own unread chats, from its Core. */
const unreadBadge = (spaceId: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const badge = yield* UnreadBadge;
      const projects = yield* ProjectWorkspace;
      const database = yield* DatabaseNotifierRuntime;
      const events = yield* CoreEventHub;
      yield* badge.count(spaceId, {
        count: projects.unreadChatCount,
        changes: Stream.mergeAll(
          [
            SubscriptionRef.changes(events.connection),
            database.projectSessionInvalidations,
            database.projectInvalidations,
          ] as ReadonlyArray<Stream.Stream<unknown>>,
          { concurrency: 3 },
        ),
      });
    }),
  );

/** This graph deliberately excludes all execution/producer application Layers. */
export const live = (spaceId: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const registry = yield* SpaceConnectionRegistry;
      const config = yield* MainConfig;
      const connection = yield* registry.connection(spaceId);
      const collector = makeSpaceIpcCollector(yield* ElectronSpaceIpc);
      const core = coreModulesLive.pipe(Layer.provideMerge(Layer.succeedContext(connection)));
      const content = Layer.mergeAll(
        libraryLive,
        databaseLive,
        workspaceLive,
        desktopDocumentSessionRuntimeLive().pipe(Layer.provide(documentLive)),
      ).pipe(Layer.provideMerge(core));
      const applications = Layer.mergeAll(
        historyLive,
        exportsLive,
        rendererClientsLive({}),
        pageHtmlLive(spaceId),
      ).pipe(Layer.provideMerge(content));
      const clipboard = structuralClipboardLive.pipe(Layer.provideMerge(applications));
      const notifier = notifierLive(spaceId);
      const projections = projectionDeliveryLive.pipe(
        Layer.provideMerge(
          applicationProjection(registry.refreshName(spaceId)).pipe(Layer.provide(notifier)),
        ),
        Layer.provideMerge(notifier),
        Layer.provideMerge(clipboard),
      );
      const events = coreEventHubLive({}).pipe(Layer.provideMerge(projections));
      const ingress = Layer.mergeAll(
        CoreMutationIpc.live,
        CoreDocumentIpc.live,
        DatabaseProjectionIpc.live,
        ProjectionDeliveryIpc.live,
        PageSearchIpc.live({}),
        FilesIpc.live,
        DocumentRecoveryIpc.live,
        PageFileHtmlIpc.live,
        StructuralClipboardIpc.live,
        readModels,
        memberAttention,
        spaceAdministration,
        turnNotifications,
        RemoteHostIpc.live,
        RemotePresenceReporter.live,
        unreadBadge(spaceId),
        ChatMemberActionsIpc.live,
      ).pipe(
        Layer.provide(events),
        Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
        Layer.provide(
          Layer.succeed(MainConfig, {
            ...config,
            nodexHome: join(config.nodexHome, "space-cache", spacePathKey(spaceId)),
          }),
        ),
      );
      return Layer.effect(
        RemoteSpaceDesktop,
        Effect.gen(function* () {
          const library = yield* LibraryModule;
          const projects = yield* ProjectWorkspace;
          return { ...collector, library, projects };
        }),
      ).pipe(Layer.provide(events), Layer.provide(ingress));
    }),
  );
