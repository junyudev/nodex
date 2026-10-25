import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { CodexScheduledAutomation } from "../../shared/types";
import {
  AutomationApplication,
  AutomationApplicationError,
  type AutomationDefinitions,
} from "../automation-application/AutomationApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createStableOperationId } from "../core-runtime/operation-identity";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make, makeWithCapture } from "./AutomationAppTools";
import { createHostedAppToolCaller, captureHostedAppToolAuthority } from "./AppToolCaller";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";

const authority: NodexAgentTurnContext = {
  threadId: "thread:a",
  turnId: "turn:a",
  rootThreadId: "thread:a",
  actorProjectId: "project:a",
  libraryId: "library:a",
  storeEpoch: "epoch:a",
  admittedAtMs: 1_000,
};
const provenance = {
  profile_id: "profile:a",
  authority: {
    thread_id: "thread:a",
    turn_id: "turn:a",
    root_thread_id: "thread:a",
    actor_project_id: "project:a",
    library_id: "library:a",
    store_epoch: "epoch:a",
  },
};
const input = (args: Record<string, unknown>): AppToolInvocation => ({
  name: "automation_update",
  arguments: args,
  caller: {
    threadId: "thread:a",
    turnId: "turn:a",
    callId: "call:a",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
});
const cron = {
  kind: "cron",
  name: "Check release builds",
  prompt: "Check release builds and report failed jobs.",
  rrule: "FREQ=HOURLY;INTERVAL=24",
  projectId: "project:a",
  executionEnvironment: "local",
  cwds: ["/workspace/project-a"],
  notificationPolicy: "failed_runs_only",
  model: "chosen-model",
  reasoningEffort: "ultra",
  serviceTier: "priority",
};
const item: CodexScheduledAutomation = {
  id: "automation:a",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project:a",
  targetSessionId: null,
  notificationPolicy: "failed_runs_only",
  name: "Check release builds",
  prompt: "Check release builds and report failed jobs.",
  rrule: "FREQ=HOURLY;INTERVAL=24",
  model: "chosen-model",
  reasoningEffort: "ultra",
  serviceTier: "priority",
  backendBinding: { kind: "codex" },
  cwds: ["/workspace/project-a"],
  executionEnvironment: "local",
  localEnvironmentConfigPath: null,
  nextRunAt: 60_000,
  lastRunAt: null,
  createdAt: 1_000,
  updatedAt: 1_000,
};
const setup = (
  definitions: Partial<AutomationDefinitions>,
  options: {
    readOnly?: boolean;
    workspace?: Partial<ProjectWorkspaceService>;
  } = {},
) =>
  make.pipe(
    Effect.provideService(AutomationApplication, {
      definitions: { get: () => Effect.succeed(item), ...definitions },
    } as never),
    Effect.provideService(ProjectWorkspace, {
      getThread: () => Effect.succeed({ backendBinding: { kind: "codex" } } as never),
      getProjectSession: () =>
        Effect.succeed({ thread: { backendBinding: { kind: "codex" } } } as never),
      ...options.workspace,
    } as ProjectWorkspaceService),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile:a" } } as never),
    Effect.provideService(CodexTurnAuthority, {
      capture: () => Effect.succeed({ ...authority }),
    } as never),
  );

it.effect("reads definition windows with execution provenance and rejects forged authority", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    const execute = yield* setup({
      listWindow: (query) =>
        Effect.gen(function* () {
          reads.push({ query, provenance: yield* CoreApplicationAgent });
          return { items: [item], nextCursor: "older" };
        }),
      get: (id) =>
        Effect.gen(function* () {
          reads.push({ id, provenance: yield* CoreApplicationAgent });
          return item;
        }),
    });
    const listed = yield* execute(
      input({ mode: "list", query: "build", cursor: "page", limit: 7 }),
    );
    assert.deepStrictEqual(listed.structuredContent, { items: [item], nextCursor: "older" });
    const viewed = yield* execute(input({ mode: "view", id: item.id }));
    assert.deepStrictEqual(viewed.structuredContent, { item });
    assert.deepStrictEqual(reads, [
      { query: { query: "build", cursor: "page", limit: 7 }, provenance },
      { id: item.id, provenance },
    ]);
    const forged = yield* execute(
      input({ ...cron, mode: "create", authority: { scope: "library" } }),
    );
    assert.deepStrictEqual(forged.structuredContent, { error: { code: "invalid_arguments" } });
    assert.strictEqual(yield* CoreApplicationAgent, null);
  }),
);

