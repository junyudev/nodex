import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  Project,
  ProjectSessionSummary,
  ProjectSessionSummaryWindow,
} from "../../shared/types";
import type {
  ProjectLifecycleCommandInput,
  ProjectLifecycleCommandRejected,
  ProjectLifecycleCommittedValue,
} from "../../shared/workspace-catalog-commands";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { ProjectArchiveBlockers } from "./ProjectArchiveBlockers";
import {
  ProjectWorkspace,
  type ProjectWorkspaceCommandResult,
  type ProjectWorkspaceError,
} from "./ProjectWorkspace";

export type ProjectLifecycleCommandExecution =
  | {
      readonly kind: "committed";
      readonly result: ProjectWorkspaceCommandResult<ProjectLifecycleCommittedValue>;
    }
  | { readonly kind: "rejected"; readonly result: ProjectLifecycleCommandRejected };

export class ProjectLifecycleCommandsError extends Schema.TaggedError<ProjectLifecycleCommandsError>()(
  "ProjectLifecycleCommandsError",
  {
    operation: Schema.Literals(["read-project", "read-ownership", "read-blockers", "commit"]),
    cause: Schema.Defect(),
  },
) {}

export class ProjectLifecycleCommands extends Context.Service<
  ProjectLifecycleCommands,
  {
    readonly setLifecycle: (
      command: ProjectLifecycleCommandInput,
    ) => Effect.Effect<ProjectLifecycleCommandExecution, ProjectLifecycleCommandsError>;
  }
>()("nodex/main/project-application/ProjectLifecycleCommands") {}

interface ProjectOwnershipSnapshot {
  readonly project: Project;
  readonly sessions: readonly ProjectSessionSummary[];
}

export const live: Layer.Layer<
  ProjectLifecycleCommands,
  never,
  | BrowserApplication
  | ProjectArchiveBlockers
  | ProjectRuntimeLifecycleRuntime
  | ProjectWorkspace
  | TerminalSessions
