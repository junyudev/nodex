import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CodexThreadGoalDraftInput, PageRunInTarget } from "../../shared/types";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexAttachments } from "./CodexAttachments";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";

export interface CodexThreadLaunchOutcome {
  readonly launchId: string;
  readonly projectId: string | null;
  readonly sessionId: string;
  readonly threadId: string;
  readonly runInTarget: PageRunInTarget;
  readonly startedAt: number;
  readonly goalObjective: string;
  readonly rawGoalDraft: CodexThreadGoalDraftInput | null;
}

export class CodexThreadLaunchCompletion extends Context.Service<
  CodexThreadLaunchCompletion,
  {
    /** Completes secondary launch effects after the protocol has accepted the first Turn. */
    readonly accepted: (outcome: CodexThreadLaunchOutcome) => Effect.Effect<void>;
    /** Projects a pre-acceptance failure without changing canonical Turn authority. */
    readonly failed: (
      outcome: Pick<
        CodexThreadLaunchOutcome,
        "launchId" | "projectId" | "sessionId" | "threadId" | "runInTarget"
      >,
      message?: string,
    ) => void;
  }
>()("nodex/main/codex-application/CodexThreadLaunchCompletion") {}

export const make: Effect.Effect<
  CodexThreadLaunchCompletion["Service"],
  never,
  CodexApplicationEventHub | CodexAttachments | CodexThreadGoalRuntime
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const attachments = yield* CodexAttachments;
  const goals = yield* CodexThreadGoalRuntime;

  const progress = (
    outcome: Pick<
      CodexThreadLaunchOutcome,
      "launchId" | "projectId" | "sessionId" | "threadId" | "runInTarget"
    >,
    input: {
      readonly phase: "ready" | "failed" | "startingThread";
      readonly message: string;
      readonly stream?: "info" | "stderr";
      readonly outputDelta?: string;
    },
  ): void => {
    events.publish({
      kind: "codex",
      value: {
        type: "threadStartProgress",
        ...outcome,
        ...input,
        updatedAt: Date.now(),
      },
    });
  };

  const applyGoal = (outcome: CodexThreadLaunchOutcome) => {
    if (!outcome.goalObjective) return Effect.void;
    return goals
      .set({
        threadId: outcome.threadId,
        objective: outcome.goalObjective,
        status: "active",
        appendTranscriptItem: false,
      })
      .pipe(
        Effect.andThen(
          outcome.rawGoalDraft
            ? attachments.cleanupGoalSources(outcome.rawGoalDraft, CODEX_APP_LOCAL_HOST_ID)
            : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Started Thread but could not apply its goal").pipe(
            Effect.annotateLogs({ threadId: outcome.threadId, cause: String(cause) }),
          ),
        ),
      );
  };

  return CodexThreadLaunchCompletion.of({
    accepted: (outcome) =>
      applyGoal(outcome).pipe(
        Effect.andThen(
          Effect.sync(() =>
            progress(outcome, {
              phase: "ready",
              message: outcome.runInTarget === "newWorktree" ? "Worktree ready." : "Message sent.",
              ...(outcome.runInTarget === "newWorktree"
                ? { stream: "info" as const, outputDelta: "[info] Worktree ready.\n" }
                : {}),
            }),
          ),
        ),
      ),
    failed: (outcome, message = "Message could not be sent.") =>
      progress(outcome, { phase: "failed", message, stream: "stderr" }),
  });
});