it.effect("relays exact definition commands, revision fences, and stable retry provenance", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const execute = yield* setup({
      create: (definition, command) =>
        Effect.gen(function* () {
          calls.push({
            mode: "create",
            definition,
            command,
            provenance: yield* CoreApplicationAgent,
          });
          return item;
        }),
      update: (definition, command) =>
        Effect.gen(function* () {
          calls.push({
            mode: "update",
            definition,
            command,
            provenance: yield* CoreApplicationAgent,
          });
          return { ...item, status: "PAUSED", definitionRevision: 2 };
        }),
      delete: (id, command) =>
        Effect.gen(function* () {
          calls.push({ mode: "delete", id, command, provenance: yield* CoreApplicationAgent });
          return { item: null, success: true, status: "deleted", deletedRunCount: 3 };
        }),
    });
    const call = input({ ...cron, mode: "create" });
    const operationId = createStableOperationId("app.automation_update", authority.admittedAtMs, [
      "profile:a",
      "thread:a",
      "turn:a",
      "call:a",
    ]);
    const first = yield* execute(call);
    assert.deepStrictEqual(first.structuredContent, { operationId, item });
    assert.deepStrictEqual(yield* execute(call), first);
    const retry = yield* execute({
      ...call,
      arguments: { ...call.arguments, operationId },
      caller: { ...call.caller, callId: "retry:a" },
    });
    assert.deepStrictEqual(retry, first);
    assert.deepStrictEqual(calls[0], calls[1]);
    assert.deepStrictEqual(calls[0], calls[2]);
    assert.deepStrictEqual(calls[0], {
      mode: "create",
      definition: { ...cron, backendBinding: { kind: "codex" } },
      command: { operationId },
      provenance,
    });

    const updateId = createStableOperationId("automation-test", 1_000, "update");
    const updated = yield* execute(
      input({
        ...cron,
        mode: "update",
        id: item.id,
        status: "PAUSED",
        notificationPolicy: null,
        expectedRevision: 1,
        operationId: updateId,
      }),
    );
    assert.strictEqual(updated.structuredContent?.operationId, updateId);
    assert.deepStrictEqual(calls[3], {
      mode: "update",
      definition: {
        ...cron,
        id: item.id,
        status: "PAUSED",
        notificationPolicy: null,
        backendBinding: { kind: "codex" },
      },
      command: { operationId: updateId, expectedRevision: 1 },
      provenance,
    });
    const deleteId = createStableOperationId("automation-test", 1_000, "delete");
    const deleted = yield* execute(
      input({
        mode: "delete",
        id: item.id,
        expectedRevision: 2,
        operationId: deleteId,
      }),
    );
    assert.deepStrictEqual(deleted.structuredContent, {
      operationId: deleteId,
      item: null,
      success: true,
      status: "deleted",
      deletedRunCount: 3,
    });
    assert.deepStrictEqual(calls[4], {
      mode: "delete",
      id: item.id,
      command: { operationId: deleteId, expectedRevision: 2 },
      provenance,
    });
    assert.strictEqual(yield* CoreApplicationAgent, null);
  }),
);

