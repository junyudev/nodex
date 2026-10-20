import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { createHostedAppToolCaller } from "./AppToolCaller";
import { make } from "./RuntimeSessionCommands";
const authority: NodexAgentTurnContext = {
  threadId: "child",
  turnId: "run",
  rootThreadId: "root",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1791993600000,
  runtime: { sessionId: "session:root", runtimeId: "runtime", turnKind: "run" },
};
const fixture = () => {
  const frozen = authority;
  let active = true;
  const calls: Array<{ name: string; input: unknown; agent: unknown }> = [];
  const method = (name: string, result: unknown) => (input: unknown) =>
    Effect.gen(function* () {
      calls.push({ name, input, agent: yield* CoreApplicationAgent });
      return result;
    });
  const caller = createHostedAppToolCaller({
    backend: "claude",
    authority: frozen,
    callId: "call",
    generation: 1,
    isActive: () => active,
    capture: Effect.succeed(frozen),
    sessionContext: {
      sessionId: "session:root",
      projectId: "project",
      runtimeId: "engine",
      rootThreadId: "root",
      threadId: "child",
      runId: "run",
      cwd: "/worktree",
    },
  });
  const execute = make.pipe(
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(CoreModules, {} as never),
    Effect.provideService(CodexTurnAuthority, {} as never),
    Effect.provideService(AgentRuntimeApplication, {
      inspect: method("inspect", {
        sessionId: "session:root",
        projectId: "project",
        threadId: "child",
        thread: {
          modelSelection: { instanceId: "claude_instance", model: "sonnet" },
          interactionMode: "plan",
        },
      }),
      launch: method("launch", { sessionId: "new", projectId: "project", threadId: "new-root" }),
      message: method("message", { sequence: 1 }),
      fork: method("fork", {
        sourceSessionId: "session:root",
        sessionId: "fork",
        projectId: "project",
        threadId: "fork-root",
      }),
    } as never),
  );
  return {
    caller,
    calls,
    execute,
    withdraw: () => {
      active = false;
    },
  };
};
it.effect(
  "forks the current child within its bound product Session using exact engine identity",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const execute = yield* f.execute;
      const result = yield* execute({ caller: f.caller, name: "fork_session", arguments: {} });
      assert.isFalse(result.isError ?? false);
      const call = f.calls.find((call) => call.name === "fork")!;
      assert.deepEqual((call.input as { source: unknown }).source, {
        sessionId: "session:root",
        threadId: "child",
      });
      assert.deepEqual((call.agent as { authority: unknown }).authority, {
        thread_id: "child",
        turn_id: "run",
        root_thread_id: "root",
        actor_project_id: "project",
        library_id: "library",
        store_epoch: "epoch",
        runtime: { session_id: "session:root", runtime_id: "runtime", turn_kind: "run" },
      });
      assert.notEqual((call.input as { sessionId: string }).sessionId, "session:root");
    }),
);
it.effect(
  "launches and messages through canonical product owners with stable retry identities",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const execute = yield* f.execute;
      const invocation = {
        caller: f.caller,
        name: "create_session",
        arguments: {
          prompt: "Build",
          target: { type: "project", projectId: "project", environment: { type: "local" } },
        },
      };
      yield* execute(invocation);
      yield* execute(invocation);
      const launches = f.calls.filter((call) => call.name === "launch");
      assert.deepEqual(launches[0]!.input, launches[1]!.input);
      assert.equal(
        (launches[0]!.input as { modelSelection: { instanceId: string } }).modelSelection
          .instanceId,
        "claude_instance",
      );
      yield* execute({
        caller: f.caller,
        name: "send_message_to_session",
        arguments: { sessionId: "other", prompt: "Continue" },
      });
      assert.equal(f.calls.filter((call) => call.name === "message").length, 1);
      assert.isNotNull(f.calls.find((call) => call.name === "message")!.agent);
      // A model override travels with its message and keeps the Session's own Agent.
      yield* execute({
        caller: f.caller,
        name: "send_message_to_session",
        arguments: { sessionId: "other", prompt: "Review", model: "opus" },
      });
      const messages = f.calls.filter((call) => call.name === "message");
      assert.deepEqual(
        (messages[0]!.input as { message: { modelSelection?: unknown } }).message.modelSelection,
        undefined,
      );
      assert.deepEqual(
        (messages[1]!.input as { message: { modelSelection?: unknown } }).message.modelSelection,
        { instanceId: "claude_instance", model: "opus" },
      );
      // Another Agent continues the Session from its model's own defaults.
      yield* execute({
        caller: f.caller,
        name: "send_message_to_session",
        arguments: {
          sessionId: "other",
          prompt: "Take over",
          providerInstanceId: "codex",
          model: "gpt",
        },
      });
      assert.deepEqual(
        (
          f.calls.filter((call) => call.name === "message")[2]!.input as {
            message: { modelSelection?: unknown };
          }
        ).message.modelSelection,
        { instanceId: "codex", model: "gpt" },
      );
      // Choosing another Agent names the model it runs.
      const unnamed = yield* execute({
        caller: f.caller,
        name: "send_message_to_session",
        arguments: { sessionId: "other", prompt: "Take over", providerInstanceId: "codex" },
      });
      assert.isTrue(unnamed.isError);
    }),
);
it.effect(
  "cross-Project Session commands retain Profile identity; forged and withdrawn callers fail",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const execute = yield* f.execute;
      const input = { caller: f.caller, name: "fork_session", arguments: {} };
      assert.isTrue((yield* execute({ ...input, caller: { ...f.caller } })).isError);
      const created = yield* execute({
        caller: f.caller,
        name: "create_session",
        arguments: {
          prompt: "Other",
          target: { type: "project", projectId: "foreign", environment: { type: "local" } },
        },
      });
      assert.isFalse(created.isError ?? false);
      const launch = f.calls.find((call) => call.name === "launch")!;
      assert.equal((launch.input as { projectId: string }).projectId, "foreign");
      assert.equal((launch.agent as { profile_id: string }).profile_id, "profile");
      const before = f.calls.length;
      f.withdraw();
      assert.isTrue((yield* execute(input)).isError);
      assert.equal(f.calls.length, before);
    }),
);

