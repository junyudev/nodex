import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ProjectSession } from "../../shared/types";
import type {
  ProjectSessionArchiveCommandInput,
  ProjectSessionDeleteCommandInput,
  ProjectSessionPinnedCommandInput,
  ProjectSessionRenameCommandInput,
} from "../../shared/workspace-catalog-commands";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexSidebarSectionSync } from "../codex-application/CodexSidebarSectionSync";
import { type ProjectWorkspaceCommandResult } from "./ProjectWorkspace";

type SessionResult<Value> = Effect.Effect<Value, ProjectSessionCommandsError>;
type SessionMutationResult = ProjectWorkspaceCommandResult<ProjectSession>;

export class ProjectSessionCommandsError extends Schema.TaggedError<ProjectSessionCommandsError>()(
  "ProjectSessionCommandsError",
  {
    operation: Schema.Literals([
      "read",
      "rename-title",
      "rename-session",
      "delete-session",
      "archive-conversation",
      "archive-session",
      "unarchive-conversation",
      "unarchive-session",
      "close-backend-session",
      "set-pinned",
    ]),
    cause: Schema.Defect(),
    committedOperationId: Schema.optionalKey(Schema.String),
  },
) {}

export class ProjectSessionCommands extends Context.Service<
  ProjectSessionCommands,
  {
    readonly rename: (
      command: ProjectSessionRenameCommandInput,
    ) => SessionResult<SessionMutationResult>;
    readonly delete: (
      command: ProjectSessionDeleteCommandInput,
    ) => SessionResult<ProjectWorkspaceCommandResult<boolean>>;
    readonly archive: (
      command: ProjectSessionArchiveCommandInput,
    ) => SessionResult<SessionMutationResult>;
    readonly unarchive: (
      command: ProjectSessionArchiveCommandInput,
    ) => SessionResult<SessionMutationResult>;
    readonly setPinned: (
      command: ProjectSessionPinnedCommandInput,
    ) => SessionResult<SessionMutationResult>;
  }
>()("nodex/main/project-application/ProjectSessionCommands") {}

export const live: Layer.Layer<
  ProjectSessionCommands,
  never,
  BrowserApplication | CodexSidebarSectionSync | AgentRuntimeApplication
> = Layer.effect(
  ProjectSessionCommands,
  Effect.gen(function* () {
    const browser = yield* BrowserApplication;
    const execution = yield* AgentRuntimeApplication;
    const sections = yield* CodexSidebarSectionSync;
    const lanes = yield* RcMap.make({ lookup: (_sessionId: string) => Semaphore.make(1) });
    const runSerial = <Value>(sessionId: string, operation: SessionResult<Value>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lane = yield* RcMap.get(lanes, sessionId);
          return yield* lane.withPermit(operation);
        }),
      );
    const attempt = <Value>(
      operation: ProjectSessionCommandsError["operation"],
      effect: Effect.Effect<Value, unknown>,
    ): SessionResult<Value> =>
      effect.pipe(
        Effect.tapError((cause) =>
          Schema.is(AgentRuntimeApplicationError)(cause) && cause.committedOperationId
            ? sections.request("local-mutation")
            : Effect.void,
        ),
        Effect.mapError(
          (cause) =>
            new ProjectSessionCommandsError({
              operation,
              cause,
              ...(Schema.is(AgentRuntimeApplicationError)(cause) && cause.committedOperationId
                ? { committedOperationId: cause.committedOperationId }
                : {}),
            }),
        ),
        Effect.tap(() => sections.request("local-mutation")),
      );
    const deleteSession = Effect.fn("ProjectSessionCommands.delete")(function* (
      command: ProjectSessionDeleteCommandInput,
    ) {
      const closeBrowser = browser.closeConversation(command.payload.sessionId).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Session browser cleanup failed").pipe(
            Effect.annotateLogs({
              sessionId: command.payload.sessionId,
              failure: Cause.pretty(cause),
            }),
          ),
        ),
        Effect.ignoreCause,
      );
      const result = yield* execution
        .deleteSession(command)
        .pipe(
          Effect.tapError((cause) => (cause.committedOperationId ? closeBrowser : Effect.void)),
        );
      yield* closeBrowser;
      return result;
    });
    return ProjectSessionCommands.of({
      rename: (command) =>
        runSerial(
          command.payload.sessionId,
          attempt("rename-session", execution.renameSession(command)),
        ),
      delete: (command) =>
        runSerial(command.payload.sessionId, attempt("delete-session", deleteSession(command))),
      archive: (command) =>
        runSerial(
          command.payload.sessionId,
          attempt("archive-session", execution.archiveSession(command)),
        ),
      unarchive: (command) =>
        runSerial(
          command.payload.sessionId,
          attempt("unarchive-session", execution.unarchiveSession(command)),
        ),
      setPinned: (command) =>
        runSerial(
          command.payload.sessionId,
          attempt("set-pinned", execution.setPinnedSession(command)),
        ),
    });
  }),
);
