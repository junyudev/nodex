import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./AppToolOperation";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";

const authority: NodexAgentTurnContext = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "root",
  actorProjectId: null,
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 999,
};
const input: AppToolInvocation = {
  name: "send_message_to_session",
  arguments: {},
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};
it.effect("binds opaque UUID keys to canonical arguments across Turns and reports collisions", () =>
  Effect.gen(function* () {
    const fixture = createAppToolAdmissionFixture(123);
    const admit = yield* make.pipe(Effect.provideService(CoreModules, fixture.core));
    const idempotencyKey = "06d6709c-45e7-4b37-8c26-74e9d64c5aa1";
    const first = yield* admit(input, authority, "profile", {
      idempotencyKey,
      prompt: "Continue",
      sessionId: "target",
    });
    const later = yield* admit(
      { ...input, caller: { ...input.caller, turnId: "later", callId: "retry" } },
      { ...authority, turnId: "later", admittedAtMs: 5000 },
      "profile",
      { sessionId: "target", prompt: "Continue", idempotencyKey },
    );
    assert.deepStrictEqual(later, first);
    assert.strictEqual(fixture.records.size, 1);
    assert.isTrue(first.success);
    if (!first.success) return;
    assert.strictEqual(first.acceptedAtMs, 123);
    assert.notStrictEqual(first.operationId, idempotencyKey);
    const changed = yield* admit(input, authority, "profile", {
      idempotencyKey,
      prompt: "Different",
      sessionId: "target",
    });
    assert.isFalse(changed.success);
    if (changed.success) return;
    assert.deepStrictEqual(changed.result.structuredContent, {
      error: { code: "idempotency_key_reused" },
    });
  }),
);
it.effect("keeps omitted identities bound to the original call and host admission time", () =>
  Effect.gen(function* () {
    const fixture = createAppToolAdmissionFixture();
    const admit = yield* make.pipe(Effect.provideService(CoreModules, fixture.core));
    const first = yield* admit(input, authority, "profile", { prompt: "Continue" });
    assert.deepStrictEqual(first, {
      success: true,
      operationId: createStableOperationId("app.send_message_to_session", 999, [
        "profile",
        "thread",
        "turn",
        "call",
      ]),
      acceptedAtMs: 999,
      expiresAtMs: 999 + 7 * 24 * 60 * 60 * 1000,
    });
    assert.deepStrictEqual(
      yield* admit(input, authority, "profile", { prompt: "Continue" }),
      first,
    );
    const another = yield* admit(
      { ...input, caller: { ...input.caller, callId: "another" } },
      authority,
      "profile",
      { prompt: "Continue" },
    );
    assert.isTrue(another.success);
    if (!first.success || !another.success) return;
    assert.notStrictEqual(another.operationId, first.operationId);
    assert.strictEqual(fixture.records.size, 0);
  }),
);