it.effect(
  "native calls create Runtime Sessions with exact source identity and stable retries",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      let active = true;
      let attached = true;
      const original = {
        ...authority,
        threadId: "native-root",
        turnId: "native-turn-a",
        rootThreadId: "native-root",
      };
      const caller = {
        backend: "codex" as const,
        threadId: original.threadId,
        turnId: original.turnId,
        callId: "native-call-a",
        hostId: "local",
        generation: 7,
        isActive: () => active,
      };
      const execute = yield* make.pipe(
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
        Effect.provideService(CodexTurnAuthority, {
          capture: (threadId: string, turnId: string) =>
            Effect.sync(() => {
              assert.equal(threadId, "native-root");
              assert.equal(turnId, "native-turn-a");
              return original;
            }),
        } as unknown as CodexTurnAuthority["Service"]),
        Effect.provideService(CoreModules, {
          workspace: {
            read: (input: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
              attached
                ? Effect.sync(() => {
                    assert.deepEqual(input, {
                      kind: "codex_thread_session",
                      thread_id: "native-root",
                      expected_execution_host_id: "local",
                    });
                    return {
                      value: {
                        kind: "codex_thread_session",
                        thread: {
                          thread_id: "native-root",
                          backend_binding: { kind: "codex" },
                          execution_host_id: "local",
                          parent_thread_id: null,
                          session_id: "native-product",
                          thread_source: "user",
                          status: { status_type: "idle", active_flags: [] },
                        },
                        session: {
                          id: "native-product",
                          project_id: "project",
                          thread_id: "native-root",
                          display_title: "Historical source",
                          no_thread_fallback_title: "Historical source",
                          archived: false,
                        },
                      },
                    } as never;
                  })
                : Effect.fail(
                    coreRuntimeError({
                      operation: "workspace.read",
                      reason: "operation",
                      retryable: false,
                      cause: new CoreModuleResponseError({
                        code: "not_found",
                        message: "Native product binding retired",
                        retryable: false,
                        recovery: { kind: "none" },
                      }),
                    }),
                  ),
          },
        } as unknown as CoreModules["Service"]),
        Effect.provideService(AgentRuntimeApplication, {
          catalog: () =>
            Effect.succeed([
              {
                instanceId: "codex",
                enabled: true,
                installed: true,
                status: "ready",
                models: [{ slug: "codex-default", isDefault: true }],
              },
            ]),
          launch: (input: Parameters<AgentRuntimeApplication["Service"]["launch"]>[0]) =>
            Effect.gen(function* () {
              f.calls.push({ name: "launch", input, agent: yield* CoreApplicationAgent });
              return {
                sessionId: input.sessionId,
                projectId: input.projectId,
                threadId: "runtime-root",
              };
            }),
        } as unknown as AgentRuntimeApplication["Service"]),
      );
      const invocation = {
        caller,
        name: "create_session",
        arguments: {
          prompt: "Build across Projects",
          target: { type: "project", projectId: "other-project", environment: { type: "local" } },
          reasoningEffort: "high",
        },
      };
      assert.isFalse((yield* execute(invocation)).isError ?? false);
      assert.isFalse((yield* execute(invocation)).isError ?? false);
      assert.deepEqual(f.calls[0]?.input, f.calls[1]?.input);
      assert.deepEqual((f.calls[0]?.input as { modelSelection: unknown }).modelSelection, {
        instanceId: "codex",
        model: "codex-default",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      assert.equal(
        (f.calls[0]?.agent as { authority: { turn_id: string } }).authority.turn_id,
        "native-turn-a",
      );
      assert.equal((f.calls[0]?.input as { projectId: string }).projectId, "other-project");
      attached = false;
      assert.isTrue((yield* execute(invocation)).isError);
      active = false;
      assert.isTrue((yield* execute(invocation)).isError);
      assert.equal(f.calls.length, 2);
    }),
);
