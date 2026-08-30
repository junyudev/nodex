import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { normalizeCodexManualThreadTitle } from "../../shared/codex-thread-title";
import type { ProjectSession } from "../../shared/types";
import type {
  ProjectSessionArchiveCommandInput,
  ProjectSessionDeleteCommandInput,
  ProjectSessionPinnedCommandInput,
  ProjectSessionRenameCommandInput,
} from "../../shared/workspace-catalog-commands";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexSidebarSectionSync } from "../codex-application/CodexSidebarSectionSync";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { ConversationCommands } from "../codex-application/ConversationCommands";
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
      "set-pinned",
    ]),
    cause: Schema.Defect(),
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
  | ProjectWorkspace
> = Layer.effect(
  ProjectSessionCommands,
  Effect.gen(function* () {
    const browser = yield* BrowserApplication;
    const conversation = yield* ConversationCommands;
    const sections = yield* CodexSidebarSectionSync;
    const threadTitles = yield* CodexThreadTitlePersistence;
    const workspace = yield* ProjectWorkspace;

    const attempt = <Value>(
      operation: ProjectSessionCommandsError["operation"],
      effect: Effect.Effect<Value, unknown>,
    ): SessionResult<Value> =>
      effect.pipe(
        Effect.mapError((cause) => new ProjectSessionCommandsError({ operation, cause })),
      );
    const syncSections = <Value>(effect: SessionResult<Value>): SessionResult<Value> =>
      effect.pipe(Effect.tap(() => sections.request("local-mutation")));
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
      if (existing.thread) {
        yield* attempt(
          "rename-title",
          threadTitles.set({
            threadId: existing.thread.threadId,
            name: command.payload.input.title,
            normalization: "manual",
          }),
        );
      }
      return yield* attempt(
        "rename-session",
        workspace.renameProjectSession({
          ...command,
          payload: { ...command.payload, input: { title } },
        }),
      );
    }, syncSections);

    const deleteSession = Effect.fn("ProjectSessionCommands.delete")(function* (
      command: ProjectSessionDeleteCommandInput,
    ) {
      const result = yield* attempt("delete-session", workspace.deleteProjectSession(command));
      yield* closeBrowserConversation(command.payload.sessionId);
      return result;
    }, syncSections);

    const setArchived = Effect.fn("ProjectSessionCommands.setArchived")(function* (
      command: ProjectSessionArchiveCommandInput,
      archived: boolean,
    ) {
      const existing = yield* read(command.payload.sessionId);
      if (existing?.thread) {
        if (archived) {
          yield* attempt("archive-conversation", conversation.archive(existing.thread.threadId));
        } else {
          yield* attempt(
            "unarchive-conversation",
            conversation.unarchive(existing.thread.threadId),
          );
        }
      }
      return yield* attempt(
        archived ? "archive-session" : "unarchive-session",
        archived
          ? workspace.archiveProjectSession(command)
          : workspace.unarchiveProjectSession(command),
      );
    }, syncSections);

    const setPinned = Effect.fn("ProjectSessionCommands.setPinned")(function* (
      command: ProjectSessionPinnedCommandInput,
    ) {
      return yield* attempt("set-pinned", workspace.setProjectSessionPinned(command));
    }, syncSections);

    return ProjectSessionCommands.of({
      rename,
      delete: deleteSession,
      archive: (command) => setArchived(command, true),
      unarchive: (command) => setArchived(command, false),
      setPinned,
    });
  }),
);
