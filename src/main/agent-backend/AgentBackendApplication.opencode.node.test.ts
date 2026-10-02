// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  AgentConversationSnapshot,
  AgentSessionConfigOption,
} from "../../shared/agent-conversation";
import type { DesktopProjectWorkspaceThreadBackendSession } from "../core-client/project-workspace-adapter";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { AgentBackendApplicationError, make } from "./AgentBackendApplication";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import {
  beginAgentConversationTurn,
  completeAgentConversationTurn,
  emptyAgentConversationSnapshot,
} from "./AgentConversationProjection";
import { agentRuntimeError } from "./AgentRuntimeError";
import type { AgentSessionHandle } from "./AgentSessionHandle";
import { AcpBackendSessionManager } from "./acp/AcpBackendSessionManager";
import { inactiveClaudeSessions } from "./claude/ClaudeSessionManager.test-fixtures";
import {
  OpenCodeSessionManager,
  type OpenOpenCodeSessionInput,
} from "./opencode/OpenCodeSessionManager";

const binding = { kind: "opencode", instanceConfigId: "work" } as const;
const model = "moonshot/kimi-k3";
const nextModel = "moonshot/kimi-thinking";
const capabilities: AgentSessionHandle["capabilities"] = {
  prompt: { text: true, resourceLink: true, image: false, audio: false, embeddedContext: false },
  session: {
    load: true,
    list: false,
    delete: false,
    resume: true,
    unstableFork: true,
    close: true,
    additionalDirectories: false,
  },
  authMethods: [],
};