it.effect("defaults Heartbeats to the caller's stable Session and preserves explicit targets", () =>
  Effect.gen(function* () {
    const targets: unknown[] = [];
    const lookups: unknown[] = [];
    const execute = yield* setup(
      {
        create: (definition) =>
          Effect.sync(() => {
            targets.push(definition);
            return item;
          }),
      },
      {
        workspace: {
          getThread: (threadId) =>
            Effect.gen(function* () {
              lookups.push({ threadId, provenance: yield* CoreApplicationAgent });
              return { sessionId: "session:caller", executionHostId: "local" } as never;
            }),
        },
      },
    );
    const definition = {
      kind: "heartbeat",
      name: "Watch the build",
      prompt: "Report build changes.",
      rrule: "FREQ=MINUTELY;INTERVAL=30",
    };
    assert.isUndefined((yield* execute(input({ ...definition, mode: "create" }))).isError);
    assert.isUndefined(
      (yield* execute(
        input({
          ...definition,
          mode: "create",
          targetSessionId: "session:other",
        }),
      )).isError,
    );
    assert.deepStrictEqual(lookups, [{ threadId: "thread:a", provenance }]);
    assert.deepStrictEqual(targets, [
      { ...definition, targetSessionId: "session:caller", backendBinding: { kind: "codex" } },
      { ...definition, targetSessionId: "session:other", backendBinding: { kind: "codex" } },
    ]);
  }),
);

it.effect("rejects a caller withdrawn during target lookup before committing a Heartbeat", () =>
  Effect.gen(function* () {
    let active = true;
    let writes = 0;
    const execute = yield* setup(
      {
        create: () =>
          Effect.sync(() => {
            writes++;
            return item;
          }),
      },
      {
        workspace: {
          getThread: () =>
            Effect.sync(() => {
              active = false;
              return { sessionId: "session:caller", executionHostId: "local" } as never;
            }),
        },
      },
    );
    const call = input({
      mode: "create",
      kind: "heartbeat",
      name: "Build",
      prompt: "Check builds.",
      rrule: "FREQ=MINUTELY;INTERVAL=30",
    });
    const result = yield* execute({ ...call, caller: { ...call.caller, isActive: () => active } });
    assert.isTrue(result.isError);
    assert.strictEqual(writes, 0);
  }),
);

it.effect(
  "represents missing definitions and safely rejects denied owners or withdrawn results",
  () =>
    Effect.gen(function* () {
      const missing = yield* setup({ get: () => Effect.succeed(null) });
      assert.deepStrictEqual(
        (yield* missing(input({ mode: "view", id: "missing" }))).structuredContent,
        { item: null },
      );
      const denied = yield* setup({
        get: () =>
          Effect.fail(
            new AutomationApplicationError({
              operation: "get",
              cause: new Error("private persisted authority detail"),
            }),
          ),
      });
      const rejected = yield* denied(input({ mode: "view", id: "private" }));
      assert.isTrue(rejected.isError);
      assert.notInclude(JSON.stringify(rejected), "private persisted authority detail");
      let active = true;
      const withdrawn = yield* setup({
        create: () =>
          Effect.sync(() => {
            active = false;
            return item;
          }),
      });
      const call = input({ ...cron, mode: "create" });
      assert.isTrue(
        (yield* withdrawn({
          ...call,
          caller: { ...call.caller, isActive: () => active },
        })).isError,
      );
    }),
);

it.effect("returns review proposals without mutation and rejects stale update proposals", () =>
  Effect.gen(function* () {
    const execute = yield* setup({ get: () => Effect.succeed(item) }, {});
    const created = yield* execute(input({ ...cron, mode: "suggested_create" }));
    assert.deepStrictEqual(created.structuredContent, {
      proposal: { ...cron, mode: "suggested_create", backendBinding: { kind: "codex" } },
      committed: false,
    });
    const args = {
      ...cron,
      mode: "suggested_update",
      id: item.id,
      expectedRevision: 1,
      status: "PAUSED",
    };
    assert.deepStrictEqual((yield* execute(input(args))).structuredContent, {
      proposal: { ...args, backendBinding: { kind: "codex" } },
      committed: false,
    });
    assert.deepStrictEqual(
      (yield* execute(input({ ...args, expectedRevision: 2 }))).structuredContent,
      {
        error: { code: "conflict" },
      },
    );
  }),
);

