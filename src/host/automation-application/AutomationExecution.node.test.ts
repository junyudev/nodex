import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { AGENT_CLI_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/agent-cli-workflow";
import type {
  AgentRuntimeLaunch,
  AgentRuntimeMessage,
  AgentRuntimeMessageInput,
} from "../../shared/agent-runtime-api";
import type { Automation, AutomationRun } from "../../shared/types";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../../main/agent-runtime/AgentRuntimeSupervisor";
import {
  ProjectWorkspace,
  live as workspaceLive,
} from "../../main/project-application/ProjectWorkspace";
import { AutomationApplication, live as automationLive } from "./AutomationApplication";
import { AutomationExecution, live } from "./AutomationExecution";
import { live as backendRegistryLive } from "../../main/agent-backend/AgentBackendRegistry";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { toElectronIpcRendererError } from "../../main/platform/electron/electron-ipc-error";
import { CoreSessionAccess } from "../../main/core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "../../main/core-runtime/CoreModules";
import { live as routingLive } from "../../main/core-runtime/AutomationRoutingIndex";
import { classifyCoreOperationFailure } from "../../main/core-runtime/CoreRuntimeError";
import { InboxApplication } from "../inbox-application/InboxApplication";
import { createUuidV7 } from "../../shared/uuid-v7";

const definition: Automation = {
  id: "report",
  automationRevision: 1,
  scope: { kind: "space" },
  ownerMemberId: "member:owner",
  conditionText: "On the clock",
  timezone: "UTC",
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  notificationPolicy: null,
  mode: "run",
  runbookPageId: null,
  runbookTitle: null,
  heldDecision: null,
  name: "Report",
  prompt: "Build a report",
  rrule: "FREQ=DAILY",
  model: "model",
  reasoningEffort: null,
  serviceTier: null,
  backendBinding: { kind: "codex" },
  cwds: ["/workspace"],
  executionEnvironment: "local",
  localEnvironmentConfigPath: null,
  nextRunAt: 1,
  lastRunAt: null,
  createdAt: 1,
  updatedAt: 1,
};
const context = {
  now: 1000,
  reason: "scheduled" as const,
  leaseId: "physical:one",
  dispatchId: "dispatch:one",
  automationRevision: 1,
};
const setup = (
  binding: Automation["backendBinding"] = { kind: "codex" },
  owners?: {
    readonly automation: AutomationApplication["Service"];
    readonly workspace: ProjectWorkspace["Service"];
    /** What the Runtime does for a new chat before launch returns: prepare its first Turn. */
    readonly prepareTurn?: (launch: AgentRuntimeLaunch) => Effect.Effect<void, unknown>;
  },
) => {
  const state = {
    definition: { ...definition, backendBinding: binding },
    failLaunch: false,
    changed: false,
    busy: false,
    denyMessage: false,
    failedOutcome: false,
    interruptedOutcome: false,
    reply: "Completed report",
    pendingOutcome: false,
    waitingForInput: false,
    preferReviewedDefault: false,
    instanceEnabled: true,
    instanceAvailable: true,
    agentDefinitionId: binding.kind === "acp" ? binding.agentDefinitionId : "",
    targetProviderId: agentRuntimeProviderId(binding),
    targetArchived: false,
    targetUpdatedAt: "1970-01-01T00:00:00Z",
    missingRunbook: false,
    dispatches: 0,
  };
  const runs = new Map<string, AutomationRun>();
  const turnPolicies = new Map<string, Automation["notificationPolicy"]>();
  const launches: AgentRuntimeLaunch[] = [];
  const physical = new Set<string>();
  const completions: string[] = [];
  const stops: string[] = [];
  const admissions: Array<{ dispatchId?: string }> = [];
  const confirmations: string[] = [];
  const messages: AgentRuntimeMessage[] = [];
  const messageInputs: AgentRuntimeMessageInput[] = [];
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(InboxApplication, {
          confirmAutomationDecision: (firing: NonNullable<Automation["heldDecision"]>) =>
            Effect.sync(() => {
              confirmations.push(firing.dispatchId);
            }),
        } as unknown as InboxApplication["Service"]),
        Layer.succeed(CoreModules, {
          automation: {
            read: ({ message_id }: { message_id: string }) =>
              Effect.succeed({
                value: {
                  kind: "automation_notification_policy",
                  policy: turnPolicies.get(message_id) ?? null,
                },
              }),
          },
          library: {
            read: (input: { file_kind: string }) =>
              state.missingRunbook
                ? Effect.fail(new Error("Page not found"))
                : Effect.succeed({
                    value: {
                      kind: "page_projection_file",
                      value: {
                        page_key: "OPS-4",
                        metadata: { title_markdown: "Release checklist" },
                        content:
                          input.file_kind === "body_markdown"
                            ? "Check the last release first."
                            : "",
                      },
                    },
                  }),
          },
        } as unknown as CoreModules["Service"]),
        backendRegistryLive.pipe(
          Layer.provide(
            Layer.succeed(ApplicationSettings, {
              snapshot: () =>
                Effect.succeed({
                  claudeAgents: {
                    instances:
                      binding.kind === "claude" && state.instanceAvailable
                        ? [{ id: binding.instanceConfigId, enabled: state.instanceEnabled }]
                        : [],
                  },
                  openCodeAgents: { instances: [] },
                  acpAgents: {
                    instances:
                      binding.kind === "acp" && state.instanceAvailable
                        ? [
                            {
                              id: binding.instanceConfigId,
                              agentDefinitionId: state.agentDefinitionId,
                              enabled: state.instanceEnabled,
                            },
                          ]
                        : [],
                  },
                }),
            } as unknown as ApplicationSettings["Service"]),
          ),
        ),
        Layer.succeed(
          AutomationApplication,
          owners?.automation ??
            ({
              automations: {
                getForExecution: () =>
                  Effect.succeed(
                    state.changed
                      ? { ...state.definition, automationRevision: 2, prompt: "A later action" }
                      : state.definition,
                  ),
                get: () => Effect.succeed(state.definition),
                dispatchNow: () =>
                  Effect.sync(() => {
                    state.dispatches++;
                    return state.definition;
                  }),
              },
              runs: {
                begin: (input: {
                  runId: string;
                  dispatchId?: string;
                  automationId: string;
                  messageId: string;
                  notificationPolicy: Automation["notificationPolicy"];
                  sessionTitle: string;
                  sourceCwd: string | null;
                  agentSelection?: AutomationRun["agentSelection"];
                }) =>
                  Effect.sync(() => {
                    admissions.push(input);
                    const previous = runs.get(input.runId);
                    if (previous) {
                      if (previous.sessionId === null && previous.archivedReason === "auto")
                        runs.set(input.runId, {
                          ...previous,
                          status: "IN_PROGRESS",
                          archivedReason: null,
                        });
                      return true;
                    }
                    turnPolicies.set(input.messageId, input.notificationPolicy);
                    runs.set(input.runId, {
                      quiet: false,
                      runId: input.runId,
                      sessionId: null,
                      pageId: null,
                      agentSelection: input.agentSelection ?? null,
                      sessionTitle: input.sessionTitle,
                      automationId: input.automationId,
                      status: "IN_PROGRESS",
                      sourceCwd: input.sourceCwd,
                      readAt: null,
                      inboxTitle: null,
                      inboxSummary: null,
                      archivedUserMessage: null,
                      archivedAssistantMessage: null,
                      archivedReason: null,
                      createdAt: 50,
                      updatedAt: 50,
                    });
                    return true;
                  }),
                get: (id: string) => Effect.succeed(runs.get(id) ?? null),
                bindSession: ({ runId, sessionId }: { runId: string; sessionId: string }) =>
                  Effect.sync(() => {
                    runs.set(runId, { ...runs.get(runId)!, sessionId });
                    return true;
                  }),
                completeForReview: ({
                  runId,
                  inboxSummary,
                  quiet,
                }: {
                  runId: string;
                  inboxSummary: string;
                  quiet: boolean;
                }) =>
                  Effect.sync(() => {
                    runs.set(runId, {
                      ...runs.get(runId)!,
                      status: "PENDING_REVIEW",
                      inboxSummary,
                      quiet,
                    });
                    completions.push(runId);
                    return true;
                  }),
                archive: ({ runId }: { runId: string }, quiet = false) =>
                  Effect.sync(() => {
                    if (!runs.has(runId)) return false;
                    runs.set(runId, {
                      ...runs.get(runId)!,
                      status: "ARCHIVED",
                      archivedReason: "auto",
                      quiet,
                    });
                    return true;
                  }),
              },
            } as unknown as AutomationApplication["Service"]),
        ),
        Layer.succeed(AgentRuntimeApplication, {
          catalog: () =>
            Effect.succeed([
              {
                instanceId: agentRuntimeProviderId(binding),
                enabled: true,
                installed: true,
                status: "ready",
                models: [
                  { slug: "model", capabilities: { optionDescriptors: [] } },
                  {
                    slug: "reviewed-model",
                    capabilities: {
                      optionDescriptors: [
                        { id: "effort", type: "select", options: [{ id: "high" }] },
                        { id: "serviceTier", type: "select", options: [{ id: "fast" }] },
                      ],
                    },
                  },
                  {
                    slug: "priority-model",
                    capabilities: {
                      optionDescriptors: [
                        {
                          id: "serviceTier",
                          type: "select",
                          options: [{ id: "default" }, { id: "priority" }],
                        },
                      ],
                    },
                  },
                ].toSorted((left, right) =>
                  state.preferReviewedDefault
                    ? Number(right.slug === "reviewed-model") -
                      Number(left.slug === "reviewed-model")
                    : 0,
                ),
              },
              {
                instanceId: "other",
                enabled: true,
                installed: true,
                status: "ready",
                models: [{ slug: "model", capabilities: { optionDescriptors: [] } }],
              },
            ]),
          inspect: () =>
            Effect.succeed({
              thread: {
                providerInstanceId: state.targetProviderId,
                archivedAt: null,
                updatedAt: state.targetUpdatedAt,
                activeRunId:
                  state.waitingForInput && physical.size
                    ? `engine:${[...physical].at(-1)}`
                    : state.busy
                      ? "other-run"
                      : null,
                pendingRuntimeRequest: state.waitingForInput ? { kind: "user_input" } : null,
              },
            }),
          queueMessage: (input: AgentRuntimeMessageInput) =>
            Effect.gen(function* () {
              const { message } = input;
              messageInputs.push(input);
              if (state.denyMessage)
                return yield* Effect.fail(new Error("Read-only Turn cannot dispatch"));
              messages.push(message);
              physical.add(message.messageId);
              return { sequence: 1 };
            }),
          launch: (input: AgentRuntimeLaunch) =>
            Effect.gen(function* () {
              launches.push(input);
              if (state.failLaunch)
                return yield* Effect.fail(new Error("Admission refused before native execution"));
              if (owners?.prepareTurn) yield* owners.prepareTurn(input);
              physical.add(input.message.messageId);
              return {
                sessionId: input.sessionId,
                projectId: input.projectId,
                threadId: "engine-root",
              };
            }),
          runOutcome: ({ messageId }: { messageId: string }) =>
            Effect.succeed(
              physical.has(messageId)
                ? {
                    runId: `engine:${messageId}`,
                    status: state.pendingOutcome
                      ? "running"
                      : state.failedOutcome
                        ? "failed"
                        : state.interruptedOutcome
                          ? "interrupted"
                          : "completed",
                    completedAt: "2026-10-14T00:00:00Z",
                    finalAssistantItemId: "result",
                  }
                : null,
            ),
          item: () =>
            Effect.succeed({ type: "assistant_message", id: "result", text: state.reply }),
          stop: ({ runId }: { runId: string }) =>
            Effect.sync(() => {
              stops.push(runId);
              return { stopped: true };
            }),
        } as unknown as AgentRuntimeApplication["Service"]),
        Layer.succeed(AgentRuntimeSupervisor, {
          get: () =>
            Effect.succeed({
              responsive: Stream.make(true),
              subscribeExecutionNotifications: Effect.succeed(Stream.never),
              terminated: Effect.never,
            }),
        } as unknown as AgentRuntimeSupervisor["Service"]),
        Layer.succeed(
          ProjectWorkspace,
          owners?.workspace ??
            ({
              getProjectSession: () =>
                Effect.succeed({
                  id: "heartbeat-session",
                  projectId: "project",
                  archived: state.targetArchived,
                  executionRef: { runtimeId: "runtime", threadId: "root" },
                }),
            } as unknown as ProjectWorkspace["Service"]),
        ),
      ),
    ),
  );
  return {
    state,
    runs,
    launches,
    physical,
    completions,
    stops,
    messages,
    messageInputs,
    admissions,
    confirmations,
    layer,
  };
};

