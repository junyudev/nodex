import { basename } from "node:path";
import * as Effect from "effect/Effect";
import { v5 } from "uuid";
import {
  areWorkspacePathsEquivalent,
  normalizeCodexPathIdentity,
} from "../../shared/codex-workspace-paths";
import type { SessionFolders } from "../agent-backend/SessionFolders";
import { SessionFolderError } from "../agent-backend/SessionFolders";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { resolveChosenChatDirectory } from "../codex/codex-projectless-workspace";
import { createOperationId } from "../core-runtime/operation-identity";
import type { ProjectWorkspace } from "./ProjectWorkspace";

const projectForFolder = (directory: string) =>
  v5(`nodex:chat-folder:${normalizeCodexPathIdentity(directory)}`, v5.URL);
const failure = (message: string, cause?: unknown) => new SessionFolderError({ message, cause });

/** Uses the same Project and Session commands as ordinary creation and placement. */
export const turnSessionFolderIntoProject = Effect.fn("SessionFolderProjects.turnIntoProject")(
  function* (input: {
    readonly sessionId: string;
    readonly name?: string;
    readonly folders: Pick<SessionFolders["Service"], "existing">;
    readonly projects: Pick<
      ProjectWorkspace["Service"],
      "getProjectSession" | "getProject" | "listProjectWindow" | "createProject"
    >;
    readonly move: AgentRuntimeApplication["Service"]["moveSession"];
    readonly readExecutionCwd: NonNullable<
      Parameters<SessionFolders["Service"]["existing"]>[1]
    >["readExecutionCwd"];
  }) {
    const { sessionId, projects, folders } = input;
    const session = yield* projects.getProjectSession(sessionId);
    if (!session) return yield* failure("Chat is unavailable");

    if (session.projectId !== null) {
      // The earlier move may have committed before its caller observed the result.
      const project = yield* projects.getProject(session.projectId);
      const primary = project?.primaryWorkspaceRoot;
      if (
        project?.lifecycle !== "active" ||
        !primary ||
        projectForFolder(primary) !== session.projectId
      )
        return yield* failure("This chat already belongs to a Project");
      yield* input.move({
        sessionId,
        projectId: session.projectId,
        operationId: createOperationId("session-folder.move-to-project"),
      });
      return { projectId: session.projectId };
    }

    const folder = yield* folders.existing(sessionId, { readExecutionCwd: input.readExecutionCwd });
    if (!folder) return yield* failure("This chat has no folder");
    const directory = yield* Effect.tryPromise({
      try: () => resolveChosenChatDirectory(folder.path),
      catch: (cause) => failure("The Chat folder is unavailable", cause),
    });
    const projectId = projectForFolder(directory);
    const name = input.name?.trim() || basename(directory);
    if (!name) return yield* failure("Enter a name for the Project");
    const usesDirectory = (root: string) => areWorkspacePathsEquivalent(root, directory);
    let after: string | null = null;
    do {
      const page: import("../../shared/types").ProjectWindow = yield* projects.listProjectWindow({
        after,
        includeArchived: true,
      });
      const owner = page.items.find(
        (project) =>
          project.id !== projectId &&
          project.sources.some(
            (source) => source.kind === "directory" && usesDirectory(source.path),
          ),
      );
      if (owner) return yield* failure(`The Chat folder is already a source for ${owner.name}`);
      after = page.nextCursor;
    } while (after !== null);

    const existing = yield* projects.getProject(projectId);
    const project =
      existing ??
      (yield* projects
        .createProject({
          operationId: createOperationId("session-folder.create-project"),
          payload: { projectId, input: { name, sources: [directory] } },
        })
        .pipe(
          Effect.map(({ value }) => value),
          Effect.catch((cause) =>
            projects
              .getProject(projectId)
              .pipe(
                Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.fail(cause))),
              ),
          ),
        ));
    if (
      project.lifecycle !== "active" ||
      !project.primaryWorkspaceRoot ||
      !usesDirectory(project.primaryWorkspaceRoot)
    )
      return yield* failure("The Project created for this Chat folder is unavailable");

    yield* input.move({
      sessionId,
      projectId,
      operationId: createOperationId("session-folder.move-to-project"),
    });
    return { projectId };
  },
);
