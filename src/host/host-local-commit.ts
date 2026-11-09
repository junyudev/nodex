import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CoreLocalCommitResult } from "../shared/core-result";
import { CoreModuleResponseError } from "../main/core-client/core-client";
import { rendererLocalCommitApply } from "../main/core-client/types";
import { CoreRuntimeError } from "../main/core-runtime/CoreRuntimeError";
import { AgentRuntimeApplicationError } from "../main/agent-runtime/AgentRuntimeApplication";
import {
  ProjectWorkspaceError,
  type ProjectWorkspaceCommandResult,
} from "../main/project-application/ProjectWorkspace";
import { ProjectSessionCommandsError } from "../main/project-application/ProjectSessionCommands";
import { InboxApplicationError } from "./inbox-application/InboxApplication";

/** Core's typed refusal behind an application failure, unless the command may have committed. */
const coreRejection = (cause: unknown): CoreModuleResponseError | null => {
  if (cause instanceof CoreModuleResponseError) return cause;
  if (Schema.is(InboxApplicationError)(cause))
    return cause.mayHaveCommitted ? null : coreRejection(cause.cause);
  if (
    Schema.is(AgentRuntimeApplicationError)(cause) ||
    Schema.is(ProjectSessionCommandsError)(cause)
  )
    return cause.committedOperationId ? null : coreRejection(cause.cause);
  if (Schema.is(CoreRuntimeError)(cause) || Schema.is(ProjectWorkspaceError)(cause))
    return coreRejection(cause.cause);
  return null;
};

/** One command result for a local window or a Member's Device through the Space host: the
 * durable receipt, or Core's typed refusal, such as a changed suggestion or another Member's chat. */
export const hostLocalCommit = <Value, E>(
  task: Effect.Effect<ProjectWorkspaceCommandResult<Value>, E>,
): Effect.Effect<CoreLocalCommitResult<Value>, E> =>
  task.pipe(
    Effect.map(({ value, apply }) => ({
      ok: true as const,
      value,
      localCommit: rendererLocalCommitApply(apply),
    })),
    Effect.catch((cause) => {
      const rejection = coreRejection(cause);
      if (!rejection) return Effect.fail(cause);
      return Effect.succeed({ ok: false as const, error: rejection.coreError });
    }),
  );
