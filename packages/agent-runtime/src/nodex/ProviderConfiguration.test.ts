import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProjectId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { effectiveSettings, makePolicy, makeWithPorts } from "./ProviderConfiguration.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect("revisions describe applied configuration, including deferred admission changes", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("acp-revision");
    const initial = {
      [id]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        config: { source: "local", commandPath: "/agent" },
      },
    };
    const policy = yield* makePolicy(initial);
    const busy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set([id]));
    const configuration = yield* makeWithPorts(initial, {
      busyInstances: Ref.get(busy),
      closeIdleInstance: () => Effect.void,
      reconcile: policy.replace,
      admission: policy.setDesired,
    });
    const captured = yield* policy.snapshot;
    expect(captured.revision).toBe(1);
    const desired = { [id]: { ...initial[id]!, enabled: false } };
    yield* configuration.configure(desired);
    expect(yield* policy.snapshot).toEqual(captured);
    expect(yield* policy.desired).toEqual(desired);
    yield* Ref.set(busy, new Set());
    yield* TestClock.adjust("1 second");
    expect(yield* policy.snapshot).toEqual({ config: desired, revision: 2 });
    yield* policy.replace({ ...desired });
    expect((yield* policy.snapshot).revision).toBe(2);
    expect(captured).toEqual({ config: initial, revision: 1 });
  }),
);

it.effect(
  "disabling stops new admission immediately while native configuration remains captured",
  () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("claude_named");
      const projectId = ProjectId.make("project");
      const initial = {
        [id]: {
          driver: ProviderDriverKind.make("claude-code"),
          enabled: true,
          config: { binaryPath: "private-cli", env: { PRIVATE_TOKEN: "private-value" } },
        },
      };
      const policy = yield* makePolicy(initial);
      const stored = yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(ServerSettings.layerTest()),
      );
      const settings = effectiveSettings(stored, policy);
      yield* stored.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [id]: { enabled: true } } },
        },
      });
      const busy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set([id]));
      const configuration = yield* makeWithPorts(initial, {
        busyInstances: Ref.get(busy),
        closeIdleInstance: () => Effect.void,
        reconcile: policy.replace,
        admission: policy.setDesired,
      });
      expect(
        resolveProjectProviderInstanceEnabled(yield* settings.getSettings, projectId, id),
      ).toBe(true);
      expect((yield* stored.getSettings).providerInstances[id]).toBeUndefined();
      expect(yield* configuration.configure({ [id]: { ...initial[id]!, enabled: false } })).toEqual(
        { applied: false, deferredInstanceIds: [id] },
      );
      expect(
        resolveProjectProviderInstanceEnabled(yield* settings.getSettings, projectId, id),
      ).toBe(false);
      yield* Ref.set(busy, new Set());
      yield* TestClock.adjust("1 second");
      expect(
        resolveProjectProviderInstanceEnabled(yield* settings.getSettings, projectId, id),
      ).toBe(false);
      expect(
        yield* settings.withSettingsSnapshot((snapshot) =>
          Effect.succeed(snapshot.providerInstances[id]?.enabled),
        ),
      ).toBe(false);
      expect((yield* stored.getSettings).providerInstances[id]).toBeUndefined();
    }),
);

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

it.effect(
  "suspends idle probes during a snapshot and restores them only while the process remains open",
  () =>
    Effect.gen(function* () {
      const initial = {
        codex: { driver: ProviderDriverKind.make("codex"), config: { binaryPath: "codex" } },
      };
      const changes: ProviderInstanceConfigMap[] = [];
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
      const configuration = yield* makeWithPorts(initial, {
        busyInstances: Effect.succeed(new Set()),
        closeIdleInstance: () => Effect.void,
        reconcile: (map) =>
          Effect.sync(() => {
            changes.push(map);
          }),
      }).pipe(Effect.provideService(Scope.Scope, owner));
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const holder = yield* configuration
        .withSuspended(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkIn(owner));
      yield* Deferred.await(entered);
      expect(changes).toEqual([{}]);
      const configuring = yield* configuration.configure(initial).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(configuring.pollUnsafe()).toBeUndefined();
      expect(changes).toEqual([{}]);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(configuring);
      expect(changes).toEqual([{}, initial]);
      const closedEntered = yield* Deferred.make<void>();
      yield* configuration
        .withSuspended(
          Deferred.succeed(closedEntered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkIn(owner));
      yield* Deferred.await(closedEntered);
      yield* Scope.close(owner, Exit.void);
      expect(changes).toEqual([{}, initial, {}]);
    }),
);

it.effect("refuses both provider settings write paths without persisting secrets", () =>
  Effect.gen(function* () {
    const policy = yield* makePolicy({});
    const stored = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provide(ServerSettings.layerTest()),
    );
    const settings = effectiveSettings(stored, policy);
    const id = ProviderInstanceId.make("private_agent");
    const before = yield* stored.getSettings;
    const outcome = yield* settings
      .updateSettings({
        providerInstances: {
          [id]: {
            driver: ProviderDriverKind.make("acpRegistry"),
            environment: [{ name: "TOKEN", value: "private-secret", sensitive: true }],
          },
        },
      })
      .pipe(Effect.exit);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(yield* stored.getSettings).toEqual(before);
    const mutation = yield* settings
      .updateProviderInstance({ operation: "remove", instanceId: id })
      .pipe(Effect.exit);
    expect(Exit.isFailure(mutation)).toBe(true);
    expect(yield* stored.getSettings).toEqual(before);
  }),
);
