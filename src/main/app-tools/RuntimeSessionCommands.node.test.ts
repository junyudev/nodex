import { codexLinkedRootSessionFixture } from "../core-client/testing/codex-linked-root-session.test-support";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexAttachments } from "../codex-application/CodexAttachments";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { CodexDelegatedMessages } from "../codex-application/CodexDelegatedMessages";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { createHostedAppToolCaller } from "./AppToolCaller";
import { makeCommands as make } from "./NativeSessionTools";
import { nativeQuestionTestLayers } from "./native-question-test-layers";
import { nativeQuestionFixture } from "./native-question-test-fixture";
const intakeServices = Layer.mergeAll(
  Layer.succeed(ProjectWorkspace, {
    getProjectSession: () =>
      Effect.succeed({
        id: "native-product",
        archived: false,
        thread: {
          threadId: "native-root",
          backendBinding: { kind: "codex" },
          executionHostId: "local",
        },
      }),
  } as never),
  Layer.succeed(CodexThreadDirectory, {
    resolve: () =>
      Effect.succeed({
        canonical: {
          hostId: "local",
          currentPermissions: {
            sandboxPolicy: { type: "dangerFullAccess" },
            approvalPolicy: "never",
            approvalsReviewer: "user",
          },
          latestModel: "codex-default",
          latestCollaborationMode: { mode: "plan" },
          latestThreadSettings: {
            model: "codex-default",
            collaborationMode: { mode: "plan" },
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        },
      }),
  } as never),
  Layer.succeed(CodexMainConversationResume, {
    resume: () => Effect.succeed({ status: "ready" }),
  } as never),
  Layer.succeed(CodexDelegatedMessages, {} as never),
  Layer.succeed(CodexAttachments, {} as never),
  Layer.succeed(ExecutionHostRuntime, {} as never),
  Layer.succeed(CodexGateway, { localHostId: "local" } as never),
  Layer.succeed(FileExportRuntime, {} as never),
  Layer.succeed(CodexNativeThreadLookup, {} as never),
  Layer.succeed(TemporaryAssets, {} as never),
);
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
const fixture = (
  options: {
    archived?: boolean;
    native?: boolean;
    restricted?: boolean;
    targetDefault?: boolean;
    nativeQuestions?: typeof nativeQuestionTestLayers;
    policyFailure?: "model_off" | "credit_requires_person";
  } = {},
) => {
  const frozen = authority;
  const deliveries = new Map<string, Record<string, unknown>>();
  const createdSessions = new Set<string>();
  let active = true;
  const calls: Array<{ name: string; input: unknown; agent: unknown }> = [];
  const method =
    <T>(name: string, result: T) =>
    (input: unknown) =>
      Effect.gen(function* () {
        calls.push({ name, input, agent: yield* CoreApplicationAgent });
        if (options.policyFailure && (name === "launch" || name === "sendMessage"))
          return yield* Effect.fail(
            new AgentRuntimeApplicationError({
              operation: name,
              code: options.policyFailure,
              message: "Choose another model in Settings → Models.",
              retryable: false,
            }),
          );
        return result;
      });
  const makeCaller = (turnId = frozen.turnId, callId = "call") =>
    createHostedAppToolCaller({
      backend: "claude",
      authority: { ...frozen, turnId },
      callId,
      generation: 1,
      isActive: () => active,
      capture: Effect.succeed({ ...frozen, turnId }),
      sessionContext: {
        sessionId: "session:root",
        projectId: "project",
        runtimeId: "engine",
        rootThreadId: "root",
        threadId: "child",
        runId: turnId,
        cwd: "/worktree",
      },
    });
  const caller = makeCaller();
  const execute = make.pipe(
    Effect.provide(options.nativeQuestions ?? nativeQuestionTestLayers),
    Effect.provide(intakeServices),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(CoreModules, {
      workspace: {
        admitToolOperation: createAppToolAdmissionFixture().admitToolOperation,
        read: (request: { session_id: string }) =>
          Effect.succeed({
            value: {
              kind: "agent_session",
              session: {
                id: request.session_id,
                archived: request.session_id === "other" && options.archived === true,
                execution_ref:
                  options.native && request.session_id === "other"
                    ? null
                    : {
                        runtime_id: "runtime",
                        thread_id: request.session_id === "session:root" ? "root" : "target",
                      },
              },
            },
          }),
      },
    } as never),
    Effect.provideService(CodexTurnAuthority, {} as never),
    Effect.provideService(AgentRuntimeApplication, {
      assertModelPolicy: () => Effect.void,
      nativeMessageReceipt: () => Effect.succeed(null),
      replayMessage: (input: { messageId: string }) =>
        Effect.succeed(deliveries.get(input.messageId) ?? null),
      resumeMessageLaunch: () => Effect.succeed(null),
      inspect: (input: { sessionId: string }) =>
        method("inspect", {
          sessionId: input.sessionId,
          projectId: "project",
          threadId: input.sessionId === "session:root" ? "child" : "target",
          thread: {
            modelSelection: { instanceId: "claude_instance", model: "sonnet" },
            interactionMode:
              input.sessionId === "other" && options.targetDefault ? "default" : "plan",
            runtimeMode:
              input.sessionId === "session:root" && options.restricted
                ? "approval-required"
                : "full-access",
          },
        })(input),
      listQuestionIds: method("listQuestions", { requestIds: ["question"] }),
      control: method("control", {
        snapshot: {
          projection: {
            runtimeRequests: [
              {
                id: "question",
                kind: "user_input",
                status: "pending",
                nodeId: "node",
                responseCapability: { type: "message" },
              },
            ],
            turnItems: [
              {
                type: "user_input_request",
                requestId: "question",
                questions: [
                  { id: "format", header: "Format", question: "Which format?", options: [] },
                ],
              },
            ],
            nodes: [{ id: "node", runId: "source-run" }],
          },
        },
      }),
      respond: method("respond", { sequence: 1 }),
      launch: (input: { sessionId: string }) =>
        Effect.gen(function* () {
          createdSessions.add(input.sessionId);
          return yield* method("launch", {
            sessionId: "new",
            projectId: "project",
            threadId: "new-root",
          })(input);
        }),
      sendMessage: (input: { message: { messageId: string } }) =>
        Effect.gen(function* () {
          const outcome = yield* method("sendMessage", {
            sessionId: "other",
            threadId: "target",
            messageId: "message:delivered",
            runId: "run:accepted",
            status: "queued",
            delivery: "queued",
          })(input);
          deliveries.set(input.message.messageId, outcome);
          return outcome;
        }),
      execution: method("execution", {
        selectedRunId: "run:accepted",
        runId: "run:accepted",
        status: "queued",
      }),
      mergeBack: method("merge", { sessionId: "source", projectId: "project", threadId: "root" }),
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
    makeCaller,
    calls,
    createdSessions,
    execute,
    withdraw: () => {
      active = false;
    },
  };
};

it.effect.each([
  { name: "create_session", code: "model_off" },
  { name: "create_session", code: "credit_requires_person" },
  { name: "send_message_to_session", code: "model_off" },
  { name: "send_message_to_session", code: "credit_requires_person" },
] as const)("preserves Runtime $code refusal from $name", ({ name, code }) =>
  Effect.gen(function* () {
    const f = fixture({ policyFailure: code });
    const execute = yield* f.execute;
    const result = yield* execute({
      caller: f.caller,
      name,
      arguments:
        name === "create_session"
          ? {
              prompt: "Must not start",
              target: { type: "project", projectId: "project", environment: { type: "local" } },
            }
          : { sessionId: "other", prompt: "Must not continue" },
    });
    assert.isTrue(result.isError);
    assert.deepEqual(result.structuredContent, { error: { code } });
    assert.deepEqual(result.content, [
      { type: "text", text: "Choose another model in Settings → Models." },
    ]);
  }),
);
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
      yield* execute({ ...invocation, caller: f.makeCaller("later", "retry") });
      yield* execute({ ...invocation, caller: f.makeCaller("later", "retry") });
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
      assert.equal(f.calls.filter((call) => call.name === "sendMessage").length, 1);
      assert.isNotNull(f.calls.find((call) => call.name === "sendMessage")!.agent);
      // A model override travels with its message and keeps the Session's own Agent.
      yield* execute({
        caller: f.makeCaller(undefined, "review"),
        name: "send_message_to_session",
        arguments: { sessionId: "other", prompt: "Review", model: "opus" },
      });
      const messages = f.calls.filter((call) => call.name === "sendMessage");
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
        caller: f.makeCaller(undefined, "switch-agent"),
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
          f.calls.filter((call) => call.name === "sendMessage")[2]!.input as {
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
it.effect("merges another fork Session back into its source, never the calling Session", () =>
  Effect.gen(function* () {
    const f = fixture();
    const execute = yield* f.execute;
    const own = yield* execute({
      caller: f.caller,
      name: "merge_session_back",
      arguments: { sessionId: "session:root" },
    });
    assert.isTrue(own.isError);
    const merged = yield* execute({
      caller: f.caller,
      name: "merge_session_back",
      arguments: { sessionId: "fork" },
    });
    assert.isFalse(merged.isError ?? false);
    const call = f.calls.find((entry) => entry.name === "merge")!;
    assert.equal((call.input as { sessionId: string }).sessionId, "fork");
    assert.isNotNull(call.agent);
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
      let restricted = false;
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
        Effect.provide(nativeQuestionTestLayers),
        Effect.provideService(CodexThreadDirectory, {
          resolve: () =>
            Effect.succeed({
              canonical: {
                hostId: "local",
                currentPermissions: {
                  sandboxPolicy: restricted
                    ? { type: "readOnly", networkAccess: false }
                    : { type: "dangerFullAccess" },
                  approvalPolicy: "on-request",
                  approvalsReviewer: "user",
                },
                latestModel: "codex-default",
                latestCollaborationMode: { mode: "plan" },
                latestThreadSettings: {
                  model: "codex-default",
                  collaborationMode: { mode: "plan" },
                  approvalPolicy: "on-request",
                  sandboxPolicy: restricted
                    ? { type: "readOnly", networkAccess: false }
                    : { type: "dangerFullAccess" },
                },
              },
            }),
        } as never),
        Effect.provide(intakeServices),
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
            admitToolOperation: createAppToolAdmissionFixture().admitToolOperation,
            read: (input: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
              attached
                ? Effect.sync(() => {
                    if (input.kind === "agent_session")
                      return {
                        value: {
                          kind: "agent_session",
                          session: { id: "native-product", archived: false },
                          thread: { thread_id: "native-root" },
                        },
                      } as never;
                    assert.deepEqual(input, {
                      kind: "codex_thread_session",
                      thread_id: "native-root",
                      expected_execution_host_id: "local",
                    });
                    return codexLinkedRootSessionFixture({
                      threadId: "native-root",
                      sessionId: "native-product",
                      projectId: "project",
                      threadSource: "user",
                      title: "Historical source",
                    });
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
          execution: () => Effect.succeed({ selectedRunId: "run:launched" }),
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
      assert.equal((f.calls[0]?.input as { interactionMode: string }).interactionMode, "plan");
      assert.deepEqual((f.calls[0]?.input as { modeLimit: unknown }).modeLimit, {
        runtimeMode: "full-access",
        interactionMode: "plan",
      });
      restricted = true;
      const denied = yield* execute({
        ...invocation,
        arguments: { ...invocation.arguments, runtimeMode: "full-access" },
      });
      assert.equal(
        denied.structuredContent?.error &&
          (denied.structuredContent.error as { code: string }).code,
        "runtime_mode_escalation_denied",
      );
      assert.equal(
        f.calls.length,
        2,
        "A newly restricted Native caller cannot launch full-access work",
      );
      attached = false;
      assert.isTrue((yield* execute(invocation)).isError);
      active = false;
      assert.isTrue((yield* execute(invocation)).isError);
      assert.equal(f.calls.length, 2);
    }),
);

it.effect(
  "routes explicit delivery modes and returns the owning Run identity for exact waits",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const execute = yield* f.execute;
      for (const mode of ["auto", "queue", "steer", "restart"] as const) {
        const invocation = {
          caller: f.makeCaller(undefined, `mode:${mode}`),
          name: "send_message_to_session",
          arguments: { sessionId: "other", prompt: "Continue", mode },
        };
        const result = yield* execute(invocation);
        assert.equal(result.structuredContent?.runId, "run:accepted");
        assert.equal(result.structuredContent?.resolvedRunId, "run:accepted");
        assert.equal(result.structuredContent?.status, "queued");
        assert.equal(typeof result.structuredContent?.messageId, "string");
        const sent = f.calls.filter((call) => call.name === "sendMessage").at(-1)!;
        assert.equal((sent.input as { mode: string }).mode, mode);
        assert.equal(result.structuredContent?.deliveryState, "queued");
        assert.equal((sent.input as { senderThreadId: string }).senderThreadId, "child");
        assert.equal((sent.input as { senderRunId: string }).senderRunId, "run");
        const replay = yield* execute(invocation);
        assert.deepEqual(replay.structuredContent, result.structuredContent);
      }
    }),
);

it.effect(
  "self-send can select the caller's child execution without creating a product Session",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const execute = yield* f.execute;
      const result = yield* execute({
        caller: f.caller,
        name: "send_message_to_session",
        arguments: {
          sessionId: "session:root",
          execution: { threadId: "child" },
          prompt: "Continue here",
          mode: "queue",
        },
      });
      assert.isFalse(result.isError ?? false);
      const sent = f.calls.find((call) => call.name === "sendMessage")!;
      assert.equal((sent.input as { sessionId: string }).sessionId, "session:root");
      assert.equal((sent.input as { threadId: string }).threadId, "child");
      assert.isFalse(f.calls.some((call) => call.name === "launch"));
    }),
);

it.effect("UUID retries in a later Turn reuse one message and reject changed arguments", () =>
  Effect.gen(function* () {
    const f = fixture();
    const execute = yield* f.execute;
    const args = {
      sessionId: "other",
      prompt: "Continue",
      idempotencyKey: "06d6709c-45e7-4b37-8c26-74e9d64c5aa1",
    };
    const first = yield* execute({
      caller: f.caller,
      name: "send_message_to_session",
      arguments: args,
    });
    assert.isFalse(first.isError ?? false);
    const second = yield* execute({
      caller: f.makeCaller("later", "retry"),
      name: "send_message_to_session",
      arguments: args,
    });
    assert.deepStrictEqual(second, first);
    assert.equal(f.calls.filter((call) => call.name === "sendMessage").length, 1);
    const collision = yield* execute({
      caller: f.makeCaller("later", "changed"),
      name: "send_message_to_session",
      arguments: { ...args, prompt: "Different" },
    });
    assert.deepStrictEqual(collision.structuredContent, {
      error: { code: "idempotency_key_reused" },
    });
    assert.equal(f.calls.filter((call) => call.name === "sendMessage").length, 1);
  }),
);

it.effect("Session retries preserve the first host admission time and Session identity", () =>
  Effect.gen(function* () {
    const f = fixture();
    const execute = yield* f.execute;
    const args = {
      prompt: "Inspect the task",
      target: { type: "projectless", directoryName: "retry" },
      idempotencyKey: "create-session",
    };
    const first = yield* execute({ caller: f.caller, name: "create_session", arguments: args });
    const second = yield* execute({
      caller: f.makeCaller("later", "retry"),
      name: "create_session",
      arguments: args,
    });
    assert.isFalse(first.isError ?? false);
    assert.deepStrictEqual(second, first);
    assert.equal(f.createdSessions.size, 1);
    const launches = f.calls.filter((call) => call.name === "launch");
    assert.deepStrictEqual(launches[0]?.input, launches[1]?.input);
    assert.equal((launches[0]?.input as { acceptedAt: number }).acceptedAt, 1_000);
  }),
);

it.effect(
  "answers Session questions with captured caller identity and stable operation arguments",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const execute = yield* f.execute;
      const invocation = {
        caller: f.caller,
        name: "session_question",
        arguments: {
          action: "respond",
          sessionId: "other",
          execution: { threadId: "target-child" },
          requestId: "question",
          answers: { format: "Markdown" },
          idempotencyKey: "answer-format",
        },
      };
      const first = yield* execute(invocation);
      assert.isFalse(first.isError ?? false);
      assert.deepInclude(first.structuredContent, { requestId: "question", status: "answered" });
      yield* execute({ ...invocation, caller: f.makeCaller("later", "retry") });
      const responses = f.calls.filter((call) => call.name === "respond");
      const stableResponse = (value: unknown) => {
        const { respondedBy, ...request } = value as { respondedBy: { senderRunId?: string } };
        const { senderRunId: _run, ...source } = respondedBy;
        return { ...request, respondedBy: source };
      };
      assert.deepEqual(stableResponse(responses[0]?.input), stableResponse(responses[1]?.input));
      assert.deepInclude(responses[0]?.input, {
        threadId: "target-child",
        runId: "source-run",
        respondedBy: {
          kind: "agent",
          senderThreadId: "child",
          senderRunId: "run",
          senderSessionId: "session:root",
        },
        requirePending: true,
        modeLimit: { runtimeMode: "full-access", interactionMode: "plan" },
      });
      assert.isNotNull(responses[0]?.agent);
    }),
);

for (const action of ["list", "read", "respond"] as const) {
  for (const [options, code] of [
    [{ archived: true }, "not_found"],
    [{ restricted: true }, "forbidden"],
    [{ targetDefault: true }, "forbidden"],
    [{ native: true }, "unavailable"],
  ] as const) {
    it.effect(`checks ${JSON.stringify(options)} admission for session_question ${action}`, () =>
      Effect.gen(function* () {
        const f = fixture(options);
        const execute = yield* f.execute;
        const result = yield* execute({
          caller: f.caller,
          name: "session_question",
          arguments: {
            action,
            sessionId: "other",
            requestId: "question",
            answers: { format: "Markdown" },
          },
        });
        assert.isTrue(result.isError);
        assert.deepInclude(result.structuredContent, { error: { code } });
        assert.isFalse(
          f.calls.some(
            (call) =>
              call.name === "listQuestions" || call.name === "control" || call.name === "respond",
          ),
        );
      }),
    );
  }
}

it.effect.each(["live", "async"] as const)(
  "lists, reads and answers a native %s question through session_question",
  (kind) =>
    Effect.gen(function* () {
      const native = nativeQuestionFixture();
      const f = fixture({ native: true, nativeQuestions: native.services });
      const execute = yield* f.execute;
      const requestId = kind === "live" ? native.syncId : `native:async:${native.asyncQuestionId}`;
      const questionId = kind === "live" ? "scope" : native.asyncQuestionId;
      const idempotencyKey = `native-question-${kind}`;
      const invoke = (action: "list" | "read" | "respond") =>
        execute({
          caller: f.caller,
          name: "session_question",
          arguments: {
            action,
            sessionId: "other",
            ...(action === "list" ? {} : { requestId }),
            ...(action === "respond"
              ? { answers: { [questionId]: "Project" }, idempotencyKey }
              : {}),
          },
        });
      assert.deepEqual((yield* invoke("list")).structuredContent, {
        requestIds: [native.syncId, `native:async:${native.asyncQuestionId}`],
      });
      const read = yield* invoke("read");
      assert.isFalse(read.isError ?? false);
      assert.deepInclude(read.structuredContent, { requestId });
      const answered = yield* invoke("respond");
      const operationId = answered.structuredContent?.operationId;
      if (typeof operationId !== "string") throw new Error("Missing admitted operation identity");
      assert.deepEqual(answered.structuredContent, {
        requestId,
        status: "answered",
        operationId,
      });
      assert.deepEqual((yield* invoke("respond")).structuredContent, answered.structuredContent);
      assert.deepEqual((yield* invoke("list")).structuredContent, {
        requestIds: [kind === "live" ? `native:async:${native.asyncQuestionId}` : native.syncId],
      });
      assert.deepEqual((yield* invoke("read")).structuredContent, {
        error: { code: "not_pending" },
      });
      const respondedBy = {
        kind: "agent" as const,
        senderThreadId: "child",
        senderSessionId: "session:root",
      };
      assert.equal(native.syncCalls.length, kind === "live" ? 1 : 0);
      assert.equal(native.asyncCalls.length, kind === "async" ? 1 : 0);
      if (kind === "live") {
        assert.deepEqual(native.syncCalls[0], {
          threadId: "native-root",
          requestId: "live",
          answers: { scope: ["Project"] },
          questionResponse: { respondedBy, operationId },
        });
      } else {
        assert.deepEqual(native.asyncCalls[0]?.sourceTurnIds, ["source"]);
        assert.deepEqual(native.answerRecords().get(questionId)?.respondedBy, respondedBy);
      }
      assert.isFalse(
        f.calls.some(({ name }) => ["respond", "launch", "sendMessage"].includes(name)),
      );
    }),
);

it.effect("withdrawn Session question calls cannot inspect or answer their target", () =>
  Effect.gen(function* () {
    const f = fixture();
    const execute = yield* f.execute;
    f.withdraw();
    const result = yield* execute({
      caller: f.caller,
      name: "session_question",
      arguments: { action: "list", sessionId: "other" },
    });
    assert.deepInclude(result.structuredContent, { error: { code: "call_withdrawn" } });
    assert.equal(f.calls.length, 0);
  }),
);

for (const runtimeMode of [undefined, "approval-required"] as const) {
  it.effect(
    `Agent-created Sessions ${runtimeMode ? "accept narrower modes" : "inherit the caller mode"}`,
    () =>
      Effect.gen(function* () {
        const f = fixture({ restricted: true });
        const execute = yield* f.execute;
        const result = yield* execute({
          caller: f.caller,
          name: "create_session",
          arguments: {
            prompt: "Build it",
            target: { type: "projectless" },
            ...(runtimeMode ? { runtimeMode } : {}),
          },
        });
        assert.isFalse(result.isError ?? false);
        const launched = f.calls.find((call) => call.name === "launch")!;
        assert.deepInclude(launched.input, {
          runtimeMode: "approval-required",
          modeLimit: { runtimeMode: "approval-required", interactionMode: "plan" },
        });
      }),
  );
}
