import { SessionFolders } from "../../agent-backend/SessionFolders";
import { live as agentChatWorktreesLive } from "../../codex-application/AgentChatWorktrees";
import type { CreatePageForCommand } from "../../../shared/workspace-page-create";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { vi } from "vite-plus/test";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import type { SessionSidebarPlacement } from "../../../shared/sidebar-sections";
import type {
  Project,
  ProjectUpdateCommandInput,
  SessionLinkedPageSummaryInput,
  SessionManagedState,
} from "../../../shared/types";
import type {
  ProjectSessionOpenedCommandInput,
  ProjectSessionManagedCommandInput,
  BuiltinSidebarReorderCommandInput,
} from "../../../shared/workspace-catalog-commands";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexProjectSessionFork } from "../../codex-application/CodexProjectSessionFork";
import { CodexSidebarSectionSync } from "../../codex-application/CodexSidebarSectionSync";
import { CoreModuleResponseError } from "../../core-client/core-client";
import type { ProjectWorkspaceApplyResult } from "../../core-client/types";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ProjectLifecycleCommands } from "../../project-application/ProjectLifecycleCommands";
import { ProjectSessionCommands } from "../../project-application/ProjectSessionCommands";
import {
  ProjectWorkspace,
  ProjectWorkspaceError,
  type ProjectWorkspaceService,
} from "../../project-application/ProjectWorkspace";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ProjectWorkspaceIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

