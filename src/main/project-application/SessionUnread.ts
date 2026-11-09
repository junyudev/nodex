import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectSession, ProjectSessionThreadLink } from "../../shared/types";
import type { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { ProjectWorkspace } from "./ProjectWorkspace";

export class SessionUnreadUnavailable extends Schema.TaggedError<SessionUnreadUnavailable>()(
  "SessionUnreadUnavailable",
  { message: Schema.String },
) {}

export type SessionUnreadTarget = Pick<ProjectSession, "id" | "executionRef"> & {
  readonly thread: Pick<ProjectSessionThreadLink, "threadId" | "backendBinding"> | null;
};

/** Native Threads use authenticated identity state; other Sessions use Core organization state. */
export const makeSetSessionUnreadWithNative = (
  native: Pick<CodexThreadReadState["Service"], "set"> | null,
) =>
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    return Effect.fn("SessionUnread.set")(function* (
      session: SessionUnreadTarget,
      unread: boolean,
      operationId: string,
    ) {
      if (
        session.thread &&
        !session.executionRef &&
        session.thread.backendBinding.kind === "codex"
      ) {
        if (!native)
          return yield* new SessionUnreadUnavailable({
            message: "No native execution owner is available",
          });
        return {
          changed: yield* native.set({ threadId: session.thread.threadId, hasUnreadTurn: unread }),
        };
      }
      const result = yield* workspace.markProjectSessionUnread({
        operationId,
        payload: { sessionId: session.id, unread },
      });
      return result.apply;
    });
  });
