import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import type { ProjectArchiveBlocker, ProjectSessionSummary } from "../../shared/types";
import {
  CodexBackgroundProcesses,
  type CodexBackgroundProcessesError,
} from "../codex-application/CodexBackgroundProcesses";
import { CodexConversations } from "../codex-application/CodexConversations";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";

export interface ProjectArchiveOwnership {
  readonly sessions: readonly ProjectSessionSummary[];
}

export class ProjectArchiveBlockers extends Context.Service<
  ProjectArchiveBlockers,
  {
    /** Reads every live activity owner that makes a Project archive unsafe. */
    readonly list: (
      ownership: ProjectArchiveOwnership,
    ) => Effect.Effect<readonly ProjectArchiveBlocker[], CodexBackgroundProcessesError>;
  }
>()("nodex/main/project-application/ProjectArchiveBlockers") {}

const deduplicate = (blockers: readonly ProjectArchiveBlocker[]): ProjectArchiveBlocker[] => {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key =
      blocker.kind === "terminal"
        ? `${blocker.kind}:${blocker.terminalSessionId}`
        : blocker.kind === "background-process"
          ? `${blocker.kind}:${blocker.threadId}:${blocker.processId ?? blocker.label ?? "unknown"}`
          : `${blocker.kind}:${blocker.threadId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const live: Layer.Layer<
  ProjectArchiveBlockers,
  never,
  CodexBackgroundProcesses | CodexConversations | TerminalSessions
> = Layer.effect(
  ProjectArchiveBlockers,
  Effect.gen(function* () {
    const backgroundProcesses = yield* CodexBackgroundProcesses;
    const conversations = yield* CodexConversations;
    const terminals = yield* TerminalSessions;

    const list = Effect.fn("ProjectArchiveBlockers.list")(function* (
      ownership: ProjectArchiveOwnership,
    ) {
      const sessionIds = new Set(ownership.sessions.map((session) => session.id));
      const threadSummaries = ownership.sessions.flatMap((session) =>
        session.thread ? [session.thread] : [],
      );
      const threadIds = [...new Set(threadSummaries.map((thread) => thread.threadId))];
      const codexThreadIds = [
        ...new Set(
          threadSummaries.flatMap((thread) =>
            isCodexAgentBackendBinding(thread.backendBinding) ? [thread.threadId] : [],
          ),
        ),
      ];
      const durableThreadById = new Map(
        threadSummaries.map((thread) => [thread.threadId, thread] as const),
      );
      const agentBlockers = threadIds.flatMap<ProjectArchiveBlocker>((threadId) => {
        const durable = durableThreadById.get(threadId);
        const current =
          durable && isCodexAgentBackendBinding(durable.backendBinding)
            ? conversations.activity(threadId)
            : { active: false, pending: false, label: null };
        const label = current.label || durable?.threadName?.trim() || null;
        const active = current.active || durable?.statusType === "active";
        const pending = current.pending || (durable?.statusActiveFlags.length ?? 0) > 0;
        return [
          ...(active ? [{ kind: "active-turn", threadId, label } as const] : []),
          ...(pending ? [{ kind: "pending-request", threadId, label } as const] : []),
        ];
      });
      const terminalSnapshots = yield* terminals.listLiveSessionsForOwners({
        conversationIds: new Set(threadIds),
        projectSessionIds: sessionIds,
      });
      const terminalBlockers = terminalSnapshots.map<ProjectArchiveBlocker>((session) => ({
        kind: "terminal",
        terminalSessionId: session.sessionId,
        projectSessionId: session.projectSessionId,
      }));
      const processRows = yield* Effect.all(
        codexThreadIds.map((threadId) => backgroundProcesses.list({ threadId })),
        { concurrency: "unbounded" },
      );
      const processBlockers = processRows.flatMap((rows) =>
        rows.flatMap<ProjectArchiveBlocker>((row) =>
          row.status === "running"
            ? [
                {
                  kind: "background-process",
                  threadId: row.threadId,
                  processId: row.processId,
                  label: row.command.trim() || row.threadTitle?.trim() || null,
                },
              ]
            : [],
        ),
      );
      return deduplicate([...agentBlockers, ...terminalBlockers, ...processBlockers]);
    });

    return ProjectArchiveBlockers.of({ list });
  }),
);
