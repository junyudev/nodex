import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  IpcQueryChannel,
  PlainResultCommandChannel,
} from "../../../shared/ipc-endpoint-policy";
import { isBoundedOperationId } from "../../../shared/operation-identity";
import { WorkbenchSceneSnapshotSchema } from "../../../shared/schemas/workbench-scene";
import type { OperationIdentifiedCommand } from "../../../shared/workspace-catalog-commands";
import {
  ProjectLifecycleInputSchema,
  ProjectUpdateCommandInputSchema,
} from "../../../shared/schemas/projects";
import { MainConfig } from "../../app/MainConfig";
import { CodexProjectSessionFork } from "../../codex-application/CodexProjectSessionFork";
import { CodexSidebarSectionSync } from "../../codex-application/CodexSidebarSectionSync";
import { CoreModuleResponseError } from "../../core-client/core-client";
import { rendererLocalCommitApply } from "../../core-client/types";
import type { CoreRuntimeError } from "../../core-runtime/CoreRuntimeError";
import { createProjectWithDefaultSource } from "../../default-project-source";
import {
  approximateJsonPayloadBytes,
  getDevRuntimeMetricDurationMs,
  getDevRuntimeMetricStart,
  logDevRuntimeMetric,
} from "../../dev-runtime-metrics";
import { resolveNodexProjectsDirectory } from "../../nodex-projects-directory";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import {
  ProjectLifecycleCommands,
  ProjectLifecycleCommandsError,
} from "../../project-application/ProjectLifecycleCommands";
import {
  ProjectSessionCommands,
  ProjectSessionCommandsError,
} from "../../project-application/ProjectSessionCommands";
import {
  ProjectWorkspace,
  ProjectWorkspaceError,
  type ProjectWorkspaceCommandResult,
} from "../../project-application/ProjectWorkspace";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ProjectWorkspaceIpcError extends Schema.TaggedError<ProjectWorkspaceIpcError>()(
  "ProjectWorkspaceIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type Handler<Channel extends keyof IpcApi> = (
  event: IpcMainInvokeEvent,
  ...args: IpcApi[Channel]["args"]
) => Effect.Effect<IpcApi[Channel]["result"], unknown>;

