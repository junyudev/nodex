import * as Effect from "effect/Effect";
import type { CodexChildThreadSummaryInput } from "../../shared/codex-child-thread-summary";
import { CoreModuleResponseError } from "../core-client/core-client";
import {
  projectWorkspaceSessionFromCore,
  projectWorkspaceSessionThreadFromCore,
} from "../core-client/project-workspace-adapter";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreRuntimeError, coreRuntimeError } from "../core-runtime/CoreRuntimeError";

/** A source label cannot override the current atomic Core root/host/Session binding. */
export const readCodexLinkedRootSession = Effect.fn("CodexLinkedRootSession.read")(function* (
  core: CoreModules["Service"],
  input: CodexChildThreadSummaryInput,
) {
  const result = yield* core.workspace
    .read({
      kind: "codex_thread_session",
      thread_id: input.threadId,
      expected_execution_host_id: input.hostId,
    })
    .pipe(
      Effect.catch((cause) =>
        cause instanceof CoreRuntimeError &&
        cause.cause instanceof CoreModuleResponseError &&
        cause.cause.coreError.code === "not_found"
          ? Effect.succeed(null)
          : Effect.fail(cause),
      ),
    );
  if (result === null) return null;
  if (result.value.kind !== "codex_thread_session")
    return yield* coreRuntimeError({
      operation: "workspace.read",
      reason: "protocol",
      retryable: false,
      cause: new Error("Core returned an unconfirmed root Session"),
    });
  const { thread, session } = result.value;
  if (thread.thread_source === "system" || thread.thread_source === "composer_predictions")
    return null;
  return projectWorkspaceSessionFromCore(
    session,
    projectWorkspaceSessionThreadFromCore(thread, session.id, session.project_id ?? null),
  );
});
