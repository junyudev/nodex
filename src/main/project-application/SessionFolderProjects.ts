import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type {
  FolderPlacement,
  SortChatsDestination,
  SortChatsPreview,
  SortChatsResult,
} from "../../shared/folder-placement";
import type { ProjectSessionSummaryWindow } from "../../shared/types";
import type { SessionFolders } from "../agent-backend/SessionFolders";
import { SessionFolderError } from "../agent-backend/SessionFolders";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { createOperationId } from "../core-runtime/operation-identity";
import type { ProjectWorkspace } from "./ProjectWorkspace";
import {
  ensurePlacedProject,
  projectForFolder,
  readFolderPlacements,
  resolveAndEnsureFolderProject,
} from "./FolderPlacement";

interface FolderProjects {
  readonly folders: Pick<SessionFolders["Service"], "existing">;
  readonly projects: Pick<
    ProjectWorkspace["Service"],
    "getProjectSession" | "getProject" | "listProjectWindow" | "createProject"
  >;
  readonly places: Parameters<typeof readFolderPlacements>[1];
  readonly move: AgentRuntimeApplication["Service"]["moveSession"];
  readonly readExecutionCwd: NonNullable<
    Parameters<SessionFolders["Service"]["existing"]>[1]
  >["readExecutionCwd"];
}

const failure = (message: string) => new SessionFolderError({ message, cause: undefined });

/** Uses the same Project and Session commands as ordinary creation and placement. */
export const turnSessionFolderIntoProject = Effect.fn("SessionFolderProjects.turnIntoProject")(
  function* (input: FolderProjects & { readonly sessionId: string; readonly name?: string }) {
    const { sessionId, projects, places, folders, name, readExecutionCwd } = input;
    const session = yield* projects.getProjectSession(sessionId);
    if (!session) return yield* failure("Chat is unavailable");

    if (session.projectId !== null) {
      // A committed move may still need to reconcile the execution placement on retry.
      const project = yield* projects.getProject(session.projectId);
      const root = project?.primaryWorkspaceRoot;
      const folder = yield* folders.existing(sessionId, { readExecutionCwd });
      const [placement] = folder
        ? yield* readFolderPlacements(projects, places, [folder.path], true)
        : [];
      if (
        project?.lifecycle !== "active" ||
        (placement?.kind === "project"
          ? placement.projectId !== session.projectId
          : !root || projectForFolder(root) !== session.projectId)
      )
        return yield* failure("This chat already belongs to a Project");
      yield* input.move({
        sessionId,
        projectId: session.projectId,
        operationId: createOperationId("session-folder.move-to-project"),
      });
      return { projectId: session.projectId };
    }

    const folder = yield* folders.existing(sessionId, { readExecutionCwd });
    if (!folder) return yield* failure("This chat has no folder");
    const placement = yield* resolveAndEnsureFolderProject({
      projects,
      places,
      folder: folder.path,
      explicit: true,
      name,
    });
    if (placement.kind !== "project")
      return yield* failure("The Project for this Chat folder is unavailable");

    yield* input.move({
      sessionId,
      projectId: placement.projectId,
      operationId: createOperationId("session-folder.move-to-project"),
      onlyProjectless: true,
    });
    return { projectId: placement.projectId };
  },
);

type SortInput = FolderProjects & {
  readonly projects: FolderProjects["projects"] &
    Pick<ProjectWorkspace["Service"], "listProjectSessionSummaryWindow">;
};

const planChatSort = Effect.fn("SessionFolderProjects.planChatSort")(function* (input: SortInput) {
  const { projects, folders, places, readExecutionCwd } = input;
  const chats: { sessionId: string; folder: string }[] = [];
  let after: string | null = null;
  do {
    const page: ProjectSessionSummaryWindow = yield* projects.listProjectSessionSummaryWindow(
      null,
      { after },
    );
    const located = yield* Effect.forEach(
      page.items,
      (session) =>
        folders.existing(session.id, { readExecutionCwd }).pipe(
          Effect.map((folder) => (folder ? { sessionId: session.id, folder: folder.path } : null)),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 8 },
    );
    chats.push(...located.flatMap((chat) => (chat ? [chat] : [])));
    after = page.nextCursor;
  } while (after !== null);
  const placements = yield* readFolderPlacements(
    projects,
    places,
    chats.map(({ folder }) => folder),
  );
  return chats.flatMap((chat, index) => {
    const placement = placements[index];
    return placement && placement.kind !== "missing" ? [{ ...chat, placement }] : [];
  });
});

const chatSortPlanId = (plan: Effect.Success<ReturnType<typeof planChatSort>>) =>
  createHash("sha256")
    .update(
      JSON.stringify(plan.toSorted((left, right) => left.sessionId.localeCompare(right.sessionId))),
    )
    .digest("hex");

export const previewChatSort = Effect.fn("SessionFolderProjects.previewChatSort")(function* (
  input: SortInput,
): Effect.fn.Return<SortChatsPreview, Effect.Error<ReturnType<typeof planChatSort>>> {
  const plan = yield* planChatSort(input);
  const counts = new Map<string | null, SortChatsDestination>();
  for (const { placement } of plan) {
    const key = placement.kind === "chats" ? null : placement.projectId;
    counts.set(key, { placement, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return { planId: chatSortPlanId(plan), destinations: [...counts.values()] };
});

export const sortChatsIntoProjects = Effect.fn("SessionFolderProjects.sortChats")(function* (
  input: SortInput,
  planId: string,
): Effect.fn.Return<
  SortChatsResult,
  Effect.Error<ReturnType<typeof planChatSort>> | SessionFolderError
> {
  const plan = yield* planChatSort(input);
  if (chatSortPlanId(plan) !== planId)
    return yield* failure("Chat placement changed. Review the updated preview and try again.");

  const projects = new Map<string, FolderPlacement | null>();
  const targets = plan.flatMap(({ sessionId, placement }) =>
    placement.kind === "chats" ? [] : [{ sessionId, placement }],
  );
  for (const { placement } of targets) {
    if (projects.has(placement.projectId)) continue;
    const project =
      placement.kind === "project"
        ? placement
        : yield* ensurePlacedProject(input.projects, placement).pipe(
            Effect.orElseSucceed(() => null),
          );
    projects.set(placement.projectId, project);
  }
  let moved = 0;
  for (const { sessionId, placement } of targets) {
    if (projects.get(placement.projectId)?.kind !== "project") continue;
    const movedChat = yield* input
      .move({
        sessionId,
        projectId: placement.projectId,
        operationId: createOperationId("session-folder.sort-chat"),
        onlyProjectless: true,
      })
      .pipe(
        Effect.match({
          onSuccess: () => true,
          onFailure: (cause) => cause.committedOperationId !== undefined,
        }),
      );
    if (movedChat) moved += 1;
  }
  return { moved, skipped: targets.length - moved };
});
