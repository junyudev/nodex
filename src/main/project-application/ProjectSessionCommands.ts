import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectSession } from "../../shared/types";
import type {
  ProjectSessionArchiveCommandInput,
  ProjectSessionDeleteCommandInput,
  ProjectSessionPinnedCommandInput,
  ProjectSessionRenameCommandInput,
} from "../../shared/workspace-catalog-commands";
import type { ProjectWorkspaceCommandResult } from "./ProjectWorkspace";

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
