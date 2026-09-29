import { randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodexScheduledAutomation } from "../../shared/types";
import { NativeConversationExtension } from "../app-tools/NativeConversationExtension";
import {
  buildCodexScheduledAutomationHeartbeatPrompt,
  buildCodexScheduledAutomationRunPrompt,
} from "../codex-scheduled-automation-runtime";
import { computeCodexScheduledAutomationIntervalMs } from "../local-store/codex-scheduled-automation-schedule";
import {
  CodexScheduledAutomationRetryError,
  type CodexScheduledAutomationHeartbeatRunContext,
} from "../host-runtime/ScheduledAutomationPolicy";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AutomationApplication } from "./AutomationApplication";

export interface NativeAutomationRunContext {
  readonly now: number;
  readonly reason: "scheduled" | "run-now";
  readonly leaseId?: string;
  readonly heartbeat?: CodexScheduledAutomationHeartbeatRunContext;
}

const MAX_TURN_DURATION_MS = 14 * 60_000;

export class NativeAutomationExecutionError extends Schema.TaggedError<NativeAutomationExecutionError>()(
  "NativeAutomationExecutionError",
  { message: Schema.String },
) {}

/** Uses the existing Core Definition/Run/lease owners; there is no provider-specific scheduler. */
export const make = Effect.gen(function* () {
  const automation = yield* AutomationApplication;
  const workspace = yield* ProjectWorkspace;
  const extension = yield* Effect.serviceOption(NativeConversationExtension);
  return Effect.fn("NativeAutomationExecution.execute")(function* (
    candidate: CodexScheduledAutomation,
    context: NativeAutomationRunContext,
  ) {
    if (Option.isNone(extension))
      return yield* Effect.fail(
        new NativeAutomationExecutionError({ message: "Native automation runtime is unavailable" }),
      );
    const native = extension.value;
    const definition = yield* automation.definitions.getForExecution(candidate.id);
    if (!definition || definition.definitionRevision !== candidate.definitionRevision)
      return yield* Effect.fail(
        new NativeAutomationExecutionError({ message: "Automation changed before execution" }),
      );
    if (definition.backendBinding.kind !== "claude")
      return yield* Effect.fail(
        new NativeAutomationExecutionError({
          message: "Native execution requires a native backend",
        }),
      );
    yield* native.validateAutomation(definition);
    const now = context.now ?? (yield* Clock.currentTimeMillis);
    const dispatchId = context.leaseId ?? `run-now:${randomUUID()}`;
    const settings = {
      ...(definition.model ? { model: definition.model } : {}),
      ...(definition.reasoningEffort ? { effort: definition.reasoningEffort } : {}),
      unattended: true,
    };
    const wait = (threadId: string, turnId: string) =>
      native.wait(threadId, turnId).pipe(
        Effect.timeout(MAX_TURN_DURATION_MS),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : native.cancel(threadId, turnId).pipe(Effect.ignore),
        ),
      );
    if (definition.kind === "heartbeat") {
      const session = definition.targetSessionId
        ? yield* workspace.getProjectSession(definition.targetSessionId)
        : null;
      const threadId = session?.archived ? null : session?.thread?.threadId;
      if (!threadId)
        return yield* Effect.fail(
          new NativeAutomationExecutionError({ message: "Heartbeat target is unavailable" }),
        );
      const target = yield* native.read(threadId);
      if (
        !target ||
        target.archived ||
        target.backendBinding.kind !== "claude" ||
        target.backendBinding.instanceConfigId !== definition.backendBinding.instanceConfigId
      )
        return yield* Effect.fail(
          new NativeAutomationExecutionError({ message: "Heartbeat target backend changed" }),
        );
      const interval = computeCodexScheduledAutomationIntervalMs(definition.rrule);
      const cooldownAt =
        interval === null ? null : Math.max(definition.lastRunAt ?? 0, target.updatedAt) + interval;
      const reason = target.busy
        ? "heartbeat_busy"
        : context.reason === "scheduled" && context.heartbeat?.automationsEnabled !== true
          ? "heartbeat_disabled"
          : context.reason === "scheduled" && context.heartbeat?.rendererState?.isEligible !== true
            ? "renderer_ineligible"
            : context.reason === "scheduled" && cooldownAt !== null && cooldownAt > now
              ? "heartbeat_cooldown"
              : null;
      if (reason)
        return yield* Effect.fail(
          new CodexScheduledAutomationRetryError(
            "Heartbeat is not eligible right now",
            reason === "heartbeat_cooldown" ? Math.max(1, cooldownAt! - now) : 60_000,
            reason,
          ),
        );
      if (
        context.reason === "run-now" &&
        !(yield* automation.definitions.dispatchNow(definition.id))
      )
        return yield* new NativeAutomationExecutionError({
          message: "Automation changed before dispatch",
        });
      const accepted = yield* native.submit({
        threadId,
        prompt: buildCodexScheduledAutomationHeartbeatPrompt(definition, now),
        operationId: `automation:${definition.id}:${dispatchId}`,
        ...settings,
      });
      const result = yield* wait(threadId, accepted.turnId);
      if (result.outcome !== "completed")
        return yield* Effect.fail(
          new NativeAutomationExecutionError({ message: `Heartbeat ${result.outcome}` }),
        );
      return;
    }
    if (context.reason === "run-now" && !(yield* automation.definitions.dispatchNow(definition.id)))
      return yield* new NativeAutomationExecutionError({
        message: "Automation changed before dispatch",
      });
    const cwds: readonly (string | null)[] =
      definition.projectId === null ? [null] : definition.cwds;
    if (cwds.length === 0)
      return yield* Effect.fail(
        new NativeAutomationExecutionError({ message: "Automation workspace is unavailable" }),
      );
    for (const [index, cwd] of cwds.entries()) {
      const pendingThreadId = `pending:${randomUUID()}`;
      const admitted = yield* automation.runs.begin({
        threadId: pendingThreadId,
        automationId: definition.id,
        threadTitle: definition.name,
        sourceCwd: cwd,
      });
      if (!admitted)
        return yield* new NativeAutomationExecutionError({
          message: "Automation Run admission changed",
        });
      let threadId: string | null = null;
      yield* Effect.gen(function* () {
        const created = yield* native.createAutomationSession({
          definition,
          cwd,
          operationId: `automation:${definition.id}:${dispatchId}:${index}:create`,
        });
        threadId = created.threadId;
        if (!(yield* automation.runs.replacePendingThread({ pendingThreadId, threadId })))
          return yield* new NativeAutomationExecutionError({
            message: "Automation Run attachment changed",
          });
        const prompt = buildCodexScheduledAutomationRunPrompt(definition);
        const accepted = yield* native.submit({
          threadId,
          prompt,
          operationId: `automation:${definition.id}:${dispatchId}:${index}:turn`,
          ...settings,
        });
        const result = yield* wait(threadId, accepted.turnId);
        if (result.outcome !== "completed")
          return yield* Effect.fail(
            new NativeAutomationExecutionError({ message: `Automation ${result.outcome}` }),
          );
        yield* automation.runs.completeForReview({
          threadId,
          inboxTitle: definition.name,
          inboxSummary: result.assistantText.slice(0, 2000),
        });
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : automation.runs
                .archive({
                  threadId: threadId ?? pendingThreadId,
                  archivedReason: "auto",
                  archivedUserMessage: null,
                  archivedAssistantMessage: null,
                })
                .pipe(Effect.ignore),
        ),
      );
    }
  });
});
