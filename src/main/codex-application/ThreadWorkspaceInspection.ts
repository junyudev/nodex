import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { localProjectSourceRoots } from "../../shared/project-sources";
import type { ThreadWorkspaceAvailability } from "../../shared/types";
import { readActionableErrorMessage } from "../actionable-error-message";
import { normalizeWorktreePathForIdentity } from "../codex/codex-managed-worktree-effects";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ManagedWorktreeRuntime, type ManagedWorktreeInspectInput } from "./ManagedWorktreeRuntime";

export type ThreadWorkspaceLocation = Pick<
  CodexThreadExecutionLocation,
  "hostId" | "cwd" | "managedWorktreePath" | "projectId"
>;

export const makeThreadWorkspaceInspection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* ProjectWorkspace;
  const managed = yield* ManagedWorktreeRuntime;
  const localDirectory = (directory: string) =>
    fs.stat(directory).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catch((error) => {
        const cause = "cause" in error.reason ? error.reason.cause : undefined;
        if (
          error.reason._tag === "NotFound" ||
          (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR")
        )
          return Effect.succeed(false);
        return Effect.fail(error);
      }),
    );
  const unavailable = (cause: unknown): ThreadWorkspaceAvailability => ({
    state: "unavailable",
    reason: "inspection-failed",
    message: readActionableErrorMessage(cause, {
      fallback: "Could not check the chat's working directory",
    }),
  });
  const sourceRoots = (projectId: string | null) =>
    projectId
      ? workspace
          .getProject(projectId)
          .pipe(
            Effect.map((project) =>
              localProjectSourceRoots(project?.sources ?? []).filter((root) =>
                path.isAbsolute(root),
              ),
            ),
          )
      : Effect.succeed([]);

  const candidateRepositories = Effect.fn("ThreadWorkspaceInspection.candidateRepositories")(
    function* (
      location: ThreadWorkspaceLocation,
      worktreeGitRoot: string,
      roots: readonly string[],
    ) {
      if (roots.length > 0) return roots;
      const inventory = yield* managed.list(location.hostId).pipe(Effect.orElseSucceed(() => null));
      const key = normalizeWorktreePathForIdentity(worktreeGitRoot);
      return (inventory?.entries ?? []).flatMap((entry) =>
        entry.repositoryPath && normalizeWorktreePathForIdentity(entry.worktreeGitRoot) === key
          ? [entry.repositoryPath]
          : [],
      );
    },
  );

  const managedInput = Effect.fn("ThreadWorkspaceInspection.managedInput")(function* (
    location: ThreadWorkspaceLocation,
    worktreeGitRoot: string,
  ) {
    const roots = yield* sourceRoots(location.projectId);
    return {
      hostId: location.hostId,
      cwd: location.cwd,
      worktreeGitRoot,
      candidateRepositoryPaths: yield* candidateRepositories(location, worktreeGitRoot, roots),
    } satisfies ManagedWorktreeInspectInput;
  });

  const inspect = Effect.fn("ThreadWorkspaceInspection.inspect")(
    function* (location: ThreadWorkspaceLocation | null, options?: { readonly fresh: boolean }) {
      if (!location) return unavailable(new Error("The chat has no working directory"));
      const { hostId, cwd, managedWorktreePath } = location;
      const local = hostId === "local";
      if (local && !path.isAbsolute(cwd))
        return unavailable(new Error("The chat has no working directory"));
      if (local ? yield* localDirectory(cwd) : managedWorktreePath === null)
        return { state: "available" } satisfies ThreadWorkspaceAvailability;

      const nestedCwdMissing = {
        state: "gone",
        worktree: false,
        projectCheckout: null,
      } as const satisfies ThreadWorkspaceAvailability;
      if (local && managedWorktreePath && (yield* localDirectory(managedWorktreePath)))
        return nestedCwdMissing;

      const roots = yield* sourceRoots(location.projectId);
      const snapshot = managedWorktreePath
        ? (yield* managed.inspect(
            {
              hostId,
              cwd,
              worktreeGitRoot: managedWorktreePath,
              candidateRepositoryPaths: yield* candidateRepositories(
                location,
                managedWorktreePath,
                roots,
              ),
            },
            options,
          )).availability
        : ({ state: "gone", worktree: false } as const);
      if (snapshot.state !== "gone" && snapshot.state !== "restorable") return snapshot;
      if (snapshot.state === "gone" && managedWorktreePath && !snapshot.worktree)
        return nestedCwdMissing;

      const checkout = roots[0];
      const projectCheckout =
        local &&
        checkout &&
        normalizeWorktreePathForIdentity(checkout) !== normalizeWorktreePathForIdentity(cwd) &&
        (yield* localDirectory(checkout).pipe(Effect.orElseSucceed(() => false)))
          ? checkout
          : null;
      return { ...snapshot, projectCheckout };
    },
    Effect.catch((cause) => Effect.succeed(unavailable(cause))),
  );
  return { inspect, managedInput, localDirectory, unavailable };
});
