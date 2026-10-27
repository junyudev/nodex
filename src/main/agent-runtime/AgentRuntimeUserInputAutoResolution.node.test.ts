import { assert, it } from "@effect/vitest";
import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  CodexRendererPresentationRegistry,
  make as makePresentation,
} from "../codex-application/CodexRendererPresentationRegistry";
import {
  CodexUserInputAutoResolution,
  make as makeDeadlines,
} from "../codex-application/CodexUserInputAutoResolution";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";
import { make } from "./AgentRuntimeUserInputAutoResolution";

type Request = AgentSnapshot["projection"]["runtimeRequests"][number];
const question = (id: string, overrides: Partial<Request> = {}): Request => ({
  id,
  nodeId: `node:${id}`,
  providerTurnId: "provider-turn",
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "live", providerSessionId: "native-session" },
  createdAt: "2026-10-27T00:00:00.000Z",
  resolvedAt: null,
  isBlocking: false,
  ...overrides,
});

const fixture = Effect.fn("RuntimeQuestionDeadlineTest.fixture")(function* (
  initial: readonly Request[],
  foreground = false,
) {
  const presentation = yield* makePresentation;
  presentation.setClientForegrounded("window", foreground);
  presentation.setPresented("root", "window", "surface", true);
  const deadlines = yield* makeDeadlines.pipe(
    Effect.provideService(CodexRendererPresentationRegistry, presentation),
  );
  const transitions = yield* PubSub.unbounded<AgentRuntimeActivityTransition>();
  const bridge = yield* make({ transitions: Stream.fromPubSub(transitions) }).pipe(
    Effect.provideService(CodexUserInputAutoResolution, deadlines),
  );
  let pending = initial;
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const connection: AgentRuntimeProcessConnection = {
    identity: {
      runtimeId: "runtime",
      runtimeGeneration: "generation",
      schemaVersion: 1,
      databasePath: "/unused/runtime.sqlite",
      mcpEndpoint: "http://localhost:1/mcp",
      lastSequence: 0,
    },
    terminated: Effect.never,
    notifications: Stream.never,
    subscribeNotifications: Effect.succeed(Stream.never),
    subscribeExecutionNotifications: Effect.succeed(Stream.never),
    request: ((method: string, input: unknown) =>
      Effect.sync(() => {
        calls.push({ method, input });
        if (method === "thread.control")
          return { projection: { runtimeRequests: pending }, snapshotSequence: 0 };
        if (method === "command.dispatch") return { sequence: 1 };
        if (method !== "execution.activity") throw new Error(`Unexpected method ${method}`);
        return {
          snapshotSequence: 0,
          items: [{ rootThreadId: "root", pendingRequestCount: pending.length }],
          nextCursor: null,
        };
      })) as AgentRuntimeProcessConnection["request"],
  };
  const generationScope = yield* Scope.make();
  yield* bridge.attach(connection).pipe(Effect.provideService(Scope.Scope, generationScope));
  const retire = () => {
    pending = [];
    return PubSub.publish(transitions, {
      connection,
      rootThreadId: "root",
      sessionId: "session",
      before: null,
      after: null,
      endedRun: null,
    });
  };
  return {
    calls,
    deadlines,
    retire,
    close: Scope.close(generationScope, Exit.void),
    dispatched: () => calls.filter(({ method }) => method === "command.dispatch"),
  };
});

it.effect("resolves only live nonblocking questions through their original Runtime", () =>
  Effect.gen(function* () {
    const f = yield* fixture([
      question("optional"),
      question("blocking", { isBlocking: true }),
      question("async", { responseCapability: { type: "message" } }),
    ]);
    assert.strictEqual((yield* f.deadlines.snapshot)[0]?.requestId, "optional");
    yield* TestClock.adjust("90 seconds");
    assert.deepEqual(f.dispatched(), [
      {
        method: "command.dispatch",
        input: {
          command: {
            type: "runtime-request.respond",
            commandId: "auto-user-input:optional",
            threadId: "root",
            requestId: "optional",
            answers: {},
          },
        },
      },
    ]);
    assert.deepEqual(f.calls.filter(({ method }) => method === "thread.control").at(-1), {
      method: "thread.control",
      input: { threadId: "root", requestId: "optional" },
    });
    assert.isTrue(
      f.calls.every(({ method }) =>
        ["execution.activity", "thread.control", "command.dispatch"].includes(method),
      ),
    );
    yield* f.close;
  }),
);

it.effect("uses foreground inactivity and the shared question-interaction snooze", () =>
  Effect.gen(function* () {
    const f = yield* fixture([question("optional")], true);
    assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "waitingForInactivity");
    yield* TestClock.adjust("59 seconds");
    yield* f.deadlines.recordActivity({ hostId: "local", conversationId: "root" });
    yield* TestClock.adjust("59 seconds");
    assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "waitingForInactivity");
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "scheduled");
    assert.isTrue(
      yield* f.deadlines.snooze({ hostId: "local", conversationId: "root", requestId: "optional" }),
    );
    yield* TestClock.adjust("5 minutes");
    assert.isEmpty(f.dispatched());
    assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "snoozed");
    yield* f.close;
  }),
);

it.effect("retires deadlines with the request or its process generation", () =>
  Effect.gen(function* () {
    const retired = yield* fixture([question("retired")]);
    yield* retired.retire();
    yield* Effect.yieldNow;
    assert.isEmpty(yield* retired.deadlines.snapshot);
    yield* TestClock.adjust("90 seconds");
    assert.isEmpty(retired.dispatched());
    yield* retired.close;

    const disconnected = yield* fixture([question("disconnected")]);
    yield* disconnected.close;
    assert.isEmpty(yield* disconnected.deadlines.snapshot);
    yield* TestClock.adjust("90 seconds");
    assert.isEmpty(disconnected.dispatched());
  }),
);
