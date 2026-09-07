import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./HandoffStatusAppTools";

const input: AppToolInvocation = {
  name: "get_handoff_status",
  arguments: {
    sessionId: "target",
    operationId: createStableOperationId("app.handoff_session", 1, ["test"]),
    afterRevision: 2,
    waitMs: 60_000,
  },
  caller: {
    threadId: "caller",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};
const setup = (
  options: {
    denied?: boolean;
    changed?: boolean;
    wrongOperation?: boolean;
    withdrawn?: boolean;
  } = {},
) => {
  let reads = 0;
  const waits: unknown[][] = [];
  let active = true;
  const operation = {
    sourceThreadId: options.wrongOperation ? "unrelated" : "target-thread",
    revision: 3,
    status: "success",
  };
  return {
    waits,
    call: { ...input, caller: { ...input.caller, isActive: () => active } },
    execute: make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CodexTurnAuthority, {
        capture: () =>
          Effect.succeed({
            threadId: "caller",
            turnId: "turn",
            rootThreadId: "caller",
            actorProjectId: "project",
            libraryId: "library",
            storeEpoch: "epoch",
            frozenAtMs: 1,
            readOnly: true,
            scope: "project",
            source: "project_turn",
          }),
      } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          read: () =>
            Effect.sync(() => {
              reads += 1;
              return {
                value: {
                  kind: "agent_session",
                  thread:
                    options.denied || (options.changed && reads > 1)
                      ? null
                      : { thread_id: "target-thread", backend_binding: { kind: "codex" } },
                },
              };
            }),
        },
      } as never),
      Effect.provideService(CodexThreadHandoffRuntime, {
        get: () => Effect.succeed(operation),
        waitForRevision: (...args: unknown[]) =>
          Effect.sync(() => {
            waits.push(args);
            if (options.withdrawn) active = false;
            return operation;
          }),
      } as never),
    ),
  };
};

it.effect("allows a read-only Turn to wait on its authorized Session operation", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    const result = yield* execute(fixture.call);
    assert.deepNestedInclude(result.structuredContent, {
      sessionId: "target",
      "operation.status": "success",
      "operation.revision": 3,
    });
    assert.deepEqual(fixture.waits, [[input.arguments.operationId, 2, 60_000]]);
  }),
);

it.effect(
  "withholds results for unauthorized Sessions, unrelated operations, changed bindings and withdrawn calls",
  () =>
    Effect.gen(function* () {
      for (const options of [
        { denied: true },
        { wrongOperation: true },
        { changed: true },
        { withdrawn: true },
      ]) {
        const fixture = setup(options);
        const execute = yield* fixture.execute;
        assert.isTrue((yield* execute(fixture.call)).isError);
        assert.lengthOf(fixture.waits, options.denied || options.wrongOperation ? 0 : 1);
      }
      const fixture = setup();
      const execute = yield* fixture.execute;
      assert.isTrue(
        (yield* execute({ ...fixture.call, arguments: { ...input.arguments, waitMs: 60_001 } }))
          .isError,
      );
      assert.lengthOf(fixture.waits, 0);
    }),
);