export const live: Layer.Layer<
  never,
  never,
  | CodexProjectSessionFork
  | CodexSidebarSectionSync
  | ElectronDesktop
  | ElectronIpc
  | MainConfig
  | ProjectLifecycleCommands
  | ProjectSessionCommands
  | ProjectWorkspace
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const projectSessionFork = yield* CodexProjectSessionFork;
    const sectionSync = yield* CodexSidebarSectionSync;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const projectLifecycle = yield* ProjectLifecycleCommands;
    const projectSessions = yield* ProjectSessionCommands;
    const projects = yield* ProjectWorkspace;
    const windows = yield* WindowRuntime;
    const syncSectionsAfter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.tap(() => sectionSync.request("local-mutation")));
    const { handleLocalCommitCommand, handlePlainCommand } = ipc;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Project workspace", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Project workspace access requires an active Nodex window");
          }
        },
        catch: (cause) => new ProjectWorkspaceIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A>(operation: string, task: () => A | Promise<A>) =>
      Effect.tryPromise({
        try: () => Promise.resolve(task()),
        catch: (cause) => new ProjectWorkspaceIpcError({ operation, cause }),
      });
    const invokeIpc = mapElectronIpcHandlers(
      ipc,
      (channel, task) =>
        (event, ...args) =>
          authorize(event).pipe(
            Effect.andThen(
              task(event, ...args).pipe(
                Effect.mapError(
                  (cause) => new ProjectWorkspaceIpcError({ operation: channel, cause }),
                ),
              ),
            ),
          ),
    );
    const invokeEffectQuery = <Channel extends IpcQueryChannel>(
      channel: Channel,
      task: Handler<Channel>,
    ) => invokeIpc.handleQuery(channel, task);
    const invokeEffectPlainCommand = <Channel extends PlainResultCommandChannel>(
      channel: Channel,
      task: Handler<Channel>,
    ) => invokeIpc.handlePlainCommand(channel, task);
    const unwrapCoreError = (cause: unknown): CoreModuleResponseError | null => {
      if (cause instanceof CoreModuleResponseError) return cause;
      if (cause instanceof ProjectWorkspaceError) return unwrapCoreError(cause.cause);
      if (cause instanceof ProjectLifecycleCommandsError) return unwrapCoreError(cause.cause);
      if (cause instanceof ProjectSessionCommandsError) return unwrapCoreError(cause.cause);
      if (
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "CoreRuntimeError"
      ) {
        return unwrapCoreError((cause as CoreRuntimeError).cause);
      }
      return null;
    };
    const catalogCommand = <Value>(
      operation: string,
      command: OperationIdentifiedCommand<unknown>,
      task: Effect.Effect<ProjectWorkspaceCommandResult<Value>, unknown>,
    ) =>
      Effect.try({
        try: () => {
          if (!isBoundedOperationId(command.operationId)) {
            throw new TypeError("Workspace catalog operation identity is invalid");
          }
          return command;
        },
        catch: (cause) => new ProjectWorkspaceIpcError({ operation: `${operation}.parse`, cause }),
      }).pipe(
        Effect.andThen(task),
        Effect.map(({ value, apply }) => ({
          ok: true as const,
          value,
          localCommit: rendererLocalCommitApply(apply),
        })),
        Effect.catch((cause) => {
          const coreError = unwrapCoreError(cause);
          if (!coreError) {
            return Effect.fail(
              cause instanceof ProjectWorkspaceIpcError
                ? cause
                : new ProjectWorkspaceIpcError({ operation, cause }),
            );
          }
          return Effect.succeed({ ok: false as const, error: coreError.coreError });
        }),
      );
    const pickDirectories = (event: IpcMainInvokeEvent, dialogOptions: OpenDialogOptions) =>
      run("pick-directories", async () => {
        const owner = windows.get(event.sender.id);
        const result = owner
          ? await desktop.dialog.showOpenDialog(owner, dialogOptions)
          : await desktop.dialog.showOpenDialog(dialogOptions);
        return result.canceled ? [] : result.filePaths;
      });
    const pickDirectory = (event: IpcMainInvokeEvent, dialogOptions: OpenDialogOptions) =>
      run("pick-directory", async () => {
        const owner = windows.get(event.sender.id);
        const result = owner
          ? await desktop.dialog.showOpenDialog(owner, dialogOptions)
          : await desktop.dialog.showOpenDialog(dialogOptions);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
    yield* invokeEffectQuery("projects:list", (_, input) => projects.listProjectWindow(input));
    yield* invokeEffectQuery("projects:get", (_, projectId) => projects.getProject(projectId));
    yield* invokeEffectQuery("projects:activity-summaries", (_, projectIds) =>
      projects.readProjectActivitySummaries(projectIds),
    );
    yield* invokeEffectQuery("page-chats:activity-summaries", (_, input) =>
      projects.readPageChatActivitySummaries(input),
    );
    yield* invokeEffectQuery("page-chats:list", (_, input) => projects.listPageChatWindow(input));
    yield* invokeEffectPlainCommand("page-chats:link", (_, sessionId, input) =>
      projects.linkPageToProjectSession(sessionId, input),
    );
    yield* invokeEffectPlainCommand("page-chats:unlink", (_, sessionId, input) =>
      projects.unlinkPageFromProjectSession(sessionId, input),
    );
    yield* handleLocalCommitCommand("projects:create", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "projects:create",
            command,
            createProjectWithDefaultSource(command.payload.input, {
              projectsDirectory: resolveNodexProjectsDirectory(config.documentsPath),
              createProject: (input) =>
                projects.createProject({
                  ...command,
                  payload: { ...command.payload, input },
                }),
            }),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("projects:update", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => ProjectUpdateCommandInputSchema.parse(input),
            catch: (cause) =>
              new ProjectWorkspaceIpcError({ operation: "projects:update.parse", cause }),
          }),
        ),
        Effect.flatMap((parsed) => projects.updateProject(parsed)),
        Effect.map(
          ({ value, apply }) =>
            ({
              ok: true,
              value,
              localCommit: rendererLocalCommitApply(apply),
            }) satisfies IpcApi["projects:update"]["result"],
        ),
        Effect.catch((cause) => {
          const coreError = unwrapCoreError(cause);
          if (!coreError) {
            return Effect.fail(
              cause instanceof ProjectWorkspaceIpcError
                ? cause
                : new ProjectWorkspaceIpcError({ operation: "projects:update", cause }),
            );
          }
          return Effect.succeed({
            ok: false,
            error: coreError.coreError,
          } satisfies IpcApi["projects:update"]["result"]);
        }),
      ),
    );
    yield* handleLocalCommitCommand("projects:reorder", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand("projects:reorder", command, projects.reorderProjects(command)),
        ),
      ),
    );
    yield* handleLocalCommitCommand("projects:set-pinned", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "projects:set-pinned",
            command,
            syncSectionsAfter(projects.setProjectPinned(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("projects:set-pinned-order", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "projects:set-pinned-order",
            command,
            projects.setPinnedProjectOrder(command),
          ),
        ),
      ),
    );
    yield* handlePlainCommand("projects:pick-source-roots", (event) =>
      authorize(event).pipe(
        Effect.andThen(
          pickDirectories(event, {
            title: "Select Project Root",
            properties: ["openDirectory", "createDirectory", "multiSelections"],
          }),
        ),
      ),
    );
    yield* handlePlainCommand("workspace:pick-directory", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          pickDirectory(event, {
            title: typeof input?.title === "string" ? input.title : "Choose folder",
            properties:
              input?.createDirectory === true
                ? ["openDirectory", "createDirectory"]
                : ["openDirectory"],
          }),
        ),
      ),
    );
    yield* handleLocalCommitCommand("projects:set-lifecycle", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              if (!isBoundedOperationId(command.operationId)) {
                throw new TypeError("Workspace catalog operation identity is invalid");
              }
              ProjectLifecycleInputSchema.parse(command.payload);
              return command;
            },
            catch: (cause) =>
              new ProjectWorkspaceIpcError({ operation: "projects:set-lifecycle", cause }),
          }),
        ),
        Effect.flatMap(projectLifecycle.setLifecycle),
        Effect.map((execution): IpcApi["projects:set-lifecycle"]["result"] =>
          execution.kind === "rejected"
            ? execution.result
            : {
                ok: true,
                value: execution.result.value,
                localCommit: rendererLocalCommitApply(execution.result.apply),
              },
        ),
        Effect.catch((cause) => {
          const coreError = unwrapCoreError(cause);
          if (!coreError) {
            return Effect.fail(
              cause instanceof ProjectWorkspaceIpcError
                ? cause
                : new ProjectWorkspaceIpcError({ operation: "projects:set-lifecycle", cause }),
            );
          }
          return Effect.succeed({ ok: false as const, error: coreError.coreError });
        }),
      ),
    );
    yield* invokeEffectQuery("sidebar-sections:list", (_, input) =>
      projects.listSidebarSections(input),
    );
    yield* invokeEffectQuery("sidebar-sections:items:list", (_, sectionId, input) =>
      projects.listSidebarSectionItems(sectionId, input),
    );
    yield* invokeEffectQuery("sidebar-sections:item:placement", (_, item) =>
      projects.readSidebarSectionPlacement(item),
    );
    yield* handleLocalCommitCommand("sidebar-sections:create", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:create",
            command,
            syncSectionsAfter(projects.createSidebarSection(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:rename", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:rename",
            command,
            syncSectionsAfter(projects.renameSidebarSection(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:delete", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:delete",
            command,
            syncSectionsAfter(projects.deleteSidebarSection(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:restore", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:restore",
            command,
            syncSectionsAfter(projects.restoreSidebarSection(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:item:move", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:item:move",
            command,
            syncSectionsAfter(projects.moveSidebarSectionItem(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:reorder", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:reorder",
            command,
            projects.reorderSidebarSections(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:sessions:reorder", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:sessions:reorder",
            command,
            syncSectionsAfter(projects.reorderSidebarSectionSessions(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:sessions:archive-all", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:sessions:archive-all",
            command,
            syncSectionsAfter(projects.archiveSidebarSectionSessions(command)),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("sidebar-sections:sessions:create", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "sidebar-sections:sessions:create",
            command,
            syncSectionsAfter(projects.createSessionInSidebarSection(command)),
          ),
        ),
      ),
    );
    yield* invokeEffectQuery("workspace:tasks:list", (_, projectId, input) =>
      Effect.gen(function* () {
        const startedAt = getDevRuntimeMetricStart();
        const window = yield* projects.listProjectSessionSummaryWindow(projectId, input);
        yield* Effect.sync(() =>
          logDevRuntimeMetric("ipc.workspace_tasks_list", {
            projectId,
            includeArchived: input?.includeArchived === true,
            requestedFirst: input?.first ?? 50,
            itemCount: window.items.length,
            hasMore: window.hasMore,
            approxPayloadBytes: approximateJsonPayloadBytes(window),
            durationMs: getDevRuntimeMetricDurationMs(startedAt),
          }),
        );
        return window;
      }),
    );
    yield* invokeEffectQuery("project-sessions:get", (_, sessionId) =>
      Effect.gen(function* () {
        const startedAt = getDevRuntimeMetricStart();
        const session = yield* projects.getProjectSession(sessionId);
        yield* Effect.sync(() =>
          logDevRuntimeMetric("ipc.project_sessions_get", {
            sessionId,
            found: session !== null,
            approxPayloadBytes: approximateJsonPayloadBytes(session),
            durationMs: getDevRuntimeMetricDurationMs(startedAt),
          }),
        );
        return session;
      }),
    );
    yield* handleLocalCommitCommand("project-sessions:create", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:create",
            command,
            projects.createProjectSession(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:ensure-default-draft", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:ensure-default-draft",
            command,
            projects.ensureDefaultDraftProjectSession(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:update", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:update",
            command,
            projects.updateProjectSession(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:rename", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand("project-sessions:rename", command, projectSessions.rename(command)),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:delete", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand("project-sessions:delete", command, projectSessions.delete(command)),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:reorder", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:reorder",
            command,
            projects.reorderProjectSessions(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:set-pinned", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:set-pinned",
            command,
            projectSessions.setPinned(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:set-pinned-order", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:set-pinned-order",
            command,
            projects.setPinnedProjectSessionOrder(command),
          ),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:archive", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand("project-sessions:archive", command, projectSessions.archive(command)),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:unarchive", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand("project-sessions:unarchive", command, projectSessions.unarchive(command)),
        ),
      ),
    );
    yield* handleLocalCommitCommand("project-sessions:mark-unread", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          catalogCommand(
            "project-sessions:mark-unread",
            command,
            projects.markProjectSessionUnread(command),
          ),
        ),
      ),
    );
    yield* handlePlainCommand(
      "project-sessions:fork",
      (event, sessionId, input, sourceSceneContext) =>
        authorize(event).pipe(
          Effect.andThen(
            Effect.try({
              try: () => {
                if (
                  sourceSceneContext &&
                  windows.resolveSessionId(event.sender.id) !==
                    sourceSceneContext.browserViewScopeId
                ) {
                  throw new Error("Browser view scope does not belong to the requesting window");
                }
                return sourceSceneContext
                  ? {
                      browserViewScopeId: sourceSceneContext.browserViewScopeId,
                      scene: WorkbenchSceneSnapshotSchema.parse(sourceSceneContext.scene),
                    }
                  : undefined;
              },
              catch: (cause) =>
                new ProjectWorkspaceIpcError({ operation: "project-sessions:fork", cause }),
            }),
          ),
          Effect.flatMap((parsedSceneContext) =>
            projectSessionFork.fork({
              sessionId,
              input,
              ...(parsedSceneContext ? { sourceSceneContext: parsedSceneContext } : {}),
            }),
          ),
        ),
    );
    yield* invokeEffectPlainCommand("project-session-threads:attach", (_, input) =>
      projects.upsertProjectSessionThreadLink(input),
    );
    yield* invokeEffectPlainCommand("project-session-threads:detach", (_, sessionId) =>
      projects.detachProjectSessionThread(sessionId),
    );
  }),
);
