import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { makeWithPorts } from "./ProviderConfiguration.ts";

it.effect(
  "updates idle instances while preserving active and native background configuration",
  () =>
    Effect.gen(function* () {
      const active = ProviderInstanceId.make("active");
      const idle = ProviderInstanceId.make("idle");
      const background = ProviderInstanceId.make("background");
      const entry = (binaryPath: string) => ({
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath },
      });
      const initial = {
        [active]: entry("old-active"),
        [idle]: entry("old-idle"),
        [background]: entry("old-background"),
      };
      const busy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set([active, background]));
      const nativeMap = yield* Ref.make<ProviderInstanceConfigMap>(initial);
      const closed: string[] = [];
      const configuration = yield* makeWithPorts(initial, {
        busyInstances: Ref.get(busy),
        closeIdleInstance: (id) =>
          Effect.sync(() => {
            closed.push(id);
          }),
        reconcile: (next) => Ref.set(nativeMap, next),
      });
      const wanted = { [active]: entry("new-active"), [idle]: entry("new-idle") };
      expect(yield* configuration.configure(wanted)).toEqual({
        applied: false,
        deferredInstanceIds: [active, background],
      });
      expect(closed).toEqual([idle]);
      expect(yield* Ref.get(nativeMap)).toEqual({ ...initial, [idle]: wanted[idle] });
      const latest = { ...wanted, [active]: entry("latest-active") };
      yield* configuration.configure(latest);
      expect(closed).toEqual([idle]);
      // Foreground completion alone does not retire the native background instance.
      yield* Ref.set(busy, new Set([background]));
      yield* TestClock.adjust("1 second");
      expect(closed).toEqual([idle, active]);
      expect((yield* Ref.get(nativeMap))[active]).toEqual(latest[active]);
      expect((yield* Ref.get(nativeMap))[background]).toEqual(initial[background]);
      yield* Ref.set(busy, new Set());
      yield* TestClock.adjust("1 second");
      expect(closed).toEqual([idle, active, background]);
      expect(yield* Ref.get(nativeMap)).toEqual(latest);
      expect(yield* configuration.configure(latest)).toEqual({
        applied: true,
        deferredInstanceIds: [],
      });
      expect(closed).toEqual([idle, active, background]);
    }),
);
