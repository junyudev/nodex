import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProjectArchiveBlocker, ProjectSessionSummary } from "../../shared/types";
import {
  AgentRuntimeApplication,
  type AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";

export interface ProjectArchiveOwnership {
  readonly project: { readonly id: string };
  readonly sessions: readonly ProjectSessionSummary[];
}

export class ProjectArchiveBlockers extends Context.Service<
  ProjectArchiveBlockers,
  {
    /** Reads the Project's execution metadata, including child Runs and native background work. */
    readonly list: (
      ownership: ProjectArchiveOwnership,
    ) => Effect.Effect<readonly ProjectArchiveBlocker[], AgentRuntimeApplicationError>;
  }
>()("nodex/main/project-application/ProjectArchiveBlockers") {}

export const live: Layer.Layer<
  ProjectArchiveBlockers,
  never,
  AgentRuntimeApplication | TerminalSessions
> = Layer.effect(
  ProjectArchiveBlockers,
  Effect.gen(function* () {
    const execution = yield* AgentRuntimeApplication;
    const terminals = yield* TerminalSessions;
    const list = Effect.fn("ProjectArchiveBlockers.list")(function* (
      ownership: ProjectArchiveOwnership,
    ) {
      const activity = yield* execution.projectActivity(ownership.project.id);
      const terminalSnapshots = yield* terminals.listLiveSessionsForOwners({
        conversationIds: new Set(
          ownership.sessions.flatMap((session) =>
            session.executionRef ? [session.executionRef.threadId] : [],
          ),
        ),
        projectSessionIds: new Set(ownership.sessions.map((session) => session.id)),
      });
      const blockers: ProjectArchiveBlocker[] = terminalSnapshots.map((session) => ({
        kind: "terminal",
        terminalSessionId: session.sessionId,
        projectSessionId: session.projectSessionId,
      }));
      if (activity.run)
        blockers.push({ kind: "active-turn", threadId: activity.run.threadId, label: null });
      if (activity.runtimeRequest)
        blockers.push({
          kind: "pending-request",
          threadId: activity.runtimeRequest.threadId,
          label: null,
        });
      if (activity.nativeBackground)
        blockers.push({
          kind: "background-process",
          threadId: activity.nativeBackground.threadId,
          processId: activity.nativeBackground.taskId,
          label: null,
        });
      return blockers;
    });
    return ProjectArchiveBlockers.of({ list });
  }),
);
