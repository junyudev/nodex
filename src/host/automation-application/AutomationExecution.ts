import { modelIsOn, spendsNodexCredit } from "../../shared/model-policy";
import { isNodexProviderId } from "../../shared/nodex-models";
import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../../main/agent-runtime/AgentRuntimeSupervisor";
import { subscribe as subscribeExecutionChanges } from "../../main/agent-runtime/AgentRuntimeExecutionChanges";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { offeredCodexServiceTier } from "../../shared/codex-service-tier";
import { CODEX_AGENT_BACKEND_BINDING } from "../../shared/agent-backend";
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput,
  AutomationRunNowInput,
  AutomationRun,
} from "../../shared/types";
import {
  buildAutomationHeartbeatPrompt,
  buildAutomationRunPrompt,
} from "../../main/automation-prompt";
import {
  AutomationRetryError,
  type AutomationRunContext,
  type AutomationHeartbeatRunContext,
} from "../../main/host-runtime/ClockAutomationPolicy";
import { computeAutomationIntervalMs } from "./automation-cadence";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import { AgentBackendRegistry } from "../../main/agent-backend/AgentBackendRegistry";
import { AutomationApplication } from "./AutomationApplication";
import type { AutomationAdmission } from "./AutomationApplication";
import type { InboxAgentChoice } from "../../shared/inbox";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import type { AutomationArchiveMessages } from "./AutomationArchiveExcerpt";

type RunOutcome = NonNullable<AgentRuntimeOperations["run.outcome"]["output"]>;
interface RunContext {
  readonly now: number;
  readonly reason: "scheduled";
  readonly leaseId?: string;
  readonly dispatchId?: string;
  readonly admission?: AutomationAdmission | null;
  readonly automationRevision?: number;
  readonly deadlineMs?: number;
  readonly heartbeat?: AutomationHeartbeatRunContext;
}
export class AutomationExecutionError extends Schema.TaggedError<AutomationExecutionError>()(
  "AutomationExecutionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
type Execution<A> = Effect.Effect<A, AutomationExecutionError>;
export class AutomationExecution extends Context.Service<
  AutomationExecution,
  {
    readonly prepareDefinition: <Input extends AutomationCreateInput | AutomationUpdateInput>(
      input: Input,
      current?: Automation | null,
    ) => Execution<Input>;
    readonly runNow: (
      input: AutomationRunNowInput,
      rendererClientId?: string | null,
    ) => Execution<void>;
    readonly executeClaimed: (
      automation: Automation,
      context: AutomationRunContext,
    ) => Execution<void>;
    readonly resolveArchiveMessages: (
      sessionId: string,
    ) => Effect.Effect<AutomationArchiveMessages>;
  }
>()("nodex/main/automation-application/AutomationExecution") {}
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
  if (!selected)
    throw new Error(`This Agent doesn't offer model '${model}'. Choose another model.`);
  const options: Array<{ id: string; value: string | boolean }> = [];
  const descriptors = selected.capabilities?.optionDescriptors ?? [];
  for (const [pattern, value, offered] of [
    [
      /effort|reasoning/i,
      effort,
      (ids: readonly string[], chosen: string) => (ids.includes(chosen) ? chosen : null),
    ],
    [/tier/i, tier, offeredCodexServiceTier],
  ] as const) {
    if (value === null) continue;
    const option = descriptors.find((item) => pattern.test(item.id));
    const id =
      option?.type === "select"
        ? offered(
            option.options.map((item) => item.id),
            value,
          )
        : null;
    if (!option || !id)
      throw new Error(`Model '${model}' doesn't offer '${value}'. Choose its options again.`);
    options.push({ id: option.id, value: id });
  }
  return options;
};

/** Definitions and review Runs remain Core-owned; every native execution crosses the Session Interface. */
export const live: Layer.Layer<
  AutomationExecution,
  never,
  | AutomationApplication
  | AgentRuntimeApplication
  | AgentRuntimeSupervisor
  | ProjectWorkspace
  | AgentBackendRegistry
  | CoreModules