const rendererEvent = (id: number): IpcMainInvokeEvent => {
  const frame = { url: "app://-/index.html" };
  return {
    sender: { getType: () => "window", id, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
};

const project: Project = {
  id: "project:one",
  libraryId: "library:one",
  databaseId: "database:one",
  defaultDatabaseViewId: "view:one",
  lifecycle: "active",
  bindingRevision: 2,
  name: "Renamed",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [],
  primaryWorkspaceRoot: null,
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-01-01T00:00:00.000Z"),
  updated: new Date("2026-01-01T00:00:01.000Z"),
};

const applied = {
  status: "committed",
  outcome: {
    affected_project_ids: [project.id],
    affected_session_ids: [],
    affected_thread_ids: [],
  },
  receipt: {
    operation_id: "operation:test",
    duplicate: false,
    affected_project_ids: [project.id],
    affected_session_ids: [],
  },
  commit: {
    store_epoch: "epoch:test",
    commit_seq: 17,
    manifest_hash: "f".repeat(64),
  },
} as Extract<ProjectWorkspaceApplyResult, { readonly status: "committed" }>;

it.effect("owns Project and Project Session ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const sideChatInputs: unknown[] = [];
    const sideChatWindow = { items: [], nextCursor: "next", projectionRevision: 17 };
    const linkedPageInputs: SessionLinkedPageSummaryInput[] = [];
    const linkedPageResult = {
      summaries: [],
      libraryId: "library:one",
      storeEpoch: "epoch:test",
      projectionRevision: 17,
    };
    const pageInputs: CreatePageForCommand[] = [];
    const pageResult = {
      pageId: "page:created",
      projectId: project.id,
      placement: {
        kind: "data_source" as const,
        databaseId: project.databaseId!,
        dataSourceId: "source:one",
        viewId: "view:one",
      },
      pageKey: "LAB-1",
    };
    const updateInputs: ProjectUpdateCommandInput[] = [];
    const openedInputs: ProjectSessionOpenedCommandInput[] = [];
    const pinnedOrderInputs: BuiltinSidebarReorderCommandInput[] = [];
    const placementInputs: (readonly string[])[] = [];
    const placements: readonly SessionSidebarPlacement[] = [
      {
        sessionId: "session:one",
        projectId: project.id,
        sectionId: "section:one",
        unread: true,
        remindAt: null,
      },
    ];
    let managedState: SessionManagedState = { managed: false, since: null };
    const managedInputs: ProjectSessionManagedCommandInput[] = [];
    const workspace = ProjectWorkspace.of({
      createPageFor: (input: CreatePageForCommand) =>
        Effect.sync(() => {
          pageInputs.push(input);
          return pageResult;
        }),
      readSessionLinkedPageSummaries: (input: SessionLinkedPageSummaryInput) =>
        Effect.sync(() => {
          linkedPageInputs.push(input);
          return linkedPageResult;
        }),
      recordProjectSessionOpened: (command: ProjectSessionOpenedCommandInput) =>
        Effect.sync(() => {
          openedInputs.push(command);
          return { value: undefined, apply: applied };
        }),
      listSessionSideChats: (sourceSessionId: string, input: unknown) =>
        Effect.sync(() => {
          sideChatInputs.push({ sourceSessionId, input });
          return sideChatWindow;
        }),
      listBuiltinSidebarOrder: () =>
        Effect.succeed({
          orderRevision: "pins:3",
          items: [
            { kind: "session", sessionId: "session:draft", title: "New chat" },
            { kind: "session", sessionId: "session:attached", title: "Chat" },
          ],
          nextCursor: null,
          hasMore: false,
          projectionRevision: 17,
        }),
      readSessionSidebarPlacements: (sessionIds: readonly string[]) =>
        Effect.sync(() => {
          placementInputs.push(sessionIds);
          return placements;
        }),
      reorderBuiltinSidebarItems: (command: BuiltinSidebarReorderCommandInput) =>
        Effect.sync(() => {
          pinnedOrderInputs.push(command);
          return { value: undefined, apply: applied };
        }),
      readSessionManaged: (sessionId: string) => {
        assert.equal(sessionId, "session:one");
        return Effect.succeed(managedState);
      },
      setSessionManaged: (command: ProjectSessionManagedCommandInput) =>
        Effect.sync(() => {
          managedInputs.push(command);
          managedState = {
            managed: command.payload.managed,
            since: command.payload.managed ? "2026-11-03T00:00:00Z" : null,
          };
          return { value: managedState, apply: applied };
        }),
      updateProject: (input: ProjectUpdateCommandInput) => {
        if (input.projectId === "project:missing") {
          return Effect.fail(
            new ProjectWorkspaceError({
              operation: "project.read",
              cause: new CoreModuleResponseError({
                code: "not_found",
                message: "Project not found",
                retryable: false,
                recovery: { kind: "none" },
              }),
            }),
          );
        }
        return Effect.sync(() => {
          updateInputs.push(input);
          return { value: project, apply: applied };
        });
      },
    } as unknown as ProjectWorkspaceService);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProjectWorkspace, workspace),
            agentChatWorktreesLive,
            Layer.succeed(SessionFolders, {
              ensure: (sessionId) =>
                Effect.sync(() => {
                  assert.equal(sessionId, "session:test");
                  return {
                    path: "/chat",
                    output_directory: "/chat/outputs",
                    origin: "generated",
                    execution_host_id: "local",
                  };
                }),
              choose: (sessionId, path) =>
                Effect.sync(() => {
                  assert.equal(sessionId, "session:test");
                  return {
                    path,
                    output_directory: path,
                    origin: "chosen",
                    execution_host_id: "local",
                  };
                }),
              cleanDeleted: () => Effect.void,
            }),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(
              CodexProjectSessionFork,
              CodexProjectSessionFork.of({ fork: () => Effect.die("unused") }),
            ),
            Layer.succeed(
              CodexSidebarSectionSync,
              CodexSidebarSectionSync.of({
                request: () => Effect.void,
                syncHost: () => Effect.die("unused"),
                syncAll: () => Effect.succeed([]),
              }),
            ),
            mainConfigLayer(),
            Layer.succeed(
              ProjectLifecycleCommands,
              ProjectLifecycleCommands.of({ setLifecycle: () => Effect.die("unused") }),
            ),
            Layer.succeed(
              ProjectSessionCommands,
              ProjectSessionCommands.of({
                rename: () => Effect.die("unused"),
                delete: () => Effect.die("unused"),
                archive: () => Effect.die("unused"),
                unarchive: () => Effect.die("unused"),
                setPinned: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(ElectronDesktop, { dialog: {} } as unknown as ElectronDesktop["Service"]),
            Layer.succeed(WindowRuntime, {
              has: (id: number) => id === 17,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.deepEqual(
      yield* handlers.get("session-folder:ensure")!(rendererEvent(17), "session:test"),
      {
        path: "/chat",
        outputDirectory: "/chat/outputs",
        origin: "generated",
      },
    );
    assert.deepEqual(
      yield* handlers.get("session-folder:choose")!(rendererEvent(17), "session:test", "/chosen"),
      {
        path: "/chosen",
        outputDirectory: "/chosen",
        origin: "chosen",
      },
    );
    assert.isTrue(
      yield* handlers.get("session-folder:ensure")!(rendererEvent(99), "session:test").pipe(
        Effect.isFailure,
      ),
    );

    assert.strictEqual(handlers.size, 58);
    assert.isTrue(handlers.has("projects:create"));
    assert.isTrue(handlers.has("project-sessions:start"));
    assert.isTrue(handlers.has("project-sessions:set-reminder"));
    assert.isTrue(handlers.has("projects:update"));
    assert.isTrue(handlers.has("project-sessions:fork"));
    assert.isTrue(handlers.has("project-session-threads:detach"));
    assert.isTrue(handlers.has("page-chats:activity-summaries"));
    assert.isTrue(handlers.has("page-chats:hand-off"));
    assert.isTrue(handlers.has("page-chats:list"));
    assert.isTrue(handlers.has("page-chats:link"));
    assert.isTrue(handlers.has("page-chats:unlink"));
    assert.isTrue(handlers.has("sidebar-sections:sessions:placements"));

    assert.deepEqual(
      yield* handlers.get("project-sessions:managed")!(rendererEvent(17), "session:one"),
      { managed: false, since: null },
    );
    const managedCommand: ProjectSessionManagedCommandInput = {
      operationId: createBoundedOperationId("workspace.session.managed", 1_800_000_000_000),
      payload: { sessionId: "session:one", managed: true },
    };
    const deniedManaged = yield* handlers.get("project-sessions:set-managed")!(
      rendererEvent(99),
      managedCommand,
    ).pipe(Effect.result);
    assert.equal(deniedManaged._tag, "Failure");
    assert.deepEqual(managedInputs, []);
    const managedResult = yield* handlers.get("project-sessions:set-managed")!(
      rendererEvent(17),
      managedCommand,
    );
    assert.deepEqual(managedInputs, [managedCommand]);
    assert.deepEqual(managedResult, {
      ok: true,
      value: { managed: true, since: "2026-11-03T00:00:00Z" },
      localCommit: { status: "committed", commit: applied.commit, delivery: null },
    });
    assert.deepEqual(
      yield* handlers.get("project-sessions:managed")!(rendererEvent(17), "session:one"),
      managedState,
    );
    const sideInput = { after: "cursor", first: 1 };
    const sideWindow = yield* handlers.get("project-sessions:side-chats")!(
      rendererEvent(17),
      "source",
      sideInput,
    );
    assert.deepEqual(sideWindow, sideChatWindow);
    assert.deepEqual(sideChatInputs, [{ sourceSessionId: "source", input: sideInput }]);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handlers.get("project-sessions:side-chats")!(rendererEvent(99), "source", sideInput),
        ),
      ),
    );
    assert.equal(sideChatInputs.length, 1);

    const pageInput: CreatePageForCommand = {
      for: { kind: "session", sessionId: "session:one" },
      operationId: "operation:page",
      pageId: "page:created",
      documentId: "document:created",
    };
    const page = yield* handlers.get("workspace:page:create-for")!(rendererEvent(17), pageInput);
    assert.deepEqual(pageInputs, [pageInput]);
    assert.deepEqual(page, pageResult);

    const linkedPageInput = { sessionIds: ["session:one"] };
    const linkedPageSummary = yield* handlers.get("page-chats:session-linked-pages")!(
      rendererEvent(17),
      linkedPageInput,
    );
    assert.deepEqual(linkedPageInputs, [linkedPageInput]);
    assert.deepEqual(linkedPageSummary, linkedPageResult);

    const opening: ProjectSessionOpenedCommandInput = {
      operationId: createBoundedOperationId("workspace.session.opened", 1_800_000_000_000),
      payload: { sessionId: "session:one" },
    };
    const deniedOpen = yield* handlers.get("project-sessions:record-opened")!(
      rendererEvent(99),
      opening,
    ).pipe(Effect.result);
    assert.equal(deniedOpen._tag, "Failure");
    assert.deepEqual(openedInputs, []);
    const opened = yield* handlers.get("project-sessions:record-opened")!(
      rendererEvent(17),
      opening,
    );
    assert.deepEqual(openedInputs, [opening]);
    assert.deepEqual(opened, {
      ok: true,
      value: undefined,
      localCommit: { status: "committed", commit: applied.commit, delivery: null },
    });

    const pinnedOrder = yield* handlers.get("sidebar:builtin-order:list")!(
      rendererEvent(17),
      "pinned_sessions",
    );
    assert.deepEqual(pinnedOrder, {
      orderRevision: "pins:3",
      items: [
        { kind: "session", sessionId: "session:draft", title: "New chat" },
        { kind: "session", sessionId: "session:attached", title: "Chat" },
      ],
      nextCursor: null,
      hasMore: false,
      projectionRevision: 17,
    });
    // Collapsed Projects and Sections read live chats' placement in one bounded query.
    assert.deepEqual(
      yield* handlers.get("sidebar-sections:sessions:placements")!(rendererEvent(17), [
        "session:one",
      ]),
      placements,
    );
    assert.deepEqual(placementInputs, [["session:one"]]);
    const pinnedCommand: BuiltinSidebarReorderCommandInput = {
      operationId: createBoundedOperationId("workspace.session.reorder-pinned", 1_800_000_000_000),
      payload: {
        lane: "pinned_sessions",
        expectedOrderRevision: "pins:3",
        itemIds: ["session:attached", "session:draft"],
      },
    };
    const pinnedResult = yield* handlers.get("sidebar:builtin-order:reorder")!(
      rendererEvent(17),
      pinnedCommand,
    );
    assert.deepEqual(pinnedOrderInputs, [pinnedCommand]);
    assert.deepEqual(pinnedResult, {
      ok: true,
      value: undefined,
      localCommit: { status: "committed", commit: applied.commit, delivery: null },
    });

    const input = {
      operationId: createBoundedOperationId("workspace.project.rename", 1_800_000_000_000),
      projectId: project.id,
      updates: { name: project.name, expectedBindingRevision: project.bindingRevision },
    } satisfies ProjectUpdateCommandInput;
    const result = yield* handlers.get("projects:update")!(rendererEvent(17), input);
    assert.deepEqual(updateInputs, [input]);
    assert.deepEqual(result, {
      ok: true,
      value: project,
      localCommit: {
        status: "committed",
        commit: applied.commit,
        delivery: null,
      },
    });

    const missing = yield* handlers.get("projects:update")!(rendererEvent(17), {
      ...input,
      projectId: "project:missing",
    });
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: "not_found",
        message: "Project not found",
        retryable: false,
        recovery: { kind: "none" },
      },
    });

    const invalid = yield* Effect.exit(
      handlers.get("projects:update")!(rendererEvent(17), {
        ...input,
        operationId: "operation:legacy",
      }).pipe(Effect.asVoid),
    );
    assert.isTrue(Exit.isFailure(invalid));
    assert.strictEqual(updateInputs.length, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
