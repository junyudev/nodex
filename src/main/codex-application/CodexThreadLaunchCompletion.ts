import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  CodexThreadGoalDraftInput,
  CodexThreadStartForSessionInput,
  PageRunInTarget,
} from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { CoreModules } from "../core-runtime/CoreModules";
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
  readonly heartbeatAutomation: CodexThreadStartForSessionInput["heartbeatAutomation"];
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
  CodexApplicationEventHub | CodexAttachments | CodexThreadGoalRuntime | CoreModules
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const attachments = yield* CodexAttachments;
  const goals = yield* CodexThreadGoalRuntime;
  const core = yield* CoreModules;

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

  const createHeartbeat = (outcome: CodexThreadLaunchOutcome) => {
    const seed = outcome.heartbeatAutomation;
    if (outcome.runInTarget !== "newWorktree" || !outcome.projectId || !seed) return Effect.void;
    const automationId = createUuidV7();
    return core.automation
      .apply({
        operationId: `electron:thread-launch-heartbeat:${outcome.threadId}:${automationId}`,
        intent: {
          kind: "create_definition",
          automation_id: automationId,
          definition: {
            kind: "heartbeat",
            name: seed.name,
            prompt: seed.prompt,
            rrule: seed.rrule,
            target_thread_id: outcome.threadId,
            model: null,
            reasoning_effort: null,
          },
        },
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            events.publish({
              kind: "codex",
              value: {
                type: "scheduledAutomationChanged",
                event: {
                  automationId,
                  targetThreadId: outcome.threadId,
                  reason: "upsert",
                },
              },
            }),
          ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Started worktree Thread but could not create its heartbeat").pipe(
            Effect.annotateLogs({ threadId: outcome.threadId, cause: String(cause) }),
            Effect.andThen(
              Effect.sync(() =>
                progress(outcome, {
                  phase: "startingThread",
                  message: "Started task, but could not create the heartbeat",
                  stream: "stderr",
                  outputDelta: "[stderr] Started task, but could not create the heartbeat\n",
                }),
              ),
            ),
          ),
        ),
      );
  };

  return CodexThreadLaunchCompletion.of({
    accepted: (outcome) =>
      Effect.all([applyGoal(outcome), createHeartbeat(outcome)], {
        concurrency: 2,
        discard: true,
      }).pipe(
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