> = Layer.effect(
  AutomationExecution,
  Effect.gen(function* () {
    const automation = yield* AutomationApplication;
    const application = yield* AgentRuntimeApplication;
    const supervisor = yield* AgentRuntimeSupervisor;
    const workspace = yield* ProjectWorkspace;
    const backends = yield* AgentBackendRegistry;
    const core = yield* CoreModules;
    const protect = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new AutomationExecutionError({ operation, cause })));
    const fail = (operation: string, message: string) =>
      new AutomationExecutionError({ operation, cause: new Error(message) });
    const selection = Effect.fn("AutomationExecution.selection")(function* (
      definition: Pick<Automation, "backendBinding" | "model" | "reasoningEffort" | "serviceTier">,
      override?: InboxAgentChoice | null,
    ) {
      if (override) {
        // Managed instances belong to the Runtime catalog, not native Profile configuration.
        if (
          override.instanceId === agentRuntimeProviderId(definition.backendBinding) &&
          !isNodexProviderId(override.instanceId)
        )
          yield* backends.resolve(definition.backendBinding);
        const resolved = yield* resolveInboxModel(application, override);
        return { ...resolved, options: resolved.options ?? [] };
      }
      const instanceId = agentRuntimeProviderId(definition.backendBinding);
      // Managed instances belong to the Runtime catalog, not native Profile configuration.
      if (!instanceId || !isNodexProviderId(instanceId))
        yield* backends.resolve(definition.backendBinding);
      const provider = (yield* application.catalog()).find(
        (item) => item.instanceId === instanceId,
      );
      if (
        !provider?.enabled ||
        !provider.installed ||
        provider.status === "error" ||
        provider.availability === "unavailable"
      )
        return yield* fail(
          "model",
          "This Automation's Agent is off or unavailable. Turn it on in Settings or choose another Agent.",
        );
      const model =
        definition.model ??
        (!spendsNodexCredit(provider) ? provider.models.find(modelIsOn)?.slug : undefined);
      if (!model)
        return yield* fail(
          "model",
          "This Automation's Agent has no models yet. Connect it in Settings.",
        );
      const options = yield* Effect.try(() =>
        modelOption(provider, model, definition.reasoningEffort, definition.serviceTier),
      );
      return { instanceId: provider.instanceId, model, options };
    });
    const readRunbook = Effect.fn("AutomationExecution.readRunbook")(
      function* (pageId: string) {
        const read = (file_kind: "meta_yaml" | "body_markdown") =>
          core.library.read(
            { kind: "page_projection_file", page_id: pageId, file_kind },
            { class: "background" },
            null,
          );
        const metadata = yield* read("meta_yaml");
        const body = yield* read("body_markdown");
        if (
          metadata.value.kind !== "page_projection_file" ||
          body.value.kind !== "page_projection_file"
        )
          return yield* fail(
            "runbook",
            "This task's runbook Page is unavailable. Choose another Page or remove the runbook.",
          );
        return {
          title: metadata.value.value.metadata?.title_markdown || "Untitled",
          pageKey: metadata.value.value.page_key ?? pageId,
          body: body.value.value.content,
        };
      },
      Effect.mapError(() =>
        fail(
          "runbook",
          "This task's runbook Page is unavailable. Choose another Page or remove the runbook.",
        ),
      ),
    );
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
              return yield* fail("prepare-definition", "Choose a chat for this heartbeat.");
            const session = yield* workspace.getProjectSession(sessionId);
            // Heartbeats inherit execution context from the Session; Core rejects definition overrides.
            if (!session?.executionRef || session.archived)
              return yield* fail(
                "prepare-definition",
                "This heartbeat's chat is archived or no longer available. Choose another chat.",
              );
            const actual = yield* application.inspect({ sessionId });
            if (
              actual.thread.providerInstanceId !==
              agentRuntimeProviderId(
                input.backendBinding ?? current?.backendBinding ?? CODEX_AGENT_BACKEND_BINDING,
              )
            )
              return yield* fail(
                "prepare-definition",
                "A heartbeat runs on its chat's Agent. Choose the Agent this chat uses.",
              );
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
      deadlineMs?: number,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const timeoutMs = Math.min(
        14 * 60_000,
        deadlineMs === undefined ? Infinity : Math.max(0, deadlineMs - now),
      );
      const result = yield* Stream.succeed(undefined).pipe(
        Stream.concat(changes),
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const outcome = yield* application.runOutcome({ sessionId, messageId });
            if (!outcome || terminal(outcome.status)) return outcome;
            const current = yield* application.inspect({ sessionId });
            if (
              current.thread.activeRunId === outcome.runId &&
              current.thread.pendingRuntimeRequest
            )
              return yield* fail(
                "execute",
                "Automation Turns cannot wait for interactive questions or approvals.",
              );
            return outcome;
          }),
        ),
        Stream.filter((value): value is RunOutcome => value !== null && terminal(value.status)),
        Stream.runHead,
        Effect.timeout(timeoutMs),
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
      deadlineMs?: number,
    ) {
      const outcome = yield* wait(sessionId, messageId, changes, deadlineMs).pipe(
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
        return yield* fail(
          "execute",
          outcome.status === "failed" ? "The run failed." : `The run was ${outcome.status}.`,
        );
      const item = outcome.finalAssistantItemId
        ? yield* application.item({ sessionId, itemId: outcome.finalAssistantItemId })
        : null;
      return item?.type === "assistant_message" ? item.text : "";
    });
    // A migrated, already-bound dispatch can predate the only retained definition.
    // Reconcile its accepted messages; that newer definition cannot authorize a launch.
    const reconcileAcceptedDispatch = Effect.fn("AutomationExecution.reconcileAcceptedDispatch")(
      function* (automationId: string, dispatchId: string, context: RunContext) {
        const changes = yield* subscribeExecutionChanges(supervisor.get());
        let bound = false;
        for (let index = 0; index < 128; index += 1) {
          const runId = identity("run", [automationId, dispatchId, index]);
          const run = yield* automation.runs.get(runId);
          if (!run) break;
          if (!run.sessionId)
            return yield* fail(
              "execute",
              "The original Automation action is unavailable for this unstarted run.",
            );
          bound = true;
          if (run.status === "ACCEPTED" || run.status === "ARCHIVED") continue;
          const regular = identity("message", [automationId, dispatchId, index]);
          const heartbeat = identity("heartbeat", [automationId, dispatchId]);
          const previous = yield* application.runOutcome({
            sessionId: run.sessionId,
            messageId: regular,
          });
          const messageId = previous ? regular : heartbeat;
          if (
            !previous &&
            !(yield* application.runOutcome({ sessionId: run.sessionId, messageId }))
          )
            return yield* fail(
              "execute",
              "The original Automation Turn is unavailable for reconciliation.",
            );
          const summary = yield* awaitResult(run.sessionId, messageId, changes, context.deadlineMs);
          if (run.status === "IN_PROGRESS")
            yield* automation.runs.completeForReview({
              runId,
              inboxTitle: run.sessionTitle,
              inboxSummary: summary.slice(0, 2000),
            });
        }
        if (!bound)
          return yield* fail("execute", "This Automation changed before it ran. Try again.");
      },
    );
    const restoreAcceptedRunSession = Effect.fn("AutomationExecution.restoreAcceptedRunSession")(
      function* (
        run: AutomationRun,
        dispatchId: string,
        sessionId: string,
        messageId: string,
        definition: Automation,
      ) {
        if (run.sessionId) return;
        if (
          !(yield* automation.runs.begin({
            runId: run.runId,
            automationId: run.automationId,
            dispatchId,
            messageId,
            notificationPolicy: definition.notificationPolicy,
            agentSelection: run.agentSelection,
            sessionTitle: run.sessionTitle,
            sourceCwd: run.sourceCwd,
          }))
        )
          return yield* fail("execute", "Automation run admission changed");
        if (!(yield* automation.runs.bindSession({ runId: run.runId, sessionId })))
          return yield* fail("execute", "Automation Session attachment changed");
      },
    );
    const execute = Effect.fn("AutomationExecution.execute")(function* (
      candidate: Automation,
      context: RunContext,
    ) {
      const current = yield* automation.automations.getForExecution(candidate.id);
      if (!current)
        return yield* fail("execute", "This Automation changed before it ran. Try again.");
      const definition = candidate;
      const dispatchId = context.dispatchId;
      const leaseId = context.leaseId;
      if (!dispatchId || !leaseId)
        return yield* fail(
          "execute",
          "Automation execution requires its durable dispatch and lease identities",
        );
      if (
        context.automationRevision !== undefined &&
        context.automationRevision !== candidate.automationRevision
      ) {
        return yield* reconcileAcceptedDispatch(definition.id, dispatchId, context);
      }
      if (!context.admission && current.automationRevision !== definition.automationRevision)
        return yield* reconcileAcceptedDispatch(definition.id, dispatchId, context);
      if (definition.mode === "dry_run")
        return yield* fail(
          "execute",
          "Dry run Automations record decisions without starting work.",
        );
      // Accepted messages are observed by identity before mutable launch prerequisites are read.
      const prepare = yield* Effect.cached(
        Effect.gen(function* () {
          const prior = yield* automation.runs.get(identity("run", [definition.id, dispatchId, 0]));
          const retained = prior?.agentSelection;
          const selected = yield* selection(
            definition,
            retained
              ? {
                  instanceId: retained.instanceId,
                  model: retained.model,
                  reasoningEffort: retained.effort ?? null,
                  serviceTier: context.admission?.agent?.serviceTier ?? definition.serviceTier,
                }
              : context.admission?.agent,
          );
          const resolvedEffort = selected.options?.find((option) =>
            /effort|reasoning/iu.test(option.id),
          )?.value;
          const agentSelection = {
            instanceId: selected.instanceId,
            model: selected.model,
            effort: typeof resolvedEffort === "string" ? resolvedEffort : null,
          };
          const runbook = definition.runbookPageId
            ? yield* readRunbook(definition.runbookPageId)
            : null;
          return { selected, agentSelection, runbook };
        }),
      );
      const instructions = context.admission?.prompt ?? definition.prompt;
      if (definition.kind === "heartbeat") {
        const sessionId = definition.targetSessionId;
        if (!sessionId)
          return yield* fail("heartbeat", "This heartbeat's chat is no longer available.");
        const messageId = identity("heartbeat", [definition.id, dispatchId]);
        const previous = yield* application.runOutcome({ sessionId, messageId });
        if (previous) return yield* reconcileAcceptedDispatch(definition.id, dispatchId, context);
        const { selected, agentSelection, runbook } = yield* prepare;
        const session = yield* workspace.getProjectSession(sessionId);
        const target = yield* application.inspect({ sessionId });
        if (session?.archived || target.thread.archivedAt !== null)
          return yield* fail(
            "heartbeat",
            "This heartbeat's chat is archived. Unarchive it or choose another chat.",
          );
        if (target.thread.providerInstanceId !== selected.instanceId)
          return yield* fail(
            "heartbeat",
            "A heartbeat runs on its chat's Agent. Choose the Agent this chat uses.",
          );
        const interval = computeAutomationIntervalMs(definition.rrule);
        const cooldownAt =
          interval === null
            ? null
            : Math.max(definition.lastRunAt ?? 0, Date.parse(target.thread.updatedAt)) + interval;
        const reason =
          target.thread.activeRunId || target.thread.pendingRuntimeRequest
            ? "heartbeat_busy"
            : context.reason === "scheduled" &&
                !context.admission &&
                context.heartbeat?.automationsEnabled !== true
              ? "heartbeat_disabled"
              : context.reason === "scheduled" &&
                  !context.admission &&
                  context.heartbeat?.rendererState?.isEligible !== true
                ? "renderer_ineligible"
                : context.reason === "scheduled" &&
                    !context.admission &&
                    cooldownAt !== null &&
                    cooldownAt > context.now
                  ? "heartbeat_cooldown"
                  : null;
        if (!previous && reason)
          return yield* Effect.fail(
            new AutomationRetryError(
              "Heartbeat is not eligible right now",
              reason === "heartbeat_cooldown" ? Math.max(1, cooldownAt! - context.now) : 60_000,
              reason,
            ),
          );
        const changes = yield* subscribeExecutionChanges(supervisor.get());
        const runId = identity("run", [definition.id, dispatchId, 0]);
        if (
          !(yield* automation.runs.begin({
            runId,
            automationId: definition.id,
            dispatchId,
            messageId,
            notificationPolicy: definition.notificationPolicy,
            agentSelection,
            sessionTitle: definition.name,
          }))
        )
          return yield* fail("heartbeat", "Automation Run admission changed");
        yield* Effect.gen(function* () {
          if (!(yield* automation.runs.bindSession({ runId, sessionId })))
            return yield* fail("heartbeat", "Automation Session attachment changed");
          if (!previous)
            yield* application.queueMessage({
              sessionId,
              automationExecution: { runId, leaseId, dispatchId },
              message: {
                messageId,
                text: buildAutomationHeartbeatPrompt(
                  definition,
                  context.now,
                  instructions,
                  runbook,
                ),
                modelSelection: selected,
              },
            });
          const summary = yield* awaitResult(sessionId, messageId, changes, context.deadlineMs);
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
        return;
      }
      const cwds: readonly (string | null)[] =
        definition.projectId === null ? [null] : definition.cwds;
      if (cwds.length === 0)
        return yield* fail(
          "execute",
          "This Automation has no folder to run in. Choose a Project folder.",
        );
      for (const [index, cwd] of cwds.entries()) {
        const runId = identity("run", [definition.id, dispatchId, index]);
        const sessionId = identity("session", [definition.id, dispatchId, index]);
        const messageId = identity("message", [definition.id, dispatchId, index]);
        yield* Effect.gen(function* () {
          const retainedRun = yield* automation.runs.get(runId);
          const previous = retainedRun
            ? yield* application.runOutcome({
                sessionId: retainedRun.sessionId ?? sessionId,
                messageId,
              })
            : null;
          if (retainedRun && previous) {
            yield* restoreAcceptedRunSession(
              retainedRun,
              dispatchId,
              sessionId,
              messageId,
              definition,
            );
            const changes = yield* subscribeExecutionChanges(supervisor.get());
            const summary = yield* awaitResult(
              retainedRun.sessionId ?? sessionId,
              messageId,
              changes,
              context.deadlineMs,
            );
            if (retainedRun.status === "IN_PROGRESS" || !retainedRun.sessionId)
              yield* automation.runs.completeForReview({
                runId,
                inboxTitle: retainedRun.sessionTitle,
                inboxSummary: summary.slice(0, 2000),
              });
            return;
          }
          const { selected, agentSelection, runbook } = yield* prepare;
          if (
            !(yield* automation.runs.begin({
              runId,
              automationId: definition.id,
              dispatchId,
              messageId,
              notificationPolicy: definition.notificationPolicy,
              agentSelection,
              sessionTitle: definition.name,
              sourceCwd: cwd,
            }))
          )
            return yield* fail("execute", "Automation run admission changed");
          const run = yield* automation.runs.get(runId);
          if (!run || run.status !== "IN_PROGRESS") return;
          const changes = yield* subscribeExecutionChanges(supervisor.get());
          yield* application.launch({
            automationExecution: { runId, leaseId, dispatchId },
            messageOrigin: "automation",
            launchId: identity("launch", [definition.id, dispatchId, index]),
            acceptedAt: run.createdAt,
            sessionId,
            projectId: definition.projectId,
            initialPageIds: [
              ...new Set(
                [run.pageId, context.admission?.pageId, definition.runbookPageId].filter(
                  (id): id is string => Boolean(id),
                ),
              ),
            ],
            ...(run.pageId ? { workPage: { pageId: run.pageId } } : {}),
            title: definition.name,
            modelSelection: selected,
            interactionMode: "default",
            runInTarget:
              definition.executionEnvironment === "worktree" ? "newWorktree" : "localProject",
            runInEnvironmentPath: definition.localEnvironmentConfigPath,
            ...(cwd === null ? {} : { sourceRoot: cwd }),
            message: {
              messageId,
              text: buildAutomationRunPrompt(definition, instructions, runbook),
            },
          });
          if (!(yield* automation.runs.bindSession({ runId, sessionId })))
            return yield* fail("execute", "Automation Session attachment changed");
          const summary = yield* awaitResult(sessionId, messageId, changes, context.deadlineMs);
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
      runNow: (input) =>
        protect(
          "run-now",
          Effect.gen(function* () {
            const definition = yield* automation.automations.get(input.id);
            if (!definition) return yield* fail("run-now", "This Automation no longer exists.");
            if (definition.mode !== "dry_run" && !definition.heldDecision)
              yield* selection(definition);
            if (!(yield* automation.automations.dispatchNow(definition.id)))
              return yield* fail("run-now", "This Automation changed before it ran. Try again.");
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
