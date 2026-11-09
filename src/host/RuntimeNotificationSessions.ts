import * as Effect from "effect/Effect";
import { CoreApplicationAgent } from "../main/core-runtime/CoreApplicationAgent";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import type { AgentRuntimeNotificationSession } from "../main/agent-runtime/AgentRuntimeSessionNotifications";

/** Core owns chat titles, archive state and the source of a temporary side chat. */
export const makeSessionReader = Effect.gen(function* () {
  const projects = yield* ProjectWorkspace;
  const modules = yield* CoreModules;
  return Effect.fn("RuntimeNotificationSessions.read")(function* (
    sessionId: string,
  ): Effect.fn.Return<AgentRuntimeNotificationSession | null, unknown> {
    const session = yield* projects.getProjectSession(sessionId);
    if (!session) return null;
    const snapshot = yield* modules.workspace
      .read({
        kind: "agent_runtime_session_binding",
        session_id: sessionId,
      })
      .pipe(Effect.provideService(CoreApplicationAgent, null));
    const binding =
      snapshot.value.kind === "agent_runtime_session_binding" ? snapshot.value.binding : null;
    const sourceSessionId = binding?.side_chat_source_session_id;
    const source = sourceSessionId ? yield* projects.getProjectSession(sourceSessionId) : null;
    return {
      title: session.displayTitle,
      archived: session.archived,
      unread: session.unread,
      sideChatSource: sourceSessionId
        ? {
            sessionId: sourceSessionId,
            rootThreadId: (source && !source.archived && source.executionRef?.threadId) || null,
          }
        : null,
    };
  });
});
