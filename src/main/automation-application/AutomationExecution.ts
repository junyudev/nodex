import { createHash, randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { subscribe as subscribeExecutionChanges } from "../agent-runtime/AgentRuntimeExecutionChanges";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { CODEX_AGENT_BACKEND_BINDING } from "../../shared/agent-backend";
import type {
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
  CodexScheduledAutomationRunNowInput,
} from "../../shared/types";
import {
  buildCodexScheduledAutomationHeartbeatPrompt,
  buildCodexScheduledAutomationRunPrompt,
} from "../codex-scheduled-automation-runtime";
import {
  CodexScheduledAutomationRetryError,
  type CodexScheduledAutomationRunContext,
  type CodexScheduledAutomationHeartbeatRunContext,
} from "../host-runtime/ScheduledAutomationPolicy";
import { computeCodexScheduledAutomationIntervalMs } from "../local-store/codex-scheduled-automation-schedule";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AutomationApplication } from "./AutomationApplication";
import type { AutomationArchiveMessages } from "./AutomationArchiveExcerpt";

type RunOutcome = NonNullable<AgentRuntimeOperations["run.outcome"]["output"]>;
interface RunContext {
  readonly now: number;
  readonly reason: "scheduled" | "run-now";
  readonly leaseId?: string;
  readonly dispatchId?: string;
  readonly definitionRevision?: number;
  readonly heartbeat?: CodexScheduledAutomationHeartbeatRunContext;
}
export class AutomationExecutionError extends Schema.TaggedError<AutomationExecutionError>()(
  "AutomationExecutionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
type Execution<A> = Effect.Effect<A, AutomationExecutionError>;
export class AutomationExecution extends Context.Service<
  AutomationExecution,
  {
    readonly prepareDefinition: <
      Input extends CodexScheduledAutomationCreateInput | CodexScheduledAutomationUpdateInput,
    >(
      input: Input,
      current?: CodexScheduledAutomation | null,
    ) => Execution<Input>;
    readonly runNow: (
      input: CodexScheduledAutomationRunNowInput,
      rendererClientId?: string | null,
    ) => Execution<void>;
    readonly executeClaimed: (
      automation: CodexScheduledAutomation,
      context: CodexScheduledAutomationRunContext,
    ) => Execution<void>;
    readonly resolveArchiveMessages: (
      sessionId: string,
    ) => Effect.Effect<AutomationArchiveMessages>;
  }
>()("nodex/main/automation-application/AutomationExecution") {}
export interface AutomationExecutionOptions {
  readonly runtimeStateHome: string;
}
const identity = (kind: string, value: unknown) =>
  `automation:${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const terminal = (status: RunOutcome["status"]) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);
const modelOption = (
  provider: AgentRuntimeOperations["providers.read"]["output"][number],
  model: string,
  effort: string | null,
  tier: string | null,
) => {
  const selected = provider.models.find((item) => item.slug === model);
  if (!selected) throw new Error(`Model '${model}' is unavailable`);
  const options: Array<{ id: string; value: string | boolean }> = [];
  const descriptors = selected.capabilities?.optionDescriptors ?? [];
  for (const [pattern, value] of [
    [/effort|reasoning/i, effort],
    [/tier/i, tier],
  ] as const) {
    if (value === null) continue;
    const option = descriptors.find((item) => pattern.test(item.id));
    if (option?.type !== "select" || !option.options.some((item) => item.id === value))
      throw new Error("Requested model option is unavailable");
    options.push({ id: option.id, value });
  }
  return options;
};

/** Definitions and review Runs remain Core-owned; every native execution crosses the Session Interface. */
export const live = (
  _options: AutomationExecutionOptions,
): Layer.Layer<
  AutomationExecution,
  never,
  AutomationApplication | AgentRuntimeApplication | AgentRuntimeSupervisor | ProjectWorkspace
> =>
  Layer.effect(
    AutomationExecution,
    Effect.gen(function* () {
      const automation = yield* AutomationApplication;
      const application = yield* AgentRuntimeApplication;
      const supervisor = yield* AgentRuntimeSupervisor;
      const workspace = yield* ProjectWorkspace;
      const protect = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.mapError((cause) => new AutomationExecutionError({ operation, cause })));
      const fail = (operation: string, message: string) =>
        new AutomationExecutionError({ operation, cause: new Error(message) });
      const selection = Effect.fn("AutomationExecution.selection")(function* (
        definition: Pick<
          CodexScheduledAutomation,
          "backendBinding" | "model" | "reasoningEffort" | "serviceTier"
        >,
      ) {
        const instanceId = agentRuntimeProviderId(definition.backendBinding);
        const provider = (yield* application.catalog()).find(
          (item) => item.instanceId === instanceId,
        );
        if (!provider?.enabled || !provider.installed || provider.status === "error")
          return yield* fail("model", "Configured Agent Instance is unavailable");
        const model = definition.model ?? provider.models[0]?.slug;
        if (!model) return yield* fail("model", "Agent Instance has no available models");
        const options = yield* Effect.try(() =>
          modelOption(provider, model, definition.reasoningEffort, definition.serviceTier),
        );
        return { instanceId: provider.instanceId, model, options };
      });
      const prepareDefinition: AutomationExecution["Service"]["prepareDefinition"] = (
        input,
        current,
      ) =>
        protect(
          "prepare-definition",
          Effect.gen(function* () {
            if (input.kind === "heartbeat") {
              const sessionId = input.targetSessionId ?? current?.targetSessionId;
              if (!sessionId)
                return yield* fail("prepare-definition", "Heartbeat target Session is required");
              const session = yield* workspace.getProjectSession(sessionId);
              if (
                !session?.executionRef ||
                session.archived ||
                session.projectId !== (input.projectId ?? current?.projectId ?? null)
              )
                return yield* fail("prepare-definition", "Heartbeat target is unavailable");
              const actual = yield* application.inspect({ sessionId });
              if (
                actual.thread.providerInstanceId !==
                agentRuntimeProviderId(
                  input.backendBinding ?? current?.backendBinding ?? CODEX_AGENT_BACKEND_BINDING,
                )
              )
                return yield* fail("prepare-definition", "Heartbeat target Agent Instance changed");
            }
            const selected = yield* selection({
              backendBinding:
                input.backendBinding ?? current?.backendBinding ?? CODEX_AGENT_BACKEND_BINDING,
              model: input.model ?? current?.model ?? null,
              reasoningEffort: input.reasoningEffort ?? current?.reasoningEffort ?? null,
              serviceTier: input.serviceTier ?? current?.serviceTier ?? null,
            });
            return { ...input, model: selected.model };
          }),
        );
      const wait = Effect.fn("AutomationExecution.wait")(function* (
        sessionId: string,
        messageId: string,
        changes: Stream.Stream<void, unknown>,
      ) {
        const result = yield* Stream.succeed(undefined).pipe(
          Stream.concat(changes),
          Stream.mapEffect(() => application.runOutcome({ sessionId, messageId })),
          Stream.filter((value): value is RunOutcome => value !== null && terminal(value.status)),
          Stream.runHead,
          Effect.timeout("14 minutes"),
        );
        if (Option.isNone(result))
          return yield* fail(
            "wait",
            "Execution observation ended before the submitted message completed",
          );
        return result.value;
      });
      const awaitResult = Effect.fn("AutomationExecution.awaitResult")(function* (
        sessionId: string,
        messageId: string,
        changes: Stream.Stream<void, unknown>,
      ) {
        const outcome = yield* wait(sessionId, messageId, changes).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : application.runOutcome({ sessionId, messageId }).pipe(
                  Effect.flatMap((run) =>
                    run && !terminal(run.status)
                      ? application.stop({ sessionId, runId: run.runId })
                      : Effect.void,
                  ),
                  Effect.ignore,
                ),
          ),
        );
        if (outcome.status !== "completed")
          return yield* fail("execute", `Automation ${outcome.status}`);
        const item = outcome.finalAssistantItemId
          ? yield* application.item({ sessionId, itemId: outcome.finalAssistantItemId })
          : null;
        return item?.type === "assistant_message" ? item.text : "";
      });
      const execute = Effect.fn("AutomationExecution.execute")(function* (
        candidate: CodexScheduledAutomation,
        context: RunContext,
      ) {
        const definition = yield* automation.definitions.getForExecution(candidate.id);
        if (
          !definition ||
          definition.definitionRevision !== candidate.definitionRevision ||
          (context.definitionRevision !== undefined &&
            context.definitionRevision !== definition.definitionRevision)
        )
          return yield* fail("execute", "Automation changed before execution");
        const dispatchId =
          context.dispatchId ?? (context.reason === "run-now" ? randomUUID() : null);
        if (!dispatchId)
          return yield* fail(
            "execute",
            "Scheduled execution requires its durable dispatch identity",
          );
        const selected = yield* selection(definition);
        if (definition.kind === "heartbeat") {
          const sessionId = definition.targetSessionId;
          if (!sessionId)
            return yield* fail("heartbeat", "Heartbeat target Session is unavailable");
          const session = yield* workspace.getProjectSession(sessionId);
          const target = yield* application.inspect({ sessionId });
          if (
            session?.archived ||
            target.thread.archivedAt !== null ||
            target.thread.providerInstanceId !== selected.instanceId
          )
            return yield* fail("heartbeat", "Heartbeat target Agent Instance changed");
          const messageId = identity("heartbeat", [definition.id, dispatchId]);
          const previous = yield* application.runOutcome({ sessionId, messageId });
          if (previous) {
            const changes = yield* subscribeExecutionChanges(supervisor.get());
            yield* awaitResult(sessionId, messageId, changes);
            return;
          }
          const interval = computeCodexScheduledAutomationIntervalMs(definition.rrule);
          const cooldownAt =
            interval === null
              ? null
              : Math.max(definition.lastRunAt ?? 0, Date.parse(target.thread.updatedAt)) + interval;
          const reason =
            target.thread.activeRunId || target.thread.pendingRuntimeRequest
              ? "heartbeat_busy"
              : context.reason === "scheduled" && context.heartbeat?.automationsEnabled !== true
                ? "heartbeat_disabled"
                : context.reason === "scheduled" &&
                    context.heartbeat?.rendererState?.isEligible !== true
                  ? "renderer_ineligible"
                  : context.reason === "scheduled" &&
                      cooldownAt !== null &&
                      cooldownAt > context.now
                    ? "heartbeat_cooldown"
                    : null;
          if (reason)
            return yield* Effect.fail(
              new CodexScheduledAutomationRetryError(
                "Heartbeat is not eligible right now",
                reason === "heartbeat_cooldown" ? Math.max(1, cooldownAt! - context.now) : 60_000,
                reason,
              ),
            );
          if (
            context.reason === "run-now" &&
            !(yield* automation.definitions.dispatchNow(definition.id))
          )
            return yield* fail("heartbeat", "Automation changed before dispatch");
          const changes = yield* subscribeExecutionChanges(supervisor.get());
          yield* application.queueMessage({
            sessionId,
            message: {
              messageId,
              text: buildCodexScheduledAutomationHeartbeatPrompt(definition, context.now),
              modelSelection: selected,
            },
          });
          yield* awaitResult(sessionId, messageId, changes);
          return;
        }
        if (
          context.reason === "run-now" &&
          !(yield* automation.definitions.dispatchNow(definition.id))
        )
          return yield* fail("execute", "Automation changed before dispatch");
        const cwds: readonly (string | null)[] =
          definition.projectId === null ? [null] : definition.cwds;
        if (cwds.length === 0) return yield* fail("execute", "Automation workspace is unavailable");
        for (const [index, cwd] of cwds.entries()) {
          const runId = identity("run", [definition.id, dispatchId, index]);
          const sessionId = identity("session", [definition.id, dispatchId, index]);
          const messageId = identity("message", [definition.id, dispatchId, index]);
          if (
            !(yield* automation.runs.begin({
              runId,
              automationId: definition.id,
              sessionTitle: definition.name,
              sourceCwd: cwd,
            }))
          )
            return yield* fail("execute", "Automation Run admission changed");
          const run = yield* automation.runs.get(runId);
          if (!run || run.status !== "IN_PROGRESS") continue;
          const changes = yield* subscribeExecutionChanges(supervisor.get());
          yield* Effect.gen(function* () {
            yield* application.launch({
              launchId: identity("launch", [definition.id, dispatchId, index]),
              acceptedAt: run.createdAt,
              sessionId,
              projectId: definition.projectId,
              title: definition.name,
              modelSelection: selected,
              interactionMode: "default",
              runInTarget:
                definition.executionEnvironment === "worktree" ? "newWorktree" : "localProject",
              runInEnvironmentPath: definition.localEnvironmentConfigPath,
              ...(cwd === null ? {} : { sourceRoot: cwd }),
              message: { messageId, text: buildCodexScheduledAutomationRunPrompt(definition) },
            });
            if (!(yield* automation.runs.bindSession({ runId, sessionId })))
              return yield* fail("execute", "Automation Session attachment changed");
            const summary = yield* awaitResult(sessionId, messageId, changes);
            yield* automation.runs.completeForReview({
              runId,
              inboxTitle: definition.name,
              inboxSummary: summary.slice(0, 2000),
            });
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : automation.runs
                    .archive({
                      runId,
                      archivedReason: "auto",
                      archivedUserMessage: null,
                      archivedAssistantMessage: null,
                    })
                    .pipe(Effect.ignore),
            ),
          );
        }
      });
      return AutomationExecution.of({
        prepareDefinition,
        executeClaimed: (definition, context) =>
          protect("execute", execute(definition, context).pipe(Effect.scoped)),
        runNow: (input, rendererClientId = null) =>
          protect(
            "run-now",
            Effect.gen(function* () {
              const definition = yield* automation.definitions.get(input.id);
              if (!definition) return yield* fail("run-now", "Automation not found");
              const now = yield* Clock.currentTimeMillis;
              yield* execute(definition, {
                now,
                reason: "run-now",
                heartbeat: {
                  automationsEnabled: true,
                  rendererState: rendererClientId
                    ? { rendererClientId, isEligible: true, reason: null, updatedAtMs: now }
                    : null,
                  collaborationMode: input.collaborationMode ?? null,
                },
              });
            }).pipe(Effect.scoped),
          ),
        resolveArchiveMessages: (sessionId) =>
          application.read({ sessionId }).pipe(
            Effect.map(({ snapshot }) => {
              const items = snapshot.projection.visibleTurnItems.map(({ item }) => item);
              const user = items.findLast((item) => item.type === "user_message");
              const assistant = items.findLast((item) => item.type === "assistant_message");
              return {
                archivedUserMessage: user?.type === "user_message" ? user.text : null,
                archivedAssistantMessage:
                  assistant?.type === "assistant_message" ? assistant.text : null,
              };
            }),
            Effect.catch(() =>
              Effect.succeed({ archivedUserMessage: null, archivedAssistantMessage: null }),
            ),
          ),
      });
    }),
  );
