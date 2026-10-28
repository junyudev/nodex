import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { AGENT_CLI_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/agent-cli-workflow";
import type { AgentRuntimeLaunch, AgentRuntimeMessage } from "../../shared/agent-runtime-api";
import type { CodexScheduledAutomation, CodexAutomationRun } from "../../shared/types";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { ProjectWorkspace, live as workspaceLive } from "../project-application/ProjectWorkspace";
import { AutomationApplication, live as automationLive } from "./AutomationApplication";
import { AutomationExecution, live } from "./AutomationExecution";
import { live as backendRegistryLive } from "../agent-backend/AgentBackendRegistry";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { toElectronIpcRendererError } from "../platform/electron/electron-ipc-error";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "../core-runtime/CoreModules";
import { live as routingLive } from "../core-runtime/AutomationRoutingIndex";
import { classifyCoreOperationFailure } from "../core-runtime/CoreRuntimeError";
import { InboxApplication } from "../inbox-application/InboxApplication";
import { createUuidV7 } from "../../shared/uuid-v7";

const definition: CodexScheduledAutomation = {
  id: "report",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  notificationPolicy: null,
  launch: "automatic",
  runbookPageId: null,
  runbookTitle: null,
  heldFiring: null,
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
  definitionRevision: 1,
};
const setup = (
  binding: CodexScheduledAutomation["backendBinding"] = { kind: "codex" },
  owners?: {
    readonly automation: AutomationApplication["Service"];
    readonly workspace: ProjectWorkspace["Service"];
  },
) => {
  const state = {
    definition: { ...definition, backendBinding: binding },
    failLaunch: false,
    changed: false,
    busy: false,
    denyMessage: false,
    failedOutcome: false,
    instanceEnabled: true,
    instanceAvailable: true,
    agentDefinitionId: binding.kind === "acp" ? binding.agentDefinitionId : "",
    targetProviderId: agentRuntimeProviderId(binding),
    targetArchived: false,
    missingRunbook: false,
    dispatches: 0,
  };
  const runs = new Map<string, CodexAutomationRun>();
  const launches: AgentRuntimeLaunch[] = [];
  const physical = new Set<string>();
  const completions: string[] = [];
  const stops: string[] = [];
  const admissions: Array<{ dispatchId?: string }> = [];
  const confirmations: string[] = [];
  const messages: AgentRuntimeMessage[] = [];
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(InboxApplication, {
          confirmScheduledFiring: (firing: NonNullable<CodexScheduledAutomation["heldFiring"]>) =>
            Effect.sync(() => {
              confirmations.push(firing.dispatchId);
            }),
        } as unknown as InboxApplication["Service"]),
        Layer.succeed(CoreModules, {
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
              definitions: {
                getForExecution: () =>
                  Effect.succeed(
                    state.changed
                      ? { ...state.definition, definitionRevision: 2 }
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
                  sessionTitle: string;
                  sourceCwd: string | null;
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
                    runs.set(input.runId, {
                      runId: input.runId,
                      sessionId: null,
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
                }: {
                  runId: string;
                  inboxSummary: string;
                }) =>
                  Effect.sync(() => {
                    runs.set(runId, {
                      ...runs.get(runId)!,
                      status: "PENDING_REVIEW",
                      inboxSummary,
                    });
                    completions.push(runId);
                    return true;
                  }),
                archive: ({ runId }: { runId: string }) =>
                  Effect.sync(() => {
                    runs.set(runId, {
                      ...runs.get(runId)!,
                      status: "ARCHIVED",
                      archivedReason: "auto",
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
                ],
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
                updatedAt: "1970-01-01T00:00:00Z",
                activeRunId: state.busy ? "other-run" : null,
                pendingRuntimeRequest: null,
              },
            }),
          queueMessage: ({ message }: { message: AgentRuntimeMessage }) =>
            Effect.gen(function* () {
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
                    status: state.failedOutcome ? "failed" : "completed",
                    completedAt: "2026-10-14T00:00:00Z",
                    finalAssistantItemId: "result",
                  }
                : null,
            ),
          item: () =>
            Effect.succeed({ type: "assistant_message", id: "result", text: "Completed report" }),
          stop: ({ runId }: { runId: string }) =>
            Effect.sync(() => {
              stops.push(runId);
              return { stopped: true };
            }),
        } as unknown as AgentRuntimeApplication["Service"]),
        Layer.succeed(AgentRuntimeSupervisor, {
          get: () =>
            Effect.succeed({
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
      launch: "ask",
      ...(kind === "heartbeat"
        ? { targetSessionId: "heartbeat-session", projectId: null, cwds: [] }
        : {}),
    };
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      yield* execution.executeClaimed(fixture.state.definition, { ...context, admission });
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

it.effect("Run now confirms a waiting firing without dispatching another one", () => {
  const fixture = setup();
  fixture.state.definition.heldFiring = {
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
    assert.deepEqual(fixture.confirmations, ["held-dispatch"]);
    assert.equal(fixture.state.dispatches, 0);
    assert.equal(fixture.launches.length, 0);
  }).pipe(Effect.provide(fixture.layer));
});
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
      assert.deepEqual(fixture.launches[1], fixture.launches[0]);
      assert.equal(fixture.physical.size, 1);
      assert.equal(fixture.completions.length, 1);
      assert.equal(fixture.runs.size, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);
it.effect(
  "stale Definition and missing logical dispatch identity admit no execution or Run record",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const execution = yield* AutomationExecution;
      fixture.state.changed = true;
      assert.equal(
        (yield* execution.executeClaimed(fixture.state.definition, context).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      fixture.state.changed = false;
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
      assert.equal(yield* refusal(execution.runNow({ id: definition.id })), "The run failed.");
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

it.effect.each(["project", "projectless"] as const)(
  "%s Heartbeat creation and updates inherit the target Session through Main and real Core",
  (placement) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, manifest } = yield* acquireScenario;
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
        const core = Context.get(owners, CoreModules);
        const workspace = Context.get(owners, ProjectWorkspace);
        const automation = Context.get(owners, AutomationApplication);
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
            .pipe(Effect.flatMap(automation.definitions.create));
          assert.equal(created.projectId, null);
          assert.equal(created.targetSessionId, sessionId);
          assert.deepStrictEqual(created.backendBinding, acpBinding);
          assert.deepStrictEqual(created.cwds, []);

          for (const projectId of [undefined, null]) {
            const current = yield* automation.definitions.get(created.id);
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
              .pipe(Effect.flatMap(automation.definitions.update));
            assert.equal(updated?.projectId, null);
            assert.equal(updated?.targetSessionId, sessionId);
            assert.equal(updated?.prompt, "Check again");
            assert.deepStrictEqual(updated?.backendBinding, acpBinding);
          }

          // Main never strips an override to make an invalid definition appear valid.
          for (const override of [
            { projectId: manifest.projectId },
            { cwds: ["/workspace"] },
            { localEnvironmentConfigPath: "/workspace/environment.toml" },
          ]) {
            const expected =
              "projectId" in override
                ? "Heartbeat execution context belongs to its target Session"
                : "Heartbeat Scheduled Automation cannot own cron execution paths";
            assert.equal(
              yield* refusal(
                execution
                  .prepareDefinition({ ...input, ...override })
                  .pipe(Effect.flatMap(automation.definitions.create)),
              ),
              expected,
            );
            const current = yield* automation.definitions.get(created.id);
            assert.equal(
              yield* refusal(
                execution
                  .prepareDefinition(
                    { ...input, id: created.id, status: "ACTIVE", ...override },
                    current,
                  )
                  .pipe(Effect.flatMap(automation.definitions.update)),
              ),
              expected,
            );
            assert.deepStrictEqual(yield* automation.definitions.get(created.id), current);
          }
          assert.equal((yield* automation.definitions.list()).length, 1);
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
                yield* automation.definitions.get(created.id),
              ),
            ),
            "This heartbeat's chat is archived or no longer available. Choose another chat.",
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
);