it.effect(
  "Runtime Heartbeats target the trusted Session and validate canonical provider metadata without legacy Thread reads",
  () =>
    Effect.gen(function* () {
      const definitions: unknown[] = [];
      const caller = createHostedAppToolCaller({
        backend: "codex",
        authority,
        callId: "runtime-heartbeat",
        generation: 1,
        isActive: () => true,
        capture: Effect.succeed(authority),
        sessionContext: {
          sessionId: "runtime-session",
          projectId: "project:a",
          runtimeId: "engine",
          rootThreadId: "engine-root",
          threadId: "engine-child",
          runId: "engine-run",
          cwd: "/workspace",
        },
      });
      const execute = yield* makeWithCapture(captureHostedAppToolAuthority).pipe(
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile:a" } } as never),
        Effect.provideService(ProjectWorkspace, {
          getThread: () => Effect.die("Runtime callers must not read old Thread coordinates"),
        } as never),
        Effect.provideService(AgentRuntimeApplication, {
          inspect: () => Effect.succeed({ thread: { providerInstanceId: "codex" } }),
          catalog: () =>
            Effect.succeed([
              { instanceId: "codex", models: [], enabled: true, installed: true, status: "ready" },
            ]),
        } as never),
        Effect.provideService(AutomationApplication, {
          definitions: {
            get: () => Effect.succeed(null),
            create: (definition: unknown) =>
              Effect.sync(() => {
                definitions.push(definition);
                return item;
              }),
          },
        } as never),
      );
      const result = yield* execute({
        caller,
        name: "automation_update",
        arguments: {
          mode: "create",
          kind: "heartbeat",
          name: "Watch",
          prompt: "Report changes",
          rrule: "FREQ=HOURLY;INTERVAL=1",
        },
      });
      assert.isUndefined(result.isError);
      assert.equal(
        (definitions[0] as { targetSessionId: string }).targetSessionId,
        "runtime-session",
      );
      assert.deepEqual((definitions[0] as { backendBinding: unknown }).backendBinding, {
        kind: "codex",
      });
    }),
);