const admission = {
  pageId: "inbox-message",
  prompt: "Only run the reviewed instructions.",
  admittedAt: 100,
  agent: {
    instanceId: "codex",
    model: "reviewed-model",
    reasoningEffort: "high",
    serviceTier: "fast",
  },
};

it.effect.each(["cron", "heartbeat"] as const)(
  "%s admission freezes instructions and selection, reads the current runbook, and retains its dispatch",
  (kind) => {
    const fixture = setup();
    fixture.state.definition = {
      ...fixture.state.definition,
      kind,
      runbookPageId: "runbook",
      mode: "ask_first",
      ...(kind === "heartbeat"
        ? { targetSessionId: "heartbeat-session", projectId: null, cwds: [] }
        : {}),
    };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.executeClaimed(fixture.state.definition, { ...context, admission });
      const attempt =
        kind === "cron"
          ? fixture.launches[0]!.automationExecution
          : fixture.messageInputs[0]!.automationExecution;
      assert.equal(attempt?.automationId, definition.id);
      const submitted = kind === "cron" ? fixture.launches[0]!.message : fixture.messages[0]!;
      const selection =
        kind === "cron" ? fixture.launches[0]!.modelSelection : fixture.messages[0]!.modelSelection;
      assert.include(submitted.text, admission.prompt);
      assert.notInclude(submitted.text, definition.prompt);
      assert.include(submitted.text, "Runbook: Release checklist (OPS-4)");
      assert.include(submitted.text, "Check the last release first.");
      assert.include(submitted.text, "You may update this runbook Page");
      assert.deepEqual(selection, {
        instanceId: "codex",
        model: "reviewed-model",
        options: [
          { id: "effort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      });
      assert.equal(fixture.admissions[0]?.dispatchId, context.dispatchId);
      if (kind === "cron")
        assert.deepEqual(fixture.launches[0]?.initialPageIds, ["inbox-message", "runbook"]);
      assert.equal([...fixture.runs.values()][0]?.status, "PENDING_REVIEW");
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("unavailable overrides and missing runbooks fail before launching", () => {
  const fixture = setup();
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    for (const [agent, reason] of [
      [{ ...admission.agent, instanceId: "removed" }, /Agent is unavailable/],
      [{ ...admission.agent, model: "retired" }, /selected model is unavailable/],
    ] as const) {
      assert.match(
        yield* refusal(
          execution.executeClaimed(fixture.state.definition, {
            ...context,
            admission: { ...admission, agent },
          }),
        ),
        reason,
      );
    }
    fixture.state.definition.runbookPageId = "deleted-page";
    fixture.state.missingRunbook = true;
    assert.match(
      yield* refusal(execution.executeClaimed(fixture.state.definition, context)),
      /runbook Page is unavailable/,
    );
    assert.equal(fixture.launches.length, 0);
    assert.equal(fixture.runs.size, 0);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("an override's effort the model does not offer runs at the model's own", () => {
  const fixture = setup();
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    yield* execution.executeClaimed(fixture.state.definition, {
      ...context,
      admission: { ...admission, agent: { ...admission.agent, reasoningEffort: "max" } },
    });
    assert.deepEqual(fixture.launches[0]?.modelSelection.options, [
      { id: "serviceTier", value: "fast" },
    ]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("a Heartbeat's reviewed override must retain its chat's Agent instance", () => {
  const fixture = setup();
  fixture.state.definition = {
    ...fixture.state.definition,
    kind: "heartbeat",
    targetSessionId: "heartbeat-session",
  };
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    assert.match(
      yield* refusal(
        execution.executeClaimed(fixture.state.definition, {
          ...context,
          admission: {
            ...admission,
            agent: {
              instanceId: "other",
              model: "model",
              reasoningEffort: null,
              serviceTier: null,
            },
          },
        }),
      ),
      /heartbeat runs on its chat's Agent/,
    );
    assert.equal(fixture.messages.length, 0);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "Run now uses durable admission for a waiting decision without executing directly",
  () => {
    const fixture = setup();
    fixture.state.definition.heldDecision = {
      dispatchId: "held-dispatch",
      pageId: "message",
      inboxProjectId: null,
      firstScheduledFor: 1,
      lastScheduledFor: 2,
      missedCount: 1,
    };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.runNow({ id: definition.id });
      assert.deepEqual(fixture.confirmations, []);
      assert.equal(fixture.state.dispatches, 1);
      assert.equal(fixture.launches.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);
/** The message a refused create, save or Run now shows in its toast. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => toElectronIpcRendererError(error).message),
  );
it.effect.each([
  { kind: "codex" as const },
  { kind: "claude" as const, instanceConfigId: "named" },
  { kind: "acp" as const, agentDefinitionId: "scripted-agent", instanceConfigId: "personal" },
  { kind: "acp" as const, agentDefinitionId: "scripted-agent", instanceConfigId: "work" },
])(
  "$kind: scheduled execution binds a product Session and observes its exact submitted message",
  (binding) => {
    const fixture = setup(binding);
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.executeClaimed(fixture.state.definition, context);
      assert.equal(fixture.launches.length, 1);
      const launch = fixture.launches[0]!;
      const run = [...fixture.runs.values()][0]!;
      assert.equal(run.sessionId, launch.sessionId);
      assert.equal(launch.modelSelection.instanceId, agentRuntimeProviderId(binding));
      assert.equal(
        launch.message.text,
        [
          "Automation: Report",
          "Automation ID: report",
          "Last run: never",
          "",
          "Build a report",
        ].join("\n"),
      );
      assert.equal(launch.acceptedAt, 50);
      assert.equal(run.status, "PENDING_REVIEW");
      assert.equal(run.inboxSummary, "Completed report");
      assert.equal(fixture.physical.size, 1);
      assert.equal(fixture.stops.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect.each([true, false])(
  "a saved Nodex automation requires an exact person-selected model (%s)",
  (explicit) => {
    const instanceId = "nodex_claude_00000000000000000000000000000000";
    const fixture = setup({
      kind: "claude",
      instanceConfigId: instanceId,
      runtimeInstanceId: instanceId,
    });
    // A managed instance is not a native Claude configuration.
    fixture.state.instanceAvailable = false;
    if (!explicit) fixture.state.definition = { ...fixture.state.definition, model: null };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      const outcome = yield* execution
        .executeClaimed(fixture.state.definition, context)
        .pipe(Effect.result);
      assert.equal(outcome._tag, explicit ? "Success" : "Failure");
      assert.equal(fixture.launches.length, explicit ? 1 : 0);
      if (explicit)
        assert.deepInclude(fixture.launches[0]?.modelSelection, { instanceId, model: "model" });
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect.each([
  { kind: "heartbeat", policy: null, decision: "DONT_NOTIFY", outcome: "completed", quiet: true },
  {
    kind: "cron",
    policy: "failed_runs_only",
    decision: "NOTIFY",
    outcome: "completed",
    quiet: true,
  },
  {
    kind: "cron",
    policy: "failed_runs_only",
    decision: "NOTIFY",
    outcome: "interrupted",
    quiet: true,
  },
  {
    kind: "heartbeat",
    policy: "failed_runs_only",
    decision: "DONT_NOTIFY",
    outcome: "failed",
    quiet: false,
  },
] as const)(
  "settles $outcome $kind runs with quiet=$quiet",
  ({ kind, policy, decision, outcome, quiet }) => {
    const fixture = setup();
    fixture.state.definition = {
      ...fixture.state.definition,
      kind,
      notificationPolicy: policy,
      ...(kind === "heartbeat" ? { targetSessionId: "heartbeat-session" } : {}),
    };
    fixture.state.reply = `<heartbeat><decision>${decision}</decision></heartbeat>`;
    fixture.state.failedOutcome = outcome === "failed";
    fixture.state.interruptedOutcome = outcome === "interrupted";
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      const result = yield* execution
        .executeClaimed(fixture.state.definition, {
          ...context,
          heartbeat: {
            automationsEnabled: true,
            rendererState: {
              rendererClientId: "renderer",
              isEligible: true,
              reason: null,
              updatedAtMs: 1000,
            },
            collaborationMode: null,
          },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, outcome === "completed" ? "Success" : "Failure");
      assert.equal(fixture.runs.size, 1);
      assert.include([...fixture.runs.values()][0], {
        quiet,
        status: outcome === "completed" ? "PENDING_REVIEW" : "ARCHIVED",
      });
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "heartbeat physical lease retry observes its original message despite later busy or disabled state",
  () => {
    const fixture = setup();
    fixture.state.definition = {
      ...fixture.state.definition,
      kind: "heartbeat",
      projectId: null,
      targetSessionId: "heartbeat-session",
      cwds: [],
    };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      const heartbeat = {
        ...context,
        now: 1_000_000_000,
        heartbeat: {
          automationsEnabled: true,
          rendererState: {
            rendererClientId: "renderer",
            isEligible: true,
            reason: null,
            updatedAtMs: 1000,
          },
          collaborationMode: null,
        },
      };
      yield* execution.executeClaimed(fixture.state.definition, heartbeat);
      fixture.state.busy = true;
      yield* execution.executeClaimed(fixture.state.definition, {
        ...heartbeat,
        now: 9000,
        leaseId: "physical:replacement",
        heartbeat: { ...heartbeat.heartbeat, automationsEnabled: false },
      });
      assert.equal(fixture.messages.length, 1);
      assert.equal(fixture.physical.size, 1);
      assert.equal(fixture.launches.length, 0);
      assert.equal(fixture.runs.size, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "an interval heartbeat beats at every due time, however recently its chat changed",
  () => {
    const dueAt = Date.parse("2026-11-10T12:49:00Z");
    const fixture = setup();
    // The previous beat settled seconds after its minute and the chat's record changed since.
    fixture.state.definition = {
      ...fixture.state.definition,
      kind: "heartbeat",
      projectId: null,
      targetSessionId: "heartbeat-session",
      cwds: [],
      rrule: "FREQ=HOURLY;INTERVAL=1",
      lastRunAt: Date.parse("2026-11-10T11:49:36Z"),
    };
    fixture.state.targetUpdatedAt = "2026-11-10T12:19:36Z";
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.executeClaimed(fixture.state.definition, {
        ...context,
        now: dueAt,
        heartbeat: {
          automationsEnabled: true,
          rendererState: {
            rendererClientId: "renderer",
            isEligible: true,
            reason: null,
            updatedAtMs: dueAt,
          },
          collaborationMode: null,
        },
      });
      assert.equal(fixture.messages.length, 1);
      assert.equal(fixture.runs.size, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("heartbeat eligibility and current read-only authority refuse a fresh execution", () => {
  const fixture = setup();
  fixture.state.definition = {
    ...fixture.state.definition,
    kind: "heartbeat",
    projectId: null,
    targetSessionId: "heartbeat-session",
    cwds: [],
  };
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    const heartbeat = {
      ...context,
      now: 1_000_000_000,
      heartbeat: {
        automationsEnabled: true,
        rendererState: {
          rendererClientId: "renderer",
          isEligible: true,
          reason: null,
          updatedAtMs: 1000,
        },
        collaborationMode: null,
      },
    };
    fixture.state.busy = true;
    assert.equal(
      (yield* execution.executeClaimed(fixture.state.definition, heartbeat).pipe(Effect.result))
        ._tag,
      "Failure",
    );
    fixture.state.busy = false;
    fixture.state.denyMessage = true;
    assert.equal(
      (yield* execution.executeClaimed(fixture.state.definition, heartbeat).pipe(Effect.result))
        ._tag,
      "Failure",
    );
    assert.equal(fixture.messages.length, 0);
    assert.equal(fixture.physical.size, 0);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "failed native execution archives its stable Run without accepting a successful review",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      fixture.state.failedOutcome = true;
      assert.equal(
        (yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(fixture.completions.length, 0);
      assert.equal([...fixture.runs.values()][0]!.status, "ARCHIVED");
    }).pipe(Effect.provide(fixture.layer));
  },
);
it.effect(
  "physical lease retry and restart reuse durable Run, Session, message and accepted time",
  () => {
    const fixture = setup();
    fixture.state.failLaunch = true;
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      assert.equal(
        (yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(fixture.physical.size, 0);
      assert.equal([...fixture.runs.values()][0]!.sessionId, null);
      fixture.state.failLaunch = false;
      yield* execution.executeClaimed(fixture.state.definition, {
        ...context,
        now: 5000,
        leaseId: "physical:replacement",
      });
      yield* execution.executeClaimed(fixture.state.definition, {
        ...context,
        now: 9000,
        leaseId: "physical:third",
      });
      assert.equal(fixture.launches.length, 2);
      const { automationExecution: originalAttempt, ...originalLaunch } = fixture.launches[0]!;
      const { automationExecution: retriedAttempt, ...retriedLaunch } = fixture.launches[1]!;
      assert.deepEqual(retriedLaunch, originalLaunch);
      assert.equal(retriedAttempt?.dispatchId, originalAttempt?.dispatchId);
      assert.notEqual(retriedAttempt?.leaseId, originalAttempt?.leaseId);
      assert.equal(fixture.physical.size, 1);
      assert.equal(fixture.completions.length, 1);
      assert.equal(fixture.runs.size, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);
it.effect(
  "mismatched frozen revision and missing logical dispatch identity admit no execution or Run record",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      assert.equal(
        (yield* execution
          .executeClaimed(fixture.state.definition, { ...context, automationRevision: 2 })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* execution
          .executeClaimed(fixture.state.definition, {
            now: 1,
            reason: "scheduled",
            leaseId: "physical",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.runs.size, 0);
      assert.equal(fixture.physical.size, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);
it.effect.each(["cron", "heartbeat"] as const)(
  "%s reconciles a migrated bound dispatch without executing the retained newer configuration",
  (kind) => {
    const fixture = setup();
    fixture.state.definition = {
      ...fixture.state.definition,
      kind,
      ...(kind === "heartbeat"
        ? { targetSessionId: "heartbeat-session", projectId: null, cwds: [] }
        : {}),
    };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.executeClaimed(fixture.state.definition, { ...context, admission });
      const admitted = fixture.admissions.length;
      const submissions = fixture.launches.length + fixture.messages.length;
      fixture.state.instanceEnabled = false;
      yield* execution.executeClaimed(
        {
          ...fixture.state.definition,
          automationRevision: 2,
          prompt: "A different action",
          mode: "dry_run",
        },
        { ...context, automationRevision: 1 },
      );
      assert.equal(fixture.admissions.length, admitted);
      assert.equal(fixture.launches.length + fixture.messages.length, submissions);
      assert.equal(fixture.stops.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);

const acpBinding = {
  kind: "acp",
  agentDefinitionId: "scripted-agent",
  instanceConfigId: "personal",
} as const;
it.effect(
  "ACP scheduling rejects disabled, removed and mismatched instances before a Run or Session is admitted",
  () => {
    const fixture = setup(acpBinding);
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.prepareDefinition(fixture.state.definition);
      fixture.state.instanceEnabled = false;
      assert.equal(
        (yield* execution.prepareDefinition(fixture.state.definition).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      fixture.state.instanceEnabled = true;
      fixture.state.instanceAvailable = false;
      assert.equal(
        (yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      fixture.state.instanceAvailable = true;
      fixture.state.agentDefinitionId = "another-agent";
      assert.equal(
        (yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(fixture.launches.length, 0);
      assert.equal(fixture.runs.size, 0);
      assert.equal(fixture.physical.size, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("runs a Fast task on the id its model's catalog gives the tier", () => {
  const fixture = setup();
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    fixture.state.definition = {
      ...fixture.state.definition,
      model: "priority-model",
      serviceTier: "fast",
    };
    yield* execution.executeClaimed(fixture.state.definition, context);
    assert.deepEqual(fixture.launches[0]!.modelSelection.options, [
      { id: "serviceTier", value: "priority" },
    ]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "refusals tell the user what to change, as the scheduled-task toast receives them",
  () => {
    const fixture = setup(acpBinding);
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      const definition = fixture.state.definition;
      assert.equal(
        yield* refusal(execution.prepareDefinition({ ...definition, model: "retired" })),
        "This Agent doesn't offer model 'retired'. Choose another model.",
      );
      assert.equal(
        yield* refusal(execution.prepareDefinition({ ...definition, reasoningEffort: "high" })),
        "Model 'model' doesn't offer 'high'. Choose its options again.",
      );
      fixture.state.instanceEnabled = false;
      assert.equal(
        yield* refusal(execution.prepareDefinition(definition)),
        "This Agent is turned off. Turn it on in Settings.",
      );
      fixture.state.instanceEnabled = true;
      fixture.state.instanceAvailable = false;
      assert.equal(
        yield* refusal(execution.prepareDefinition(definition)),
        "This Agent was removed from Settings.",
      );
      fixture.state.instanceAvailable = true;
      fixture.state.failedOutcome = true;
      assert.equal(
        yield* refusal(execution.executeClaimed(definition, context)),
        "The run failed.",
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("ACP Heartbeats use one Session and refuse a replaced instance or archived chat", () => {
  const fixture = setup(acpBinding);
  fixture.state.definition = {
    ...fixture.state.definition,
    kind: "heartbeat",
    projectId: null,
    targetSessionId: "heartbeat-session",
    cwds: [],
  };
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    yield* execution.prepareDefinition(fixture.state.definition);
    yield* execution.executeClaimed(fixture.state.definition, {
      ...context,
      now: 1_000_000_000,
      heartbeat: {
        automationsEnabled: true,
        rendererState: {
          rendererClientId: "renderer",
          isEligible: true,
          reason: null,
          updatedAtMs: 1000,
        },
        collaborationMode: null,
      },
    });
    assert.equal(fixture.launches.length, 0);
    assert.equal(
      fixture.messages[0]?.modelSelection?.instanceId,
      agentRuntimeProviderId(acpBinding),
    );
    fixture.state.targetProviderId = agentRuntimeProviderId({
      ...acpBinding,
      instanceConfigId: "work",
    });
    assert.equal(
      (yield* execution.prepareDefinition(fixture.state.definition).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(
      yield* refusal(
        execution.executeClaimed(fixture.state.definition, { ...context, dispatchId: "next" }),
      ),
      "A heartbeat runs on its chat's Agent. Choose the Agent this chat uses.",
    );
    fixture.state.targetProviderId = agentRuntimeProviderId(acpBinding);
    fixture.state.targetArchived = true;
    assert.equal(
      yield* refusal(
        execution.executeClaimed(fixture.state.definition, { ...context, dispatchId: "after" }),
      ),
      "This heartbeat's chat is archived. Unarchive it or choose another chat.",
    );
    assert.equal(fixture.messages.length, 1);
  }).pipe(Effect.provide(fixture.layer));
});

class AutomationScenarioError extends Data.TaggedError("AutomationScenarioError")<{
  readonly cause: unknown;
}> {}

const acquireScenario = Effect.acquireRelease(
  Effect.callback<
    {
      client: CoreScenarioContext["client"];
      manifest: CoreScenarioContext["manifest"];
      release: () => void;
      completed: Promise<void>;
    },
    AutomationScenarioError
  >((resume) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = withCoreScenario(
      { scenarioId: AGENT_CLI_SCENARIO_ID },
      ({ client, manifest }) => {
        resume(Effect.succeed({ client, manifest, release, completed }));
        return released;
      },
    );
    void completed.catch((cause) => resume(Effect.fail(new AutomationScenarioError({ cause }))));
  }),
  ({ release, completed }) =>
    Effect.promise(() => {
      release();
      return completed;
    }),
);

/** Main's Core, Workspace and Automation owners over one real Core scenario. */
const acquireRealOwners = Effect.gen(function* () {
  const scenario = yield* acquireScenario;
  const { client } = scenario;
  const coreLayer = coreModulesLive.pipe(
    Layer.provide(
      Layer.succeed(CoreSessionAccess, {
        handshake: Effect.die("Unused handshake"),
        use: (operation, run, options) =>
          Effect.tryPromise({
            try: (signal) =>
              run(options?.projectId ? client.forProject(options.projectId) : client, signal),
            catch: (cause) => classifyCoreOperationFailure(operation, cause),
          }),
      }),
    ),
  );
  const ownersLayer = Layer.mergeAll(
    coreLayer,
    workspaceLive.pipe(Layer.provide(coreLayer)),
    automationLive.pipe(Layer.provide(routingLive), Layer.provide(coreLayer)),
  );
  const owners = yield* Layer.buildWithScope(ownersLayer, yield* Scope.Scope);
  return {
    ...scenario,
    core: Context.get(owners, CoreModules),
    workspace: Context.get(owners, ProjectWorkspace),
    automation: Context.get(owners, AutomationApplication),
  };
});

it.effect.each(["project", "projectless"] as const)(
  "%s Heartbeat creation and updates inherit the target Session through Main and real Core",
  (placement) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manifest, core, workspace, automation } = yield* acquireRealOwners;
        const fixture = setup(acpBinding, { workspace, automation });
        const sessionId = createUuidV7();
        const projectId = placement === "project" ? manifest.projectId : null;
        yield* core.workspace.apply({
          operationId: createUuidV7(),
          intent: {
            kind: "create_agent_runtime_session",
            session_id: sessionId,
            project_id: projectId,
            runtime_id: "runtime",
            runtime_thread_id: "heartbeat-root",
            launch_request_id: createUuidV7(),
            title: "Heartbeat target",
            initial_page_ids: [],
          },
        });
        yield* Effect.gen(function* () {
          const execution = yield* AutomationExecution;
          const input = {
            kind: "heartbeat" as const,
            name: "Follow up",
            prompt: "Continue the conversation",
            rrule: "FREQ=HOURLY;INTERVAL=1",
            targetSessionId: sessionId,
            backendBinding: acpBinding,
            model: "model",
          };
          // Exercise the same prepare → canonical commit chain as the IPC owner.
          const created = yield* execution
            .prepareDefinition(input)
            .pipe(Effect.flatMap(automation.automations.create));
          assert.equal(created.projectId, null);
          assert.equal(created.targetSessionId, sessionId);
          assert.deepStrictEqual(created.backendBinding, acpBinding);
          assert.deepStrictEqual(created.cwds, []);

          for (const projectId of [undefined, null]) {
            const current = yield* automation.automations.get(created.id);
            const updated = yield* execution
              .prepareDefinition(
                {
                  ...input,
                  id: created.id,
                  status: "ACTIVE",
                  projectId,
                  prompt: "Check again",
                },
                current,
              )
              .pipe(Effect.flatMap(automation.automations.update));
            assert.equal(updated?.projectId, null);
            assert.equal(updated?.targetSessionId, sessionId);
            assert.equal(updated?.prompt, "Check again");
            assert.deepStrictEqual(updated?.backendBinding, acpBinding);
          }

          // Main never strips an override to make an invalid definition appear valid.
          for (const override of [
            { projectId: manifest.projectId },
            { cwds: [path.resolve("/workspace")] },
            { localEnvironmentConfigPath: path.resolve("/workspace/environment.toml") },
          ]) {
            const expected =
              "projectId" in override
                ? "Heartbeat execution context belongs to its target Session"
                : "Heartbeat Automation cannot own cron execution paths";
            assert.equal(
              yield* refusal(
                execution
                  .prepareDefinition({ ...input, ...override })
                  .pipe(Effect.flatMap(automation.automations.create)),
              ),
              expected,
            );
            const current = yield* automation.automations.get(created.id);
            assert.equal(
              yield* refusal(
                execution
                  .prepareDefinition(
                    { ...input, id: created.id, status: "ACTIVE", ...override },
                    current,
                  )
                  .pipe(Effect.flatMap(automation.automations.update)),
              ),
              expected,
            );
            assert.deepStrictEqual(yield* automation.automations.get(created.id), current);
          }
          assert.equal((yield* automation.automations.list()).length, 1);
          assert.equal((yield* workspace.getProjectSession(sessionId))?.projectId, projectId);

          yield* workspace.archiveProjectSession({
            operationId: createUuidV7(),
            payload: { sessionId },
          });
          assert.equal(
            yield* refusal(execution.prepareDefinition(input)),
            "This heartbeat's chat is archived or no longer available. Choose another chat.",
          );
          assert.equal(
            yield* refusal(
              execution.prepareDefinition(
                { ...input, id: created.id, status: "ACTIVE" },
                yield* automation.automations.get(created.id),
              ),
            ),
            "This heartbeat's chat is archived or no longer available. Choose another chat.",
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
);

it.effect("a clock Run's first Turn gets Agent attribution before the Run binds its new chat", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { core, workspace, automation } = yield* acquireRealOwners;
      let recordedRuns = 0;
      const fixture = setup(acpBinding, {
        workspace,
        automation,
        // The Runtime prepares the new chat's first Turn through the Host, which asks Core to
        // attribute it to the message's requester, while launch is still dispatching.
        prepareTurn: (launch) =>
          Effect.gen(function* () {
            yield* core.workspace.apply({
              operationId: createUuidV7(),
              intent: {
                kind: "create_agent_runtime_session",
                session_id: launch.sessionId,
                project_id: launch.projectId,
                runtime_id: "runtime",
                runtime_thread_id: `thread:${launch.sessionId}`,
                launch_request_id: launch.launchId,
                title: launch.title,
                initial_page_ids: [...(launch.initialPageIds ?? [])],
              },
            });
            yield* core.workspace.recordAgentRun({
              session_id: launch.sessionId,
              run_id: "engine-run",
              message_id: launch.message.messageId,
              backend: "acp",
            });
            recordedRuns++;
          }),
      });
      yield* Effect.gen(function* () {
        const execution = yield* AutomationExecution;
        const created = yield* execution
          .prepareDefinition({
            kind: "cron",
            name: "Space report",
            prompt: "Report the Space",
            rrule: "FREQ=DAILY",
            projectId: null,
            cwds: [],
            backendBinding: acpBinding,
            model: "model",
            executionEnvironment: "local",
          })
          .pipe(Effect.flatMap(automation.automations.create));
        yield* automation.automations.dispatchNow(created.id);
        const due = yield* automation.automations.planDue;
        const claim = (yield* automation.automations.claimDue(due.workToken!, 3, 60_000)).find(
          (item) => item.definition.id === created.id,
        );
        if (!claim) return assert.fail("Run now did not admit the Automation");
        yield* execution.executeClaimed(claim.definition, {
          now: yield* Clock.currentTimeMillis,
          reason: "scheduled",
          leaseId: claim.leaseId,
          dispatchId: claim.dispatchId,
          admission: claim.admission,
          automationRevision: claim.automationRevision,
          deadlineMs: claim.expiresAt,
        });
        assert.equal(recordedRuns, 1);
        assert.equal(
          (yield* automation.inbox.read()).items.find((item) => item.automationId === created.id)
            ?.status,
          "PENDING_REVIEW",
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect.each(["cron", "heartbeat"] as const)(
  "Dry run %s Automations never enter execution, including a manual run",
  (kind) => {
    const fixture = setup();
    fixture.state.definition = { ...fixture.state.definition, kind, mode: "dry_run" };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      assert.match(
        yield* refusal(execution.executeClaimed(fixture.state.definition, context)),
        /Dry run Automations record decisions without starting work/,
      );
      yield* execution.runNow({ id: definition.id });
      assert.equal(fixture.state.dispatches, 1);
      assert.equal(fixture.runs.size, 0);
      assert.deepEqual(fixture.launches, []);
      assert.deepEqual(fixture.messages, []);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect.each(["timeout", "interruption"] as const)(
  "%s cancels only the Automation's exact accepted Turn",
  (reason) => {
    const fixture = setup();
    fixture.state.pendingOutcome = true;
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      const fiber = yield* execution
        .executeClaimed(fixture.state.definition, context)
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(0);
      assert.equal(fixture.launches.length, 1);
      if (reason === "timeout") {
        yield* TestClock.adjust("14 minutes");
        yield* Fiber.join(fiber);
      } else {
        yield* Fiber.interrupt(fiber);
      }
      const messageId = fixture.launches[0]!.message.messageId;
      assert.deepEqual(fixture.stops, [`engine:${messageId}`]);
      assert.equal([...fixture.runs.values()][0]?.status, "ARCHIVED");
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect.each(["reviewed", "manual"] as const)(
  "a %s frozen action survives a later Automation edit",
  (kind) => {
    const fixture = setup();
    fixture.state.changed = true;
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.executeClaimed(fixture.state.definition, {
        ...context,
        admission: {
          ...admission,
          prompt: definition.prompt,
          ...(kind === "manual" ? { pageId: null, agent: null } : {}),
        },
      });
      assert.include(fixture.launches[0]!.message.text, definition.prompt);
      assert.notInclude(fixture.launches[0]!.message.text, "A later action");
      assert.equal(fixture.physical.size, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("an unreviewed clock Run action is fenced when the Automation changes", () => {
  const fixture = setup();
  fixture.state.changed = true;
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    assert.match(
      yield* refusal(execution.executeClaimed(fixture.state.definition, context)),
      /changed before it ran/,
    );
    assert.equal(fixture.runs.size, 0);
    assert.equal(fixture.physical.size, 0);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("an accepted Run Turn is reconciled after the Owner edits its Automation", () => {
  const fixture = setup();
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    yield* execution.executeClaimed(fixture.state.definition, context);
    fixture.state.changed = true;
    yield* execution.executeClaimed(fixture.state.definition, context);
    assert.equal(fixture.admissions.length, 1);
    assert.equal(fixture.launches.length, 1);
    assert.equal(fixture.physical.size, 1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("preparation time cannot extend the exact Turn beyond its lease deadline", () => {
  const fixture = setup();
  fixture.state.pendingOutcome = true;
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    const now = yield* Clock.currentTimeMillis;
    const fiber = yield* execution
      .executeClaimed(fixture.state.definition, {
        ...context,
        deadlineMs: now + 60_000,
      })
      .pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(fiber);
    const messageId = fixture.launches[0]!.message.messageId;
    assert.deepEqual(fixture.stops, [`engine:${messageId}`]);
    assert.equal([...fixture.runs.values()][0]?.status, "ARCHIVED");
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "an Automation question cancels its exact Turn without waiting for an interactive answer",
  () => {
    const fixture = setup();
    fixture.state.pendingOutcome = true;
    fixture.state.waitingForInput = true;
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      assert.match(
        yield* refusal(execution.executeClaimed(fixture.state.definition, context)),
        /cannot wait for interactive questions or approvals/,
      );
      const messageId = fixture.launches[0]!.message.messageId;
      assert.deepEqual(fixture.stops, [`engine:${messageId}`]);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("an unbound default-model run retries the model chosen before preparation failed", () => {
  const fixture = setup(acpBinding);
  fixture.state.definition.model = null;
  fixture.state.failLaunch = true;
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.exit);
    fixture.state.failLaunch = false;
    fixture.state.preferReviewedDefault = true;
    fixture.state.instanceEnabled = false;
    assert.match(
      yield* refusal(execution.executeClaimed(fixture.state.definition, context)),
      /turned off/,
    );
    assert.equal(fixture.launches.length, 1);
    fixture.state.instanceEnabled = true;
    yield* execution.executeClaimed(fixture.state.definition, {
      ...context,
      leaseId: "replacement",
    });
    assert.equal(fixture.launches[0]?.modelSelection.model, "model");
    assert.equal(fixture.launches[1]?.modelSelection.model, "model");
    assert.equal(fixture.runs.size, 1);
    assert.equal(fixture.physical.size, 1);
    assert.equal(fixture.launches.length, 2);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each(["cron", "heartbeat"] as const)(
  "%s observes an accepted Turn without rebuilding its prompt or revalidating its Agent",
  (kind) => {
    const fixture = setup(acpBinding);
    fixture.state.definition = {
      ...fixture.state.definition,
      kind,
      runbookPageId: "runbook",
      ...(kind === "heartbeat"
        ? { targetSessionId: "heartbeat-session", projectId: null, cwds: [] }
        : {}),
    };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      const admitted = { ...context, admission: { ...admission, agent: null } };
      yield* execution.executeClaimed(fixture.state.definition, admitted);
      const run = [...fixture.runs.values()][0]!;
      fixture.runs.set(run.runId, { ...run, status: "IN_PROGRESS" });
      fixture.state.instanceEnabled = false;
      fixture.state.missingRunbook = true;
      yield* execution.executeClaimed(fixture.state.definition, {
        ...admitted,
        leaseId: "replacement",
      });
      assert.equal(fixture.launches.length + fixture.messages.length, 1);
      assert.equal(fixture.admissions.length, 1);
      assert.equal(fixture.runs.get(run.runId)?.status, "PENDING_REVIEW");
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("reconciles a message accepted before its Session binding was saved", () => {
  const fixture = setup(acpBinding);
  return Effect.gen(function* () {
    const execution = yield* AutomationExecution;
    yield* execution.executeClaimed(fixture.state.definition, context);
    const run = [...fixture.runs.values()][0]!;
    fixture.runs.set(run.runId, {
      ...run,
      sessionId: null,
      status: "ARCHIVED",
      archivedReason: "auto",
    });
    fixture.state.instanceEnabled = false;
    yield* execution.executeClaimed(fixture.state.definition, {
      ...context,
      leaseId: "replacement",
    });
    assert.equal(fixture.launches.length, 1);
    assert.equal(fixture.physical.size, 1);
    assert.equal(fixture.runs.get(run.runId)?.sessionId, run.sessionId);
    assert.equal(fixture.runs.get(run.runId)?.status, "PENDING_REVIEW");
  }).pipe(Effect.provide(fixture.layer));
});