/** Drives the Application's native hooks while retaining one existing OpenCode session. */
const fixture = Effect.gen(function* () {
  const admitted = yield* Deferred.make<void>();
  const permitSend = yield* Deferred.make<void>();
  const sent = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<void>();
  const modes = {
    currentModeId: "plan",
    availableModes: [{ id: "plan", name: "Plan", description: null }],
  };
  let configOptions: readonly AgentSessionConfigOption[] = [
    {
      id: "native-model-choice",
      type: "select",
      name: "Model",
      category: "model",
      description: null,
      currentValue: model,
      options: [model, nextModel].map((value) => ({ value, name: value, description: null })),
    },
    {
      id: "variant",
      type: "select",
      name: "Variant",
      category: null,
      description: null,
      currentValue: "high",
      options: [{ value: "high", name: "High", description: null }],
    },
  ];
  const snapshot = yield* SubscriptionRef.make<AgentConversationSnapshot>({
    ...emptyAgentConversationSnapshot({
      threadId: "native",
      sessionId: "ses_existing",
      backend: "opencode",
    }),
    metadata: { revision: 0, configOptions, modes, capabilities },
  });
  let durable: DesktopProjectWorkspaceThreadBackendSession = {
    threadId: "native",
    backendBinding: binding,
    backendSessionId: "ses_existing",
    nativeHome: "/opencode-home",
    nativeState: { ever_saved: true, turns: [] },
    runtimeOptions: {
      model,
      mode_id: "plan",
      config_options: [{ id: "variant", value: "high" }],
    },
    updatedAt: 1,
  };
  const opened: OpenOpenCodeSessionInput[] = [];
  const configWrites: { id: string; value: string | boolean }[] = [];
  const statuses: string[] = [];
  let promptCalls = 0;
  let sentCalls = 0;
  let cancelCalls = 0;
  let live: AgentSessionHandle | null = null;
  const handle: AgentSessionHandle = {
    threadId: "native",
    sessionId: "ses_existing",
    capabilities,
    modes,
    get configOptions() {
      return configOptions;
    },
    snapshot,
    setIntelligence: () => Effect.die("OpenCode must not apply Claude intelligence"),
    setMode: () => Effect.die("A model override must not change the native agent"),
    setConfigOption: (id, value) =>
      Effect.gen(function* () {
        const option = configOptions.find((entry) => entry.id === id);
        if (
          !option ||
          option.type !== "select" ||
          !option.options.some((entry) => "value" in entry && entry.value === value)
        )
          return yield* agentRuntimeError({
            operation: "native option",
            reason: "request",
            retryable: false,
            cause: new Error("Unsupported model"),
          });
        configWrites.push({ id, value });
        configOptions = configOptions.map((entry) =>
          entry.id === id ? { ...option, currentValue: String(value) } : entry,
        );
        yield* SubscriptionRef.update(snapshot, (current) => ({
          ...current,
          metadata: { ...current.metadata, revision: 1, configOptions, modes, capabilities },
        }));
        return configOptions;
      }),
    prompt: (text, options) =>
      Effect.gen(function* () {
        const id = options?.clientUserMessageId;
        const hooks = opened.at(-1);
        if (!id || !hooks?.onTurnAdmitted || !hooks.onTurnSettled)
          return yield* Effect.die("Missing OpenCode admission hooks");
        promptCalls += 1;
        yield* hooks.onTurnAdmitted({ sequence: 1, clientUserMessageId: id, text });
        yield* Deferred.succeed(admitted, undefined);
        yield* Deferred.await(permitSend);
        sentCalls += 1;
        yield* SubscriptionRef.update(snapshot, (current) =>
          beginAgentConversationTurn(current, 1, text, id),
        );
        yield* Deferred.succeed(sent, undefined);
        yield* Deferred.await(finish);
        yield* SubscriptionRef.update(snapshot, (current) =>
          completeAgentConversationTurn(current, 1, {
            status: "completed",
            stopReason: "end_turn",
            error: null,
          }),
        );
        yield* hooks.onTurnSettled({
          sequence: 1,
          clientUserMessageIds: [id],
          status: "completed",
          stopReason: "end_turn",
          nativeSessionId: "ses_existing",
          everSaved: true,
        });
        return { stopReason: "end_turn" };
      }),
    cancel: Effect.sync(() => {
      cancelCalls += 1;
    }),
  };
  const manager = OpenCodeSessionManager.of({
    nativeHome: () => Effect.succeed("/opencode-home"),
    discover: () => Effect.die("Existing native submission must not perform discovery"),
    open: (input) =>
      Effect.sync(() => {
        opened.push(input);
        live = handle;
        return handle;
      }),
    get: () => Effect.sync(() => live),
    close: () =>
      Effect.sync(() => {
        live = null;
      }),
    observe: () => Effect.void,
    unobserve: () => Effect.void,
    changes: Stream.empty,
  });
  const app = yield* make.pipe(
    Effect.provide(inactiveClaudeSessions),
    Effect.provideService(OpenCodeSessionManager, manager),
    Effect.provideService(ApplicationSettings, makeTestApplicationSettings()),
    Effect.provideService(AcpBackendSessionManager, {
      get: () => Effect.succeed(null),
      open: () => Effect.die("Unexpected ACP launch"),
      close: () => Effect.void,
      observe: () => Effect.void,
      unobserve: () => Effect.void,
      changes: Stream.empty,
    }),
    Effect.provideService(AgentBackendRegistry, {
      resolve: () =>
        Effect.succeed({ kind: "opencode", binding, displayName: "Work", instance: {} as never }),
      resolveAcpInstance: () => Effect.die("Unexpected ACP resolution"),
    }),
    Effect.provideService(ProjectWorkspace, {
      getThread: () =>
        Effect.succeed({
          threadId: "native",
          projectId: "project",
          sessionId: "session",
          backendBinding: binding,
          cwd: "/workspace",
          archived: false,
          executionHostId: "local",
          statusType: "idle",
          updatedAt: 1,
          threadName: "Existing task",
        }),
      getProject: () =>
        Effect.succeed({
          id: "project",
          lifecycle: "active",
          primaryWorkspaceRoot: "/workspace",
        }),
      readProjectPermissionMode: () => Effect.succeed("auto"),
      readThreadExecutionContext: () =>
        Effect.succeed({
          projectId: "project",
          permissionMode: "auto",
          writableRoots: ["/workspace"],
          workspaceState: null,
        }),
      readThreadBackendSession: () => Effect.sync(() => durable),
      bindThreadBackendSession: (
        input: Parameters<ProjectWorkspace["Service"]["bindThreadBackendSession"]>[0],
      ) =>
        Effect.sync(() => {
          assert.equal(input.expectedBackendSessionId, "ses_existing");
          durable = {
            ...durable,
            ...input,
            nativeState: input.nativeState ?? durable.nativeState,
            runtimeOptions: input.runtimeOptions ?? durable.runtimeOptions,
          };
        }),
      updateThread: (_id: string, input: { status?: { statusType: string } }) =>
        Effect.sync(() => {
          if (input.status) statuses.push(input.status.statusType);
          return {};
        }),
    } as never),
  );
  return {
    app,
    opened,
    configWrites,
    statuses,
    durable: () => durable,
    promptCalls: () => promptCalls,
    sentCalls: () => sentCalls,
    cancelCalls: () => cancelCalls,
    admitted: Deferred.await(admitted),
    send: Deferred.succeed(permitSend, undefined),
    sent: Deferred.await(sent),
    finish: Deferred.succeed(finish, undefined),
  };
});

