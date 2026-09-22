/* oxlint-disable effecttsgo/strict-effect-provide -- The scoped test provides the real callback runtime at its entry point. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { produce, type Draft } from "immer";
import { make } from "./CodexMainConversationInterrupt";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { layer as callbacks } from "../app/ScopedCallbackRuntime";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexNodeReplRuntime } from "./CodexNodeReplRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";

const harness = Effect.gen(function* () {
  let state = produce(
    conversationFixture("thread", [turnFixture("active", "inProgress")]),
    (draft) => {
      draft.threadGoal = {
        threadId: "thread",
        objective: "finish",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
      };
    },
  );
  const calls: string[] = [];
  const control = {
    generation: 1,
    role: { role: "owner" } as ConversationStreamRole,
    failPause: true,
    afterRequest: (_method: string) => {},
  };
  const originalEntity = {
    readCanonicalState: () => state,
    readServerRequests: () => [],
    mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => {
      state = produce(state, recipe);
    },
  };
  let entity = originalEntity;
  const manager = {
    hostId: "local",
    get generation() {
      return control.generation;
    },
    assertCurrent: (expected = control.generation) => {
      if (expected !== control.generation) throw new Error("Connection changed");
    },
    stream: { getRole: () => control.role },
  } as unknown as MainConversationManager;
  const service = yield* make.pipe(
    Effect.provideService(CodexMainConversationManagers, {
      get: () => Effect.succeed(manager),
    } as unknown as CodexMainConversationManagers["Service"]),
    Effect.provideService(ConversationEntityMap, {
      current: () => entity,
    } as unknown as ConversationEntityMap["Service"]),
    Effect.provideService(CodexGateway, {
      requestOnHost: (
        _host: string,
        method: string,
        _params: unknown,
        options: { priority?: string; timeoutMs?: number },
      ) =>
        Effect.suspend(() => {
          calls.push(method);
          control.afterRequest(method);
          if (method !== "thread/goal/set") return Effect.succeed({});
          if (!control.failPause)
            return Effect.succeed({ goal: { ...state.threadGoal, status: "paused" } });
          if (options.priority === "critical") assert.strictEqual(options.timeoutMs, 500);
          return Effect.fail(
            new CodexRuntimeError({
              operation: "goal",
              reason: "request",
              retryable: false,
              message: "pause failed",
            }),
          );
        }),
    } as unknown as CodexGateway["Service"]),
    Effect.provideService(
      CodexServerRequestResponses,
      {} as CodexServerRequestResponses["Service"],
    ),
    Effect.provideService(CodexSubagentDirectory, {
      settleInterruptedSubtree: () =>
        Effect.sync(() => {
          calls.push("descendants");
        }),
    } as unknown as CodexSubagentDirectory["Service"]),
    Effect.provideService(CodexNodeReplRuntime, {
      cleanupForOwner: () => Effect.die("Owner cleanup must use the admitted interrupt path"),
      cleanup: () =>
        Effect.sync(() => {
          calls.push("repl");
        }),
    }),
    Effect.provideService(CodexApplicationEventHub, {
      publish: () => {
        calls.push("started");
      },
    } as unknown as CodexApplicationEventHub["Service"]),
  );
  return {
    service,
    calls,
    control,
    read: () => state,
    replaceEntity: () => {
      entity = { ...originalEntity };
    },
  };
});

it.effect("expected-turn interrupt skips active goal pause and rejects stale expectations", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    assert.deepEqual(yield* f.service.interrupt("local", "thread", "user-stop", "other"), {
      interruptedTurnId: null,
    });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(
      yield* f.service.interrupt("local", "thread", "descendant-cleanup", "active"),
      { interruptedTurnId: "active" },
    );
    assert.deepEqual(f.calls, ["turn/interrupt", "started", "repl"]);
  }).pipe(Effect.provide(callbacks)),
);

it.effect("user stop still interrupts when critical goal pause fails", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const result = yield* f.service.interrupt("local", "thread", "user-stop");
    assert.deepEqual(result, {
      interruptedTurnId: "active",
      goalPauseError: "Failed to pause thread goal",
    });
    assert.strictEqual(f.calls[0], "thread/goal/set");
    assert.ok(f.calls.includes("turn/interrupt"));
  }).pipe(Effect.provide(callbacks)),
);

it.effect("system pause failure still runs the outer descendant cleanup", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const result = yield* f.service.interrupt("local", "thread", "system").pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(f.calls, ["thread/goal/set", "descendants"]);
  }).pipe(Effect.provide(callbacks)),
);

for (const boundary of ["thread/goal/set", "turn/interrupt"] as const) {
  it.effect.each(["entity", "owner", "connection"] as const)(
    `rejects retired %s completion after ${boundary} without mutating or cleaning a successor`,
    (retired) =>
      Effect.gen(function* () {
        const f = yield* harness;
        f.control.failPause = false;
        f.control.afterRequest = (method) => {
          if (method !== boundary) return;
          if (retired === "entity") f.replaceEntity();
          if (retired === "owner") f.control.role = { role: "owner" } as ConversationStreamRole;
          if (retired === "connection") f.control.generation++;
        };
        const result = yield* f.service
          .interrupt(
            "local",
            "thread",
            "system",
            boundary === "turn/interrupt" ? "active" : undefined,
          )
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(f.read().threadGoal?.status, "active");
        assert.strictEqual(f.read().turns[0]?.status, "inProgress");
        assert.deepEqual(f.calls, [boundary]);
      }).pipe(Effect.provide(callbacks)),
  );
}

it.effect("pauses an active resident child Goal after descendant interruption", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    f.control.failPause = false;
    const result = yield* f.service.interrupt("local", "thread", "descendant-cleanup");
    assert.strictEqual(result.interruptedTurnId, "active");
    assert.strictEqual(f.read().threadGoal?.status, "paused");
    assert.isTrue(f.calls.indexOf("turn/interrupt") < f.calls.indexOf("thread/goal/set"));
    assert.notInclude(f.calls, "descendants");
  }).pipe(Effect.provide(callbacks)),
);

it.effect("keeps an accepted child stop successful if its Goal pause fails", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const result = yield* f.service.interrupt("local", "thread", "descendant-cleanup");
    assert.strictEqual(result.interruptedTurnId, "active");
    assert.strictEqual(f.read().threadGoal?.status, "active");
    assert.isTrue(f.calls.indexOf("turn/interrupt") < f.calls.indexOf("thread/goal/set"));
    assert.notInclude(f.calls, "descendants");
  }).pipe(Effect.provide(callbacks)),
);
