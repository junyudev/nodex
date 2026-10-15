import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import {
  captureAppToolAuthority,
  captureHostedAppToolAuthority,
  createHostedAppToolCaller,
  readHostedAppToolSessionContext,
} from "./AppToolCaller";

const authority: NodexAgentTurnContext = {
  threadId: "native",
  turnId: "turn:a",
  rootThreadId: "native",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
};

for (const backend of ["codex", "claude", "opencode", "acp"] as const) {
  it.effect(`${backend} Runtime callers require the original Host-issued object`, () =>
    Effect.gen(function* () {
      const frozen = { ...authority, threadId: "runtime:thread", turnId: "runtime-run:run" };
      let active = true;
      const sessionContext = {
        sessionId: "product-session",
        projectId: "project",
        runtimeId: "engine",
        rootThreadId: "root",
        threadId: "child",
        runId: "run",
        cwd: "/worktree",
      };
      const caller = createHostedAppToolCaller({
        backend,
        authority: frozen,
        callId: "call",
        generation: 1,
        isActive: () => active,
        capture: Effect.succeed(frozen),
        sessionContext,
      });
      sessionContext.sessionId = "mutated-product-session";
      assert.equal(caller.threadId, "runtime:thread");
      assert.equal(readHostedAppToolSessionContext(caller)?.sessionId, "product-session");
      assert.equal(readHostedAppToolSessionContext(caller)?.threadId, "child");
      assert.isTrue(Object.isFrozen(readHostedAppToolSessionContext(caller)));
      assert.isNull(readHostedAppToolSessionContext({ ...caller }));
      const legacy = { capture: () => Effect.die("Runtime authority cannot use legacy admission") };
      assert.deepEqual(yield* captureAppToolAuthority(caller, legacy), frozen);
      assert.isNull(yield* captureHostedAppToolAuthority({ ...caller }));
      assert.isNull(yield* captureAppToolAuthority({ ...caller }, legacy));
      active = false;
      assert.isNull(yield* captureHostedAppToolAuthority(caller));
      assert.isNull(readHostedAppToolSessionContext(caller));
    }),
  );
}

it.effect("withdrawn Runtime calls cannot retain authority across an awaited Core capture", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let active = true;
    const caller = createHostedAppToolCaller({
      backend: "codex",
      authority,
      callId: "call",
      generation: 1,
      isActive: () => active,
      capture: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
        Effect.as(authority),
      ),
    });
    const capture = yield* captureHostedAppToolAuthority(caller).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    active = false;
    yield* Deferred.succeed(resume, undefined);
    assert.isNull(yield* Fiber.join(capture));
  }).pipe(Effect.scoped),
);
