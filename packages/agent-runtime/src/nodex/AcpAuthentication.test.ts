import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeAuthenticationProjection } from "./AcpAuthentication.ts";

it.effect("projects real controller changes while keeping repeated and redacted reads stable", () =>
  Effect.gen(function* () {
    const context = yield* Deferred.make<ProviderAuthFlow.ProviderAuthFlowContext>();
    const controller = yield* ProviderAuthFlow.make({
      instanceId: ProviderInstanceId.make("agent"),
      credentialBinding: { owner: "provider", claims: ["test"] },
      methods: Effect.succeed([
        { id: "terminal", name: "Terminal", description: null, type: "terminal" as const },
      ]),
      discoverMethodsOnCreate: false,
      authenticate: (_, current) =>
        Effect.gen(function* () {
          yield* current.setInteraction({
            type: "terminal",
            id: "terminal",
            output: "Code: ",
            outputOffset: 0,
          });
          yield* Deferred.succeed(context, current);
          yield* Effect.never;
        }),
      logout: Effect.void,
    });
    const read = (owner: string) =>
      controller.subscribe(owner).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    const projection = makeAuthenticationProjection("runtime-one");
    const finish = projection.begin(controller, 7);
    const started = yield* controller.start("A");
    const current = yield* Deferred.await(context);
    const state = yield* read("A");
    const waiting = projection.project(controller, 99, state);
    finish();
    expect(waiting).toMatchObject({
      runtimeGeneration: "runtime-one",
      configurationRevision: 7,
      cancellable: true,
    });
    expect(waiting.flowId).toBe(started.flowId);
    const other = projection.project(controller, 99, yield* read("B"));
    expect(other).toMatchObject({
      flowId: null,
      interaction: null,
      cancellable: false,
      configurationRevision: 7,
    });
    expect(projection.project(controller, 99, yield* read("A"))).toEqual(waiting);
    expect(projection.project(controller, 99, yield* controller.start("A"))).toEqual(waiting);
    yield* current.setInteraction({
      type: "terminal",
      id: "terminal",
      output: "Code: 123",
      outputOffset: 0,
    });
    const output = projection.project(controller, 99, yield* read("A"));
    expect(output.revision).toBeGreaterThan(waiting.revision);
    expect(output.configurationRevision).toBe(7);
    yield* current.verifying;
    const verifying = projection.project(controller, 99, yield* read("A"));
    expect(verifying.revision).toBeGreaterThan(output.revision);
    const cancelledState = yield* controller.cancel("A", started.flowId!);
    const cancelled = projection.project(controller, 99, cancelledState);
    expect(cancelled).toMatchObject({
      phase: "cancelled",
      cancellable: false,
      configurationRevision: 7,
    });
    expect(cancelled.revision).toBeGreaterThan(verifying.revision);
    const finishNext = projection.begin(controller, 11);
    const nextState = yield* controller.start("A");
    const next = projection.project(controller, 99, nextState);
    finishNext();
    expect(next.flowId).not.toBe(started.flowId);
    expect(next.configurationRevision).toBe(11);
    projection.project(controller, 7, cancelledState);
    expect(projection.project(controller, 99, nextState)).toEqual(next);
    yield* controller.cancel("A", nextState.flowId!);
    const fresh = makeAuthenticationProjection("runtime-two").project(controller, 12, nextState);
    expect(fresh.runtimeGeneration).not.toBe(next.runtimeGeneration);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("bounds remembered flow identities and keeps controller lifetimes separate", () => {
  const projection = makeAuthenticationProjection("runtime");
  const controller = {};
  const state: ProviderAuthState = {
    instanceId: ProviderInstanceId.make("agent"),
    phase: "cancelled",
    flowId: "old",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    interaction: null,
  };
  const first = projection.project(controller, 1, state);
  for (let index = 0; index < 65; index++) {
    const finish = projection.begin(controller, index + 2);
    projection.project(controller, index + 2, { ...state, flowId: String(index) });
    finish();
  }
  const reread = projection.project(controller, 100, state);
  expect(reread.revision).toBeGreaterThan(first.revision);
  expect(reread.configurationRevision).toBe(100);
  expect(projection.project({}, 101, state).configurationRevision).toBe(101);
});
