import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { AgentRuntimeLaunch, AgentRuntimeMessage } from "../../shared/agent-runtime-api";
import type { CodexScheduledAutomation, CodexAutomationRun } from "../../shared/types";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AutomationApplication } from "./AutomationApplication";
import { AutomationExecution, live } from "./AutomationExecution";
import { live as backendRegistryLive } from "../agent-backend/AgentBackendRegistry";
import { ApplicationSettings } from "../settings/ApplicationSettings";

const definition: CodexScheduledAutomation = {
  id: "report",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  notificationPolicy: null,
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
const setup = (binding: CodexScheduledAutomation["backendBinding"] = { kind: "codex" }) => {
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
  };
  const runs = new Map<string, CodexAutomationRun>();
  const launches: AgentRuntimeLaunch[] = [];
  const physical = new Set<string>();
  const completions: string[] = [];
  const stops: string[] = [];
  const messages: AgentRuntimeMessage[] = [];
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
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
        Layer.succeed(AutomationApplication, {
          definitions: {
            getForExecution: () =>
              Effect.succeed(
                state.changed ? { ...state.definition, definitionRevision: 2 } : state.definition,
              ),
            get: () => Effect.succeed(state.definition),
            dispatchNow: () => Effect.succeed(state.definition),
          },
          runs: {
            begin: (input: {
              runId: string;
              automationId: string;
              sessionTitle: string;
              sourceCwd: string | null;
            }) =>
              Effect.sync(() => {
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
            completeForReview: ({ runId, inboxSummary }: { runId: string; inboxSummary: string }) =>
              Effect.sync(() => {
                runs.set(runId, { ...runs.get(runId)!, status: "PENDING_REVIEW", inboxSummary });
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
        Layer.succeed(AgentRuntimeApplication, {
          catalog: () =>
            Effect.succeed([
              {
                instanceId: agentRuntimeProviderId(binding),
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
        Layer.succeed(ProjectWorkspace, {
          getProjectSession: () =>
            Effect.succeed({
              id: "heartbeat-session",
              projectId: "project",
              archived: false,
              executionRef: { runtimeId: "runtime", threadId: "root" },
            }),
        } as unknown as ProjectWorkspace["Service"]),
      ),
    ),
  );
  return { state, runs, launches, physical, completions, stops, messages, layer };
};
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
      assert.equal(fixture.runs.size, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("heartbeat eligibility and current read-only authority refuse a fresh execution", () => {
  const fixture = setup();
  fixture.state.definition = {
    ...fixture.state.definition,
    kind: "heartbeat",
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

it.effect("ACP Heartbeats use the same Session and refuse a replaced instance", () => {
  const fixture = setup(acpBinding);
  fixture.state.definition = {
    ...fixture.state.definition,
    kind: "heartbeat",
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
      (yield* execution
        .executeClaimed(fixture.state.definition, { ...context, dispatchId: "next" })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(fixture.messages.length, 1);
  }).pipe(Effect.provide(fixture.layer));
});
