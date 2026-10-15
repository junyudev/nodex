import { assert, it } from "@effect/vitest";
import type { components } from "@nodex/core-protocol";
import type {
  AgentHostNativeSessionIdentity,
  AgentHostToolIdentity,
  AgentHostRequest,
  AgentRuntimeMethod,
  AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { MainConfig } from "../app/MainConfig";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import {
  captureHostedAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolCaller,
} from "../app-tools/AppToolCaller";
import { resolveAppToolCallingSession } from "../app-tools/AppToolCallingSession";
import { make } from "./AgentRuntimeHost";

const actor = (incarnationId = "incarnation:one"): AgentHostNativeSessionIdentity => ({
  source: "native-session",
  runtimeId: "runtime",
  runtimeGeneration: "lease",
  projectId: "former-project",
  threadId: "thread",
  runId: null,
  attemptId: null,
  providerInstanceId: "acp",
  providerSessionId: "provider-session",
  providerThreadId: "provider-thread",
  nativeGeneration: 1,
  nativeThreadRef: { driver: "acpRegistry", nativeId: "native-session", strength: "strong" },
  cwd: "/worktree",
  incarnationId,
});
const request = (identity: AgentHostToolIdentity = actor(), id = "request"): AgentHostRequest => ({
  type: "host.request",
  id,
  operation: "tool.call",
  tool: "get_session_context",
  input: {},
  identity,
});
type Admission = components["schemas"]["ProjectWorkspaceAgentRuntimeNativeSessionIdentity"];
const fixture = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
  const ended = yield* Deferred.make<never>();
  const retired = yield* Deferred.make<void>();
  const calls: AgentRuntimeMethod[] = [];
  const coreCalls: ProjectWorkspaceApplyInput[] = [];
  const records = new Map<string, { identity: Admission; active: boolean }>();
  let current: AgentHostNativeSessionIdentity | null = actor();
  let caller: AppToolCaller | undefined;
  let rootBound = true;
  const connection: AgentRuntimeProcessConnection = {
    identity: {
      runtimeId: "runtime",
      runtimeGeneration: "lease",
      schemaVersion: 1,
      databasePath: "/runtime.sqlite",
      mcpEndpoint: "http://localhost:1/mcp",
      lastSequence: 0,
    },
    terminated: Deferred.await(ended),
    notifications: Stream.fromPubSub(events),
    subscribeNotifications: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    request: <M extends AgentRuntimeMethod>(method: M, input: AgentRuntimeOperations[M]["input"]) =>
      Effect.sync(() => {
        calls.push(method);
        if (method === "execution.observe")
          return {
            subscriptionId: "lifecycle",
            afterSequence: 0,
            subscribed: true,
          } as AgentRuntimeOperations[M]["output"];
        if (method === "events.unobserve")
          return { unsubscribed: true } as AgentRuntimeOperations[M]["output"];
        if (method !== "native-session.authority")
          throw new Error(`Unexpected runtime request ${method}`);
        const coordinate = input as AgentRuntimeOperations["native-session.authority"]["input"];
        return (
          current && current.incarnationId === coordinate.incarnationId
            ? {
                ...current,
                rootThreadId: "thread",
                status: null,
                archived: false,
                nativeTurnId: null,
                branch: null,
                worktreePath: null,
                hasNativeBackgroundWork: false,
              }
            : null
        ) as AgentRuntimeOperations[M]["output"];
      }),
  };
  const read = (input: ProjectWorkspaceRead) =>
    Effect.sync(() => {
      if (input.kind === "agent_runtime_session_binding_by_execution")
        return {
          value: {
            kind: "agent_runtime_session_binding",
            binding: rootBound
              ? {
                  session_id: "session",
                  project_id: "current-project",
                  runtime_id: "runtime",
                  runtime_thread_id: "thread",
                  launch_request_id: "launch",
                  bound_at: "2026-10-14T00:00:00Z",
                }
              : null,
          },
        };
      if (input.kind !== "agent_runtime_native_session_authority")
        throw new Error(`Unexpected Core read ${input.kind}`);
      const record = records.get(input.identity.incarnation_id);
      return {
        value: {
          kind: input.kind,
          resolution: {
            persisted: Boolean(record),
            admitted_at_ms: record?.active ? 1 : null,
            authority: record?.active
              ? {
                  thread_id: "runtime:thread",
                  turn_id: `runtime-native-session:${record.identity.incarnation_id}`,
                  root_thread_id: "runtime:thread",
                  actor_project_id: "current-project",
                  library_id: "library",
                  store_epoch: "epoch",
                }
              : null,
          },
        },
      };
    });
  const apply = (input: ProjectWorkspaceApplyInput) =>
    Effect.gen(function* () {
      coreCalls.push(input);
      const intent = input.intent;
      if (intent.kind === "admit_agent_runtime_native_session_authority") {
        assert.equal(intent.session_id, "session");
        if (records.get(intent.identity.incarnation_id)?.active === false)
          return yield* Effect.fail(new Error("Retired incarnation"));
        records.set(intent.identity.incarnation_id, { identity: intent.identity, active: true });
      }
      if (intent.kind === "revoke_agent_runtime_native_session_authority") {
        const old = records.get(intent.identity.incarnation_id);
        if (old) old.active = false;
      }
      if (intent.kind === "revoke_agent_runtime_native_source_authorities") {
        for (const record of records.values()) {
          if (
            record.identity.provider_session_id === intent.native_source.provider_session_id &&
            record.identity.native_generation === intent.native_source.native_generation &&
            record.identity.lease_id === intent.lease_id
          )
            record.active = false;
        }
        yield* Deferred.succeed(retired, undefined);
      }
      if (intent.kind === "revoke_agent_runtime_authorities")
        for (const record of records.values()) record.active = false;
      return {};
    });
  const execute = yield* make(connection, {
    projectlessId: "projectless",
    providers: { acp: { driver: "acpRegistry", config: {} } },
    execute: (captured) => {
      caller = captured;
      return Effect.succeed({ content: [] });
    },
  }).pipe(
    Effect.provideService(CoreModules, { workspace: { read, apply } } as never),
    Effect.provideService(CoreAuthority, {
      identity: { profileId: "profile", libraryId: "library", storeEpoch: "epoch" },
    } as never),
    Effect.provideService(MainConfig, {} as never),
  );
  return {
    execute,
    calls,
    coreCalls,
    records,
    caller: () => caller!,
    unbind: () => {
      rootBound = false;
    },
    replace: (value: AgentHostNativeSessionIdentity | null) => {
      current = value;
    },
    events,
    retired,
  };
});

