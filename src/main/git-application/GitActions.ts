import { stat } from "node:fs/promises";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  GitActionMutationResult,
  GitCommitMessageGenerateInput,
  GitCommitMessageGenerateResult,
  GitCommitInput,
  GitPullRequestMessageGenerateInput,
  GitPullRequestMessageGenerateResult,
  GitPushInput,
  GitReviewPatchRequest,
  GitReviewPatchResult,
} from "../../shared/types";
import { boundGitDraftDiff, GIT_DRAFT_LIMITS } from "@nodex/agent-runtime/git-draft";
import { GitMessageGeneration, GitMessageGenerationError } from "./GitMessageGeneration";
import * as Schema from "effect/Schema";
import {
  GitActionOperationRuntime,
  type GitActionOperationRuntimeError,
} from "../host-runtime/GitActionOperationRuntime";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";

class GitActionsExecutionError extends Data.TaggedError("GitActionsExecutionError")<{
  readonly cause: unknown;
}> {}

export class GitActions extends Context.Service<
  GitActions,
  {
    readonly generateCommitMessage: (
      input: GitCommitMessageGenerateInput,
    ) => Effect.Effect<GitCommitMessageGenerateResult, GitActionOperationRuntimeError>;
    readonly generatePullRequestMessage: (
      input: GitPullRequestMessageGenerateInput,
    ) => Effect.Effect<GitPullRequestMessageGenerateResult, GitActionOperationRuntimeError>;
    readonly commit: (
      input: GitCommitInput,
    ) => Effect.Effect<GitActionMutationResult, GitActionOperationRuntimeError>;
    readonly push: (
      input: GitPushInput,
    ) => Effect.Effect<GitActionMutationResult, GitActionOperationRuntimeError>;
    readonly cancel: GitActionOperationRuntime["Service"]["cancel"];
  }
>()("nodex/main/git-application/GitActions") {}

const gitDraftError = (error: unknown) =>
  Schema.is(GitMessageGenerationError)(error) ? { errorCode: error.code } : {};

const gitErrorMessage = (error: unknown, fallback: string): string => {
  const cause = error instanceof GitActionsExecutionError ? error.cause : error;
  if (!(cause instanceof Error)) return fallback;
  const errorCode = (cause as { readonly code?: unknown }).code;
  if (cause.name === "AbortError" || errorCode === "ABORT_ERR") {
    return "Git action was canceled.";
  }
  const stderr = "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr.trim() : "";
  return stderr || cause.message || fallback;
};

const gitErrorStderr = (error: unknown): string => {
  const cause = error instanceof GitActionsExecutionError ? error.cause : error;
  if (!cause || typeof cause !== "object") return "";
  return "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr : "";
};

const mutationError = (
  cwd: string,
  branch: string | null,
  error: unknown,
  fallback: string,
): GitActionMutationResult => ({
  cwd,
  status: "error",
  branch,
  stdout: "",
  stderr: gitErrorStderr(error),
  errorMessage: gitErrorMessage(error, fallback),
  ...gitDraftError(error),
});

export const live: Layer.Layer<
  GitActions,
  never,
  GitMessageGeneration | GitActionOperationRuntime | GitWorkerRuntime
