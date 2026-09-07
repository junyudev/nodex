import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import { normalizeCodexManualThreadTitle } from "../../shared/codex-thread-title";
import type { ProjectSession } from "../../shared/types";
import type {
  ProjectSessionArchiveCommandInput,
  ProjectSessionDeleteCommandInput,
  ProjectSessionPinnedCommandInput,
  ProjectSessionRenameCommandInput,
} from "../../shared/workspace-catalog-commands";
import { AcpBackendSessionManager } from "../agent-backend/acp/AcpBackendSessionManager";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexSidebarSectionSync } from "../codex-application/CodexSidebarSectionSync";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { ConversationCommands } from "../codex-application/ConversationCommands";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { ProjectWorkspace, type ProjectWorkspaceCommandResult } from "./ProjectWorkspace";

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
  | BrowserApplication
  | CodexSidebarSectionSync
  | CodexThreadTitlePersistence
  | ConversationCommands
  | AcpBackendSessionManager
  | ProjectWorkspace
> = Layer.effect(
  ProjectSessionCommands,
  Effect.gen(function* () {
    const browser = yield* BrowserApplication;
    const acpSessions = yield* AcpBackendSessionManager;
    const conversation = yield* ConversationCommands;
    const sections = yield* CodexSidebarSectionSync;
    const threadTitles = yield* CodexThreadTitlePersistence;
    const workspace = yield* ProjectWorkspace;
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
        Effect.mapError((cause) => new ProjectSessionCommandsError({ operation, cause })),
      );
    const syncSections = <Value>(effect: SessionResult<Value>): SessionResult<Value> =>
      effect.pipe(Effect.tap(() => sections.request("local-mutation")));
    const afterCommit = <Value>(
      operationId: string,
      effect: SessionResult<Value>,
    ): SessionResult<Value> =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new ProjectSessionCommandsError({
              operation: error.operation,
              cause: error.cause,
              committedOperationId: operationId,
            }),
        ),
      );
    const read = (sessionId: string) => attempt("read", workspace.getProjectSession(sessionId));
    const closeBrowserConversation = (sessionId: string): Effect.Effect<void> =>
      browser.closeConversation(sessionId).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Project Session browser cleanup failed").pipe(
            Effect.annotateLogs({ sessionId, failure: Cause.pretty(cause) }),
          ),
        ),
        Effect.ignoreCause,
      );

    const rename = Effect.fn("ProjectSessionCommands.rename")(function* (
      command: ProjectSessionRenameCommandInput,
    ) {
      const existing = yield* read(command.payload.sessionId);
      if (!existing) {
        return yield* attempt("rename-session", workspace.renameProjectSession(command));
      }
      const title = normalizeCodexManualThreadTitle(command.payload.input.title);
      if (!title) {
        return yield* new ProjectSessionCommandsError({
          operation: "rename-title",
          cause: new TypeError("Project Session title is invalid"),
        });
      }
      const result = yield* attempt(
        "rename-session",
        workspace.renameProjectSession({
          ...command,
          payload: { ...command.payload, input: { title } },
        }),
      );
      if (result.value.thread && isCodexAgentBackendBinding(result.value.thread.backendBinding)) {
        yield* afterCommit(
          command.operationId,
          attempt("rename-title", threadTitles.syncCommittedTitle(result.value.thread.threadId)),
        );
      }
      return result;
    }, syncSections);

    const deleteSession = Effect.fn("ProjectSessionCommands.delete")(function* (
      command: ProjectSessionDeleteCommandInput,
    ) {
      const existing = yield* read(command.payload.sessionId);
      if (existing?.thread && !isCodexAgentBackendBinding(existing.thread.backendBinding)) {
        yield* attempt("close-backend-session", acpSessions.close(existing.thread.threadId));
      }
      const result = yield* attempt("delete-session", workspace.deleteProjectSession(command));
      yield* closeBrowserConversation(command.payload.sessionId);
      return result;
    }, syncSections);

    const setArchived = Effect.fn("ProjectSessionCommands.setArchived")(function* (
      command: ProjectSessionArchiveCommandInput,
      archived: boolean,
    ) {
      const result = yield* attempt(
        archived ? "archive-session" : "unarchive-session",
        archived
          ? workspace.archiveProjectSession(command)
          : workspace.unarchiveProjectSession(command),
      );
      // A later lifecycle commit supersedes replayed receipts; never undo its backend state.
      if (result.value.archived !== archived) return result;
      const thread = result.value.thread;
      const affectedThreadIds = result.apply.outcome.affected_thread_ids;
      if (!thread && affectedThreadIds.length === 0) return result;
      if (!thread || affectedThreadIds.length !== 1 || affectedThreadIds[0] !== thread.threadId) {
        return yield* new ProjectSessionCommandsError({
          operation: archived ? "archive-conversation" : "unarchive-conversation",
          cause: new Error("Session attachment changed after its lifecycle commit"),
          committedOperationId: command.operationId,
        });
      }
      // Only the committed Session receipt admits host-owned backend and descendant cleanup.
      // These follow-up projection/lifecycle writes are not new Agent organization commands.
      yield* afterCommit(
        command.operationId,
        Effect.gen(function* () {
          if (isCodexAgentBackendBinding(thread.backendBinding)) {
            if (archived) {
              yield* attempt("archive-conversation", conversation.archive(thread.threadId));
            } else {
              yield* attempt("unarchive-conversation", conversation.unarchive(thread.threadId));
            }
          } else if (archived) {
            yield* attempt("close-backend-session", acpSessions.close(thread.threadId));
          }
        }).pipe(Effect.provideService(CoreApplicationAgent, null)),
      );
      return result;
    }, syncSections);

    const setPinned = Effect.fn("ProjectSessionCommands.setPinned")(function* (
      command: ProjectSessionPinnedCommandInput,
    ) {
      return yield* attempt("set-pinned", workspace.setProjectSessionPinned(command));
    }, syncSections);

    return ProjectSessionCommands.of({
      rename: (command) => runSerial(command.payload.sessionId, rename(command)),
      delete: (command) => runSerial(command.payload.sessionId, deleteSession(command)),
      archive: (command) => runSerial(command.payload.sessionId, setArchived(command, true)),
      unarchive: (command) => runSerial(command.payload.sessionId, setArchived(command, false)),
      setPinned: (command) => runSerial(command.payload.sessionId, setPinned(command)),
    });
  }),
);