it.effect(
  "existing OpenCode submissions preserve native model options and return admission before sending once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.deepEqual(yield* f.app.nativeConversations.read("native"), {
          threadId: "native",
          backendBinding: binding,
          busy: false,
          archived: false,
          updatedAt: 1,
          title: "Existing task",
        });
        assert.isEmpty(f.opened);
        const input = {
          threadId: "native",
          operationId: "model-once",
          prompt: "Run",
          model: nextModel,
        };
        const first = yield* f.app.nativeConversations.submit(input).pipe(Effect.forkChild);
        const duplicate = yield* f.app.nativeConversations.submit(input).pipe(Effect.forkChild);
        yield* f.admitted;
        const receipt = yield* Fiber.join(first);
        assert.deepEqual(yield* Fiber.join(duplicate), receipt);
        assert.lengthOf(f.opened, 1);
        assert.equal(f.opened[0]?.resumeSessionId, "ses_existing");
        assert.equal(f.opened[0]?.workspaceRoot, "/workspace");
        assert.deepEqual(f.configWrites, [{ id: "native-model-choice", value: nextModel }]);
        assert.deepEqual(f.durable().runtimeOptions, {
          model: nextModel,
          mode_id: "plan",
          config_options: [{ id: "variant", value: "high" }],
        });
        assert.equal(f.promptCalls(), 1);
        assert.equal(f.sentCalls(), 0);
        assert.deepEqual(f.statuses, ["active"]);
        yield* f.send;
        yield* f.sent;
        assert.isTrue((yield* f.app.nativeConversations.read("native"))?.busy);
        yield* Effect.flip(f.app.nativeConversations.submit({ ...input, model }));
        yield* f.finish;
        assert.equal(
          (yield* f.app.nativeConversations.wait("native", receipt.turnId)).outcome,
          "completed",
        );
        assert.isFalse((yield* f.app.nativeConversations.read("native"))?.busy);
        assert.deepEqual(yield* f.app.nativeConversations.submit(input), receipt);
        assert.equal(f.sentCalls(), 1);
        assert.lengthOf(f.configWrites, 1);
      }),
    ),
);

it.effect("OpenCode cancellation only targets the requested pending native turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const submitting = yield* f.app.nativeConversations
        .submit({
          threadId: "native",
          operationId: "pending-turn",
          prompt: "Run",
        })
        .pipe(Effect.forkChild);
      yield* f.admitted;
      const receipt = yield* Fiber.join(submitting);
      yield* f.send;
      yield* f.sent;
      yield* f.app.nativeConversations.cancel("native", "another-turn");
      assert.equal(f.cancelCalls(), 0);
      yield* f.app.nativeConversations.cancel("native", receipt.turnId);
      assert.equal(f.cancelCalls(), 1);
      yield* f.finish;
      yield* f.app.nativeConversations.wait("native", receipt.turnId);
      yield* f.app.nativeConversations.cancel("native", receipt.turnId);
      assert.equal(f.cancelCalls(), 1);
    }),
  ),
);

for (const unsupported of [{ effort: "high" }, { unattended: true }] as const) {
  it.effect(
    `OpenCode native submissions reject ${"effort" in unsupported ? "effort" : "unattended policy"} before mutating or sending`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const error = yield* Effect.flip(
            f.app.nativeConversations.submit({
              threadId: "native",
              operationId: "unsupported",
              prompt: "Run",
              model: nextModel,
              ...unsupported,
            }),
          );
          if (!(error instanceof AgentBackendApplicationError)) return yield* Effect.die(error);
          assert.equal(error.operation, "native.submit");
          const cause =
            error.cause instanceof AgentBackendApplicationError ? error.cause.cause : error.cause;
          if (!(cause instanceof Error)) return yield* Effect.die(cause);
          assert.equal(cause.message, "OpenCode does not support this execution option");
          assert.isEmpty(f.configWrites);
          assert.equal(f.durable().runtimeOptions?.model, model);
          assert.equal(f.promptCalls(), 0);
        }),
      ),
  );
}