it.effect(
  "ACP callers keep their exact instance for Cron and Heartbeat tools and cannot schedule a disabled account",
  () =>
    Effect.gen(function* () {
      const binding = {
        kind: "acp",
        agentDefinitionId: "scripted-agent",
        instanceConfigId: "personal",
      } as const;
      const providerId = agentRuntimeProviderId(binding);
      const workHeartbeat: CodexScheduledAutomation = {
        ...item,
        id: "automation:work-heartbeat",
        kind: "heartbeat",
        targetSessionId: "work-session",
        backendBinding: { ...binding, instanceConfigId: "work" },
      };
      let enabled = true;
      const definitions: Array<Parameters<AutomationDefinitions["create"]>[0]> = [];
      const caller = createHostedAppToolCaller({
        backend: "acp",
        authority,
        callId: "acp-automation",
        generation: 1,
        isActive: () => true,
        capture: Effect.succeed(authority),
        sessionContext: {
          sessionId: "acp-session",
          projectId: "project:a",
          runtimeId: "engine",
          rootThreadId: "engine-root",
          threadId: "engine-child",
          runId: "engine-run",
          cwd: "/workspace",
        },
      });
      const execute = yield* makeWithCapture(captureHostedAppToolAuthority).pipe(
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile:a" } } as never),
        Effect.provideService(ProjectWorkspace, {
          getThread: () => Effect.die("ACP must use the hosted Session"),
        } as never),
        Effect.provideService(ApplicationSettings, {
          snapshot: () =>
            Effect.succeed({
              claudeAgents: { instances: [] },
              openCodeAgents: { instances: [] },
              acpAgents: {
                instances: ["personal", "work"].map((id) => ({
                  id,
                  agentDefinitionId: "scripted-agent",
                  enabled,
                })),
              },
            }),
        } as never),
        Effect.provideService(AgentRuntimeApplication, {
          inspect: () => Effect.succeed({ thread: { providerInstanceId: providerId } }),
          catalog: () =>
            Effect.succeed([
              {
                instanceId: providerId,
                enabled: true,
                installed: true,
                status: "ready",
                models: [{ slug: "chosen-model" }],
              },
            ]),
        } as never),
        Effect.provideService(AutomationApplication, {
          definitions: {
            get: (id: string) => Effect.succeed(id === workHeartbeat.id ? workHeartbeat : null),
            create: (definition: Parameters<AutomationDefinitions["create"]>[0]) =>
              Effect.sync(() => {
                definitions.push(definition);
                return { ...item, backendBinding: binding };
              }),
          },
        } as never),
      );
      const request = (arguments_: Record<string, unknown>) =>
        execute({ caller, name: "automation_update", arguments: arguments_ });
      assert.isUndefined(
        (yield* request({ ...cron, mode: "create", backendBinding: binding })).isError,
      );
      assert.isUndefined(
        (yield* request({
          mode: "create",
          kind: "heartbeat",
          name: "Watch",
          prompt: "Report changes",
          rrule: "FREQ=HOURLY;INTERVAL=1",
        })).isError,
      );
      assert.deepEqual(
        definitions.map((definition) => definition.backendBinding),
        [binding, binding],
      );
      assert.equal(definitions[1]?.targetSessionId, "acp-session");
      const heartbeat = {
        kind: "heartbeat",
        prompt: "Report changes",
        rrule: "FREQ=HOURLY;INTERVAL=1",
      };
      const failureBody = (result: { content: unknown }) =>
        JSON.parse((result.content as [{ text: string }])[0].text) as unknown;
      const sessionAgent = {
        code: "automation_backend_unavailable",
        details: { backendBinding: binding },
      };
      const wrongInstance = yield* request({
        ...heartbeat,
        mode: "create",
        name: "Wrong instance",
        backendBinding: { ...binding, instanceConfigId: "work" },
      });
      assert.deepEqual(wrongInstance.structuredContent, { error: sessionAgent });
      assert.deepEqual(failureBody(wrongInstance), {
        message:
          "A Heartbeat runs on its target Session's Agent. Omit backendBinding, or pass the one included here.",
        backendBinding: binding,
      });
      const retarget = {
        ...heartbeat,
        mode: "suggested_update",
        id: workHeartbeat.id,
        expectedRevision: workHeartbeat.definitionRevision,
        status: "ACTIVE",
        name: "Moved",
        targetSessionId: "acp-session",
      };
      const kept = yield* request(retarget);
      assert.deepEqual(kept.structuredContent, { error: sessionAgent });
      assert.deepEqual(failureBody(kept), {
        message:
          "A Heartbeat runs on its target Session's Agent, and update keeps the task's current backendBinding when it is omitted. Pass the backendBinding included here.",
        backendBinding: binding,
      });
      const included = (kept.structuredContent as { error: typeof sessionAgent }).error.details;
      assert.deepEqual((yield* request({ ...retarget, ...included })).structuredContent, {
        proposal: { ...retarget, backendBinding: binding },
        committed: false,
      });
      const retired = yield* request({
        ...cron,
        mode: "create",
        backendBinding: binding,
        model: "retired-model",
      });
      assert.deepEqual(retired.structuredContent, {
        error: { code: "automation_model_unavailable" },
      });
      assert.deepEqual(retired.content, [
        {
          type: "text",
          text: "The selected Agent doesn't offer this model. Omit model to use its first available model.",
        },
      ]);
      enabled = false;
      const off = yield* request({ ...cron, mode: "create", backendBinding: binding });
      assert.deepEqual(off.structuredContent, {
        error: { code: "automation_backend_unavailable" },
      });
      assert.deepEqual(off.content, [
        {
          type: "text",
          text: "The selected Agent is off, removed or not ready. Ask the user to check it in Settings, or choose another Agent.",
        },
      ]);
      const unknownAgent = yield* request({
        ...heartbeat,
        mode: "create",
        name: "Off",
        backendBinding: binding,
      });
      assert.deepEqual(unknownAgent.structuredContent, {
        error: { code: "automation_backend_unavailable" },
      });
      assert.deepEqual(unknownAgent.content, [
        {
          type: "text",
          text: "The target Session is unavailable or its Agent is off or removed. Ask the user to check that Agent in Settings, or target another Session.",
        },
      ]);
      assert.equal(definitions.length, 2);
    }),
);