it.effect("ACP Host calls admit the bound Session without reading or inventing a Run", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.execute(request());
    assert.deepEqual(readHostedAppToolSessionContext(f.caller()), {
      sessionId: "session",
      projectId: "current-project",
      runtimeId: "runtime",
      rootThreadId: "thread",
      threadId: "thread",
      runId: null,
      cwd: "/worktree",
    });
    const calling = yield* resolveAppToolCallingSession(f.caller(), {
      getThread: () => Effect.die("Legacy Thread lookup"),
    });
    assert.equal(calling?.sessionId, "session");
    assert.isNull(calling?.runId);
    assert.notInclude(f.calls, "thread.authority");
    assert.notInclude(f.calls, "thread.snapshot");
    assert.isNotNull(yield* captureHostedAppToolAuthority(f.caller()));
    f.replace(actor("incarnation:next"));
    assert.isNull(yield* captureHostedAppToolAuthority(f.caller()));
    yield* Effect.flip(f.execute(request()));
    yield* f.execute(request(actor("incarnation:next")));
    assert.isNotNull(yield* captureHostedAppToolAuthority(f.caller()));
  }).pipe(Effect.scoped),
);

it.effect("an unbound engine native Session cannot acquire product content credentials", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.unbind();
    yield* Effect.flip(f.execute(request()));
    assert.equal(
      f.coreCalls.filter(
        (input) => input.intent.kind === "admit_agent_runtime_native_session_authority",
      ).length,
      0,
    );
    assert.equal(f.records.size, 0);
  }).pipe(Effect.scoped),
);

it.effect(
  "physical source retirement permanently fences Core capture even if an old proof reappears",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.execute(request());
      const old = f.caller();
      yield* PubSub.publish(f.events, {
        delivery: 1,
        notification: {
          type: "execution.native-session.closed",
          runtimeId: "runtime",
          runtimeGeneration: "lease",
          providerSessionId: "provider-session",
          nativeGeneration: 1,
          incarnationId: "incarnation:one",
        },
      });
      yield* Deferred.await(f.retired).pipe(Effect.timeout("2 seconds"));
      assert.isNull(yield* captureHostedAppToolAuthority(old));
      yield* Effect.flip(f.execute(request()));
      f.replace(actor("incarnation:next"));
      yield* f.execute(request(actor("incarnation:next")));
      assert.isNotNull(yield* captureHostedAppToolAuthority(f.caller()));
    }).pipe(Effect.scoped),
);

it.effect(
  "native call registration keys identify retries while SDK call IDs alone never deduplicate commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = { ...actor(), nativeCallId: "tool-use", nativeCallKey: "captured-source-key" };
      yield* f.execute(request(native, "transport:one"));
      assert.equal(f.caller().callId, JSON.stringify(["native", "captured-source-key", null]));
      yield* f.execute(request(native, "transport:retry"));
      assert.equal(f.caller().callId, JSON.stringify(["native", "captured-source-key", null]));
      yield* f.execute(request({ ...native, mcpRequestId: "nested-one" }));
      const nestedFirst = f.caller().callId;
      yield* f.execute(request({ ...native, mcpRequestId: "nested-one" }));
      assert.equal(f.caller().callId, nestedFirst);
      yield* f.execute(request({ ...native, mcpRequestId: "nested-two" }));
      assert.notEqual(f.caller().callId, nestedFirst);
      yield* f.execute(
        request(
          { ...actor(), nativeCallId: "same-sdk-id", mcpClientId: 7, mcpRequestId: "rpc-id" },
          "transport:three",
        ),
      );
      const first = f.caller().callId;
      yield* f.execute(
        request(
          { ...actor(), nativeCallId: "same-sdk-id", mcpClientId: 7, mcpRequestId: "rpc-id" },
          "transport:four",
        ),
      );
      assert.equal(f.caller().callId, first);
      yield* f.execute(
        request({
          ...actor(),
          nativeCallId: "same-sdk-id",
          mcpClientId: 8,
          mcpRequestId: "rpc-id",
        }),
      );
      assert.notEqual(f.caller().callId, first);
      assert.equal(
        f.coreCalls.filter(
          (input) => input.intent.kind === "admit_agent_runtime_native_session_authority",
        ).length,
        1,
      );
    }).pipe(Effect.scoped),
);