> = Layer.effect(
  GitActions,
  Effect.gen(function* () {
    const operations = yield* GitActionOperationRuntime;
    const messageGeneration = yield* GitMessageGeneration;
    const worker = yield* GitWorkerRuntime;

    const ensureDirectory = Effect.fn("GitActions.ensureDirectory")(function* (cwd: string) {
      const normalizedCwd = cwd.trim();
      if (!normalizedCwd) {
        return yield* new GitActionsExecutionError({
          cause: new Error("Working directory is required"),
        });
      }
      const entry = yield* Effect.tryPromise({
        try: () => stat(normalizedCwd),
        catch: (cause) => new GitActionsExecutionError({ cause }),
      }).pipe(Effect.option);
      if (entry._tag === "None" || !entry.value.isDirectory()) {
        return yield* new GitActionsExecutionError({
          cause: new Error(`Working directory not found: ${normalizedCwd}`),
        });
      }
      return normalizedCwd;
    });

    const readReviewPatch = Effect.fn("GitActions.readReviewPatch")(function* (input: {
      readonly method: "review-patch";
      readonly params: GitReviewPatchRequest;
    }) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* worker.request(input);
        if (!("type" in result) || result.type !== "stale-snapshot") {
          return result as GitReviewPatchResult;
        }
      }
      return yield* new GitActionsExecutionError({
        cause: new Error("Git repository changed while preparing the message."),
      });
    });

    const readCommitMessageContext = Effect.fn("GitActions.readCommitMessageContext")(function* (
      cwd: string,
      includeUnstaged: boolean,
    ) {
      const sources = includeUnstaged ? (["staged", "unstaged"] as const) : (["staged"] as const);
      const patches = yield* Effect.all(
        sources.map((source) =>
          readReviewPatch({ method: "review-patch", params: { cwd, source } }),
        ),
        { concurrency: "unbounded" },
      );
      if (patches.some((patch) => !patch.isGitRepository)) {
        return yield* new GitActionsExecutionError({
          cause: new Error("Git repository is required before generating a commit message."),
        });
      }
      return boundGitDraftDiff(
        patches
          .map(({ diff }) =>
            diff.type === "success" ? diff.unifiedDiff : "[Diff unavailable or too large.]",
          )
          .join("\n"),
      );
    });

    const readRecentSubjects = (cwd: string) =>
      worker
        .request({ method: "recent-commit-subjects", params: { cwd } })
        .pipe(Effect.orElseSucceed(() => []));

    const generateCommitText = Effect.fn("GitActions.generateCommitText")(function* (
      input: Pick<GitCommitMessageGenerateInput, "chatThreadId">,
      cwd: string,
      draftMessage: string,
      includeUnstaged: boolean,
    ) {
      const [changes, recentSubjects] = yield* Effect.all(
        [readCommitMessageContext(cwd, includeUnstaged), readRecentSubjects(cwd)],
        { concurrency: "unbounded" },
      );
      return yield* messageGeneration.generateCommitMessage(
        { cwd, chatThreadId: input.chatThreadId },
        {
          draftMessage: draftMessage.slice(0, GIT_DRAFT_LIMITS.body),
          changes,
          recentSubjects,
        },
      );
    });

    const commitOperation = Effect.fn("GitActions.commitOperation")(function* (
      input: GitCommitInput,
    ) {
      let cwd = input.cwd.trim();
      let branch: string | null = null;
      return yield* Effect.gen(function* () {
        cwd = yield* ensureDirectory(input.cwd);
        const status = yield* worker.request({ method: "action-status", params: { cwd } });
        branch = status.currentBranch;
        if (!status.isGitRepository) {
          return mutationError(
            cwd,
            null,
            new Error("Git repository is required before committing."),
            "Git repository is required before committing.",
          );
        }
        const includeUnstaged = input.includeUnstaged !== false;
        const hasChanges = includeUnstaged ? status.hasUncommittedChanges : status.hasStagedChanges;
        if (!hasChanges) {
          return mutationError(
            cwd,
            branch,
            new Error("No staged changes to commit."),
            "No staged changes to commit.",
          );
        }
        const message =
          input.message.trim() || (yield* generateCommitText(input, cwd, "", includeUnstaged));
        const committed = yield* worker.request({
          method: "commit",
          params: { ...input, cwd, message, nextStep: "commit" },
        });
        if (committed.status !== "success" || input.nextStep !== "commit-and-push") {
          return committed;
        }
        const pushed = yield* worker.request({
          method: "push",
          params: { cwd, force: false },
        });
        if (pushed.status !== "success") return pushed;
        return {
          ...pushed,
          branch: committed.branch,
          stdout: [committed.stdout, pushed.stdout].filter(Boolean).join("\n"),
          stderr: [committed.stderr, pushed.stderr].filter(Boolean).join("\n"),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(mutationError(cwd, branch, error, "Could not commit changes.")),
        ),
      );
    });

    const commitMessageOperation = Effect.fn("GitActions.commitMessageOperation")(function* (
      input: GitCommitMessageGenerateInput,
    ) {
      let cwd = input.cwd.trim();
      return yield* Effect.gen(function* () {
        cwd = yield* ensureDirectory(input.cwd);
        const status = yield* worker.request({ method: "action-status", params: { cwd } });
        if (!status.isGitRepository) {
          return {
            cwd,
            status: "error",
            message: null,
            stderr: "",
            errorMessage: "Git repository is required before generating a commit message.",
          } as const;
        }
        const includeUnstaged = input.includeUnstaged !== false;
        const hasChanges = includeUnstaged ? status.hasUncommittedChanges : status.hasStagedChanges;
        if (!hasChanges) {
          return {
            cwd,
            status: "error",
            message: null,
            stderr: "",
            errorMessage: "No staged changes to generate a commit message for.",
          } as const;
        }
        const message = yield* generateCommitText(
          input,
          cwd,
          input.draftMessage?.trim() ?? "",
          includeUnstaged,
        );
        return { cwd, status: "success", message, stderr: "", errorMessage: null } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            cwd,
            status: "error" as const,
            message: null,
            stderr: gitErrorStderr(error),
            ...gitDraftError(error),
            errorMessage: gitErrorMessage(error, "Could not generate a commit message."),
          }),
        ),
      );
    });

    const pullRequestMessageOperation = Effect.fn("GitActions.pullRequestMessageOperation")(
      function* (input: GitPullRequestMessageGenerateInput) {
        let cwd = input.cwd.trim();
        return yield* Effect.gen(function* () {
          cwd = yield* ensureDirectory(input.cwd);
          const status = yield* worker.request({ method: "action-status", params: { cwd } });
          if (!status.isGitRepository) {
            return {
              cwd,
              status: "error",
              title: null,
              body: null,
              stderr: "",
              errorMessage: "Git repository is required before generating a pull request message.",
            } as const;
          }
          const title = input.title?.trim() ?? "";
          const body = input.body?.trim() ?? "";
          const headBranch = input.headBranch?.trim() || status.currentBranch;
          const baseBranch = input.baseBranch?.trim() || status.defaultBranch;
          if (title && body)
            return { cwd, status: "success", title, body, stderr: "", errorMessage: null } as const;
          const [patch, recentSubjects] = yield* Effect.all(
            [
              baseBranch
                ? readReviewPatch({
                    method: "review-patch",
                    params: { cwd, source: "branch", baseBranch },
                  })
                : Effect.succeed(null),
              readRecentSubjects(cwd),
            ],
            { concurrency: "unbounded" },
          );
          const generated = yield* messageGeneration.generatePullRequestMessage(
            { cwd, chatThreadId: input.chatThreadId },
            {
              title: title.slice(0, GIT_DRAFT_LIMITS.subject),
              body: body.slice(0, GIT_DRAFT_LIMITS.body),
              headBranch: headBranch?.slice(0, GIT_DRAFT_LIMITS.branch) ?? "",
              baseBranch: baseBranch?.slice(0, GIT_DRAFT_LIMITS.branch) ?? "",
              changes:
                patch?.diff.type === "success"
                  ? boundGitDraftDiff(patch.diff.unifiedDiff)
                  : "[Branch diff unavailable.]",
              recentSubjects,
            },
          );
          const generatedTitle = title || generated.title;
          const generatedBody = body || generated.body;
          return {
            cwd,
            status: "success",
            title: generatedTitle,
            body: generatedBody,
            stderr: "",
            errorMessage: null,
          } as const;
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              cwd,
              status: "error" as const,
              title: null,
              body: null,
              stderr: gitErrorStderr(error),
              ...gitDraftError(error),
              errorMessage: gitErrorMessage(
                error,
                "Could not generate pull request title and body.",
              ),
            }),
          ),
        );
      },
    );

    const pushOperation = Effect.fn("GitActions.pushOperation")(function* (input: GitPushInput) {
      let cwd = input.cwd.trim();
      let branch: string | null = null;
      return yield* Effect.gen(function* () {
        cwd = yield* ensureDirectory(input.cwd);
        const result = yield* worker.request({ method: "push", params: { ...input, cwd } });
        branch = result.branch;
        return result;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(mutationError(cwd, branch, error, "Could not push changes.")),
        ),
      );
    });

    return GitActions.of({
      generateCommitMessage: (input) =>
        operations.run(input.operationId, commitMessageOperation(input), () => ({
          cwd: input.cwd.trim(),
          status: "error",
          message: null,
          stderr: "",
          errorMessage: "Git action was canceled.",
        })),
      generatePullRequestMessage: (input) =>
        operations.run(input.operationId, pullRequestMessageOperation(input), () => ({
          cwd: input.cwd.trim(),
          status: "error",
          title: null,
          body: null,
          stderr: "",
          errorMessage: "Git action was canceled.",
        })),
      commit: (input) =>
        operations.run(input.operationId, commitOperation(input), () => ({
          cwd: input.cwd.trim(),
          status: "error",
          branch: null,
          stdout: "",
          stderr: "",
          errorMessage: "Git action was canceled.",
        })),
      push: (input) =>
        operations.run(input.operationId, pushOperation(input), () => ({
          cwd: input.cwd.trim(),
          status: "error",
          branch: null,
          stdout: "",
          stderr: "",
          errorMessage: "Git action was canceled.",
        })),
      cancel: operations.cancel,
    });
  }),
);
