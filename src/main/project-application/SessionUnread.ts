import * as Effect from "effect/Effect";
import type { ProjectSession, ProjectSessionThreadLink } from "../../shared/types";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { ProjectWorkspace } from "./ProjectWorkspace";

export type SessionUnreadTarget = Pick<ProjectSession, "id" | "executionRef"> & {
  readonly thread: Pick<ProjectSessionThreadLink, "threadId" | "backendBinding"> | null;
};

/** Native Threads use authenticated identity state; other Sessions use Core organization state. */
export const makeSetSessionUnread = Effect.gen(function* () {
  const native = yield* CodexThreadReadState;
  const workspace = yield* ProjectWorkspace;
  return Effect.fn("SessionUnread.set")(function* (
    session: SessionUnreadTarget,
    unread: boolean,
    operationId: string,
  ) {
    if (session.thread && !session.executionRef && session.thread.backendBinding.kind === "codex")
      return {
        changed: yield* native.set({ threadId: session.thread.threadId, hasUnreadTurn: unread }),
      };
    const result = yield* workspace.markProjectSessionUnread({
      operationId,
      payload: { sessionId: session.id, unread },
    });
    return result.apply;
  });
});
