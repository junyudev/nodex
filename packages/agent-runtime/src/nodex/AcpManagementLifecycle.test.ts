import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { withCurrentAcpInstance } from "./AcpManagementLifecycle.ts";

const instanceId = ProviderInstanceId.make("managed-agent");
const driverKind = ProviderDriverKind.make("acpRegistry");
const instance = (): ProviderInstance => ({
  instanceId,
  driverKind,
  continuationIdentity: { driverKind, continuationKey: instanceId },
  displayName: undefined,
  enabled: true,
  get snapshot(): never {
    throw new Error("A lifecycle guard must not refresh discovery.");
  },
  get orchestrationAdapter(): never {
    throw new Error("A lifecycle guard must not start execution.");
  },
  get textGeneration(): never {
    throw new Error("A lifecycle guard must not generate text.");
  },
});

const fixture = Effect.gen(function* () {
  const captured = instance();
  const current = yield* Ref.make<ProviderInstance | undefined>(captured);
  const changes = yield* PubSub.unbounded<void>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  return {
    captured,
    registry: {
      getInstance: () => Ref.get(current),
      subscribeChanges: PubSub.subscribe(changes),
    },
    replace: (replacement: ProviderInstance) =>
      Ref.set(current, replacement).pipe(Effect.andThen(PubSub.publish(changes, undefined))),
    notify: PubSub.publish(changes, undefined),
  };
});

it.effect("refuses an already replaced instance before its old Connect can run", () =>
  Effect.gen(function* () {
    const { captured, registry, replace } = yield* fixture;
    const oldConnects = yield* Ref.make(0);
    yield* replace(instance());
    const result = yield* withCurrentAcpInstance(
      registry,
      captured,
      Ref.update(oldConnects, (count) => count + 1),
    ).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* Ref.get(oldConnects)).toBe(0);
    if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid_request");
  }),
);

it.effect("ignores unrelated changes and drains current work when its instance is replaced", () =>
  Effect.gen(function* () {
    const { captured, registry, replace, notify } = yield* fixture;
    const connected = yield* Deferred.make<void>();
    const released = yield* Ref.make(false);
    const running = yield* withCurrentAcpInstance(
      registry,
      captured,
      Deferred.succeed(connected, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(released, true)),
      ),
    ).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(connected);
    yield* notify;
    yield* Effect.yieldNow;
    expect(yield* Ref.get(released)).toBe(false);
    yield* replace(instance());
    const result = yield* Fiber.join(running);
    expect(result._tag).toBe("Failure");
    expect(yield* Ref.get(released)).toBe(true);
  }),
);
