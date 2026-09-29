import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { captureAppToolAuthority, createNativeAppToolClaimIssuer } from "./AppToolCaller";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "native",
  turnId: "turn:a",
  rootThreadId: "native",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  readOnly: false,
  scope: "project",
  source: "project_turn",
};

it.effect(
  "native authority requires a host-issued object and the exact current accepted lifetime",
  () =>
    Effect.gen(function* () {
      let coreCurrent = true;
      let captures = 0;
      const issuer = createNativeAppToolClaimIssuer({
        threadId: "native",
        hostId: "local",
        generation: 4,
        capture: () =>
          Effect.sync(() => {
            captures += 1;
            return coreCurrent;
          }),
      });
      const codex = { capture: () => Effect.die("Native callers must not enter Codex admission") };
      assert.isNull(issuer.claim());
      assert.isFalse(issuer.beginTurn({ ...authority, threadId: "forged" }));
      assert.isTrue(issuer.beginTurn(authority));
      const caller = issuer.claim()!;
      assert.deepEqual(yield* captureAppToolAuthority(caller, codex), authority);
      assert.isNull(yield* captureAppToolAuthority({ ...caller }, codex));
      coreCurrent = false;
      assert.isNull(yield* captureAppToolAuthority(caller, codex));
      coreCurrent = true;
      issuer.endTurn("wrong-turn");
      assert.isTrue(caller.isActive());
      issuer.endTurn(authority.turnId);
      assert.isFalse(caller.isActive());
      assert.isTrue(issuer.beginTurn({ ...authority, turnId: "turn:b" }));
      assert.isNull(yield* captureAppToolAuthority(caller, codex));
      const next = issuer.claim()!;
      issuer.close();
      assert.isFalse(next.isActive());
      assert.isNull(issuer.claim());
      assert.equal(captures, 2);
    }),
);

it.effect("different native queries cannot share caller credentials or frozen coordinates", () =>
  Effect.sync(() => {
    const makeIssuer = (threadId: string) =>
      createNativeAppToolClaimIssuer({
        threadId,
        hostId: "local",
        generation: 1,
        capture: () => Effect.succeed(true),
      });
    const first = makeIssuer("native");
    const second = makeIssuer("other");
    assert.isTrue(first.beginTurn(authority));
    assert.isFalse(second.beginTurn(authority));
    assert.isTrue(second.beginTurn({ ...authority, threadId: "other", rootThreadId: "other" }));
    const firstCall = first.claim()!;
    const otherCall = second.claim()!;
    first.close();
    assert.isFalse(firstCall.isActive());
    assert.isTrue(otherCall.isActive());
    assert.notEqual(firstCall.callId, otherCall.callId);
  }),
);

it.effect("background activity suspends every native claim without reviving old credentials", () =>
  Effect.gen(function* () {
    const issuer = createNativeAppToolClaimIssuer({
      threadId: "native",
      hostId: "local",
      generation: 1,
      capture: () => Effect.succeed(true),
    });
    const codex = { capture: () => Effect.die("No Codex authority") };
    issuer.beginTurn(authority);
    const first = issuer.claim()!;
    issuer.setBackgroundTasks(["child:a"]);
    assert.isFalse(first.isActive());
    assert.isNull(issuer.claim());
    issuer.endTurn(authority.turnId);
    issuer.beginTurn({ ...authority, turnId: "next-turn" });
    assert.isNull(issuer.claim());
    issuer.setBackgroundTasks([]);
    assert.isNull(yield* captureAppToolAuthority(first, codex));
    const next = issuer.claim()!;
    assert.equal(next.turnId, "next-turn");
    issuer.setBackgroundTasks(["ambient-watcher"]);
    assert.isFalse(next.isActive());
    issuer.endTurn("next-turn");
    issuer.setBackgroundTasks([]);
    assert.isNull(issuer.claim());
  }),
);
