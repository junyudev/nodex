import * as Effect from "effect/Effect";
import { readHostedAppToolSessionContext, type AppToolCaller } from "./AppToolCaller";
import type { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export interface AppToolCallingSession {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly threadId: string;
  readonly runId: string | null;
  readonly hostId: string;
  readonly cwd: string | null;
}

/** Locates a verified product Session; it does not confer authority to perform an operation. */
export const resolveAppToolCallingSession = (
  caller: AppToolCaller,
  workspace: Pick<ProjectWorkspace["Service"], "getThread">,
): Effect.Effect<AppToolCallingSession | null> =>
  Effect.gen(function* () {
    if (!caller.isActive()) return null;
    const hosted = readHostedAppToolSessionContext(caller);
    if (hosted) return { ...hosted, hostId: caller.hostId };
    if (caller.threadId.startsWith("runtime:") || caller.turnId.startsWith("runtime-run:"))
      return null;
    const thread = yield* workspace
      .getThread(caller.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!caller.isActive() || !thread?.sessionId || thread.executionHostId !== caller.hostId)
      return null;
    return {
      sessionId: thread.sessionId,
      projectId: thread.projectId,
      threadId: caller.threadId,
      runId: caller.turnId,
      hostId: thread.executionHostId,
      cwd: thread.cwd,
    };
  });