> = Layer.effect(
  ProjectLifecycleCommands,
  Effect.gen(function* () {
    const blockers = yield* ProjectArchiveBlockers;
    const browser = yield* BrowserApplication;
    const lifecycleRuntime = yield* ProjectRuntimeLifecycleRuntime;
    const workspace = yield* ProjectWorkspace;
    const terminals = yield* TerminalSessions;

    const project = <A>(
      operation: ProjectLifecycleCommandsError["operation"],
      effect: Effect.Effect<A, ProjectWorkspaceError>,
    ): Effect.Effect<A, ProjectLifecycleCommandsError> =>
      effect.pipe(
        Effect.mapError((cause) => new ProjectLifecycleCommandsError({ operation, cause })),
      );

    const readOwnership = Effect.fn("ProjectLifecycleCommands.readOwnership")(function* (
      ownedProject: Project,
    ) {
      const sessions: ProjectSessionSummary[] = [];
      let after: string | null = null;
      do {
        const window: ProjectSessionSummaryWindow = yield* project(
          "read-ownership",
          workspace.listProjectSessionSummaryWindow(ownedProject.id, {
            includeArchived: true,
            after,
            first: 200,
          }),
        );
        sessions.push(...window.items);
        after = window.nextCursor;
      } while (after !== null);
      return { project: ownedProject, sessions } satisfies ProjectOwnershipSnapshot;
    });

    const readBlockers = Effect.fn("ProjectLifecycleCommands.readBlockers")(function* (
      ownership: ProjectOwnershipSnapshot,
    ) {
      return yield* blockers
        .list(ownership)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectLifecycleCommandsError({ operation: "read-blockers", cause }),
          ),
        );
    });

    const cleanupOwnership = Effect.fn("ProjectLifecycleCommands.cleanupOwnership")(function* (
      ownership: ProjectOwnershipSnapshot,
    ) {
      const conversationIds = new Set(
        ownership.sessions.flatMap((session) => (session.thread ? [session.thread.threadId] : [])),
      );
      const projectSessionIds = new Set(ownership.sessions.map((session) => session.id));
      const tasks = [
        ...ownership.sessions.map((session) => ({
          label: `browser-conversation:${session.id}`,
          effect: browser.closeConversation(session.id),
        })),
        {
          label: `browser-project:${ownership.project.id}`,
          effect: browser.localServers.closeProject(ownership.project.id),
        },
        {
          label: `exited-terminals:${ownership.project.id}`,
          effect: terminals.discardExitedSessionsForOwners({
            conversationIds,
            projectSessionIds,
          }),
        },
      ];
      const results = yield* Effect.all(
        tasks.map(({ effect, label }) =>
          effect.pipe(
            Effect.as<null>(null),
            Effect.exit,
            Effect.map((exit) => ({ exit, label })),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const failures = results.flatMap(({ exit, label }) =>
        Exit.isFailure(exit) ? [{ label, error: Cause.pretty(exit.cause) }] : [],
      );
      if (failures.length === 0) return;
      yield* Effect.logWarning("Project runtime cleanup completed with failures").pipe(
        Effect.annotateLogs({ projectId: ownership.project.id, failures }),
      );
    });

    const archive = Effect.fn("ProjectLifecycleCommands.archive")(function* (
      command: ProjectLifecycleCommandInput,
      ownedProject: Project,
    ) {
      const preflightOwnership = yield* readOwnership(ownedProject);
      if (ownedProject.lifecycle !== "archived") {
        const preflightBlockers = yield* readBlockers(preflightOwnership);
        if (preflightBlockers.length > 0) {
          return {
            kind: "rejected",
            result: {
              ok: false,
              outcome: {
                kind: "blocked",
                project: ownedProject,
                blockers: [...preflightBlockers],
              },
            },
          } satisfies ProjectLifecycleCommandExecution;
        }
      }

      const commitOwnership = yield* readOwnership(ownedProject);
      if (ownedProject.lifecycle !== "archived") {
        const commitBlockers = yield* readBlockers(commitOwnership);
        if (commitBlockers.length > 0) {
          return {
            kind: "rejected",
            result: {
              ok: false,
              outcome: {
                kind: "blocked",
                project: ownedProject,
                blockers: [...commitBlockers],
              },
            },
          } satisfies ProjectLifecycleCommandExecution;
        }
      }
      const committed = yield* project("commit", workspace.setProjectLifecycle(command));
      yield* cleanupOwnership(commitOwnership);
      return {
        kind: "committed",
        result: {
          ...committed,
          value: {
            kind: "updated",
            project: committed.value,
            changed: ownedProject.lifecycle !== "archived",
          },
        },
      } satisfies ProjectLifecycleCommandExecution;
    });

    const setLifecycle = Effect.fn("ProjectLifecycleCommands.setLifecycle")(function* (
      command: ProjectLifecycleCommandInput,
    ) {
      const { lifecycle, projectId } = command.payload;
      return yield* lifecycleRuntime.runExclusive(
        projectId,
        Effect.gen(function* () {
          const ownedProject = yield* project("read-project", workspace.getProject(projectId));
          if (!ownedProject) {
            return {
              kind: "rejected",
              result: { ok: false, outcome: { kind: "not-found" } },
            } satisfies ProjectLifecycleCommandExecution;
          }
          if (lifecycle === "archived") return yield* archive(command, ownedProject);
          const committed = yield* project("commit", workspace.setProjectLifecycle(command));
          return {
            kind: "committed",
            result: {
              ...committed,
              value: {
                kind: "updated",
                project: committed.value,
                changed: ownedProject.lifecycle !== "active",
              },
            },
          } satisfies ProjectLifecycleCommandExecution;
        }),
      );
    });

    return ProjectLifecycleCommands.of({ setLifecycle });
  }),
);
