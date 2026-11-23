import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProjectId,
  resolveProjectProviderInstanceEnabled,
} from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import {
  effectiveSettings,
  makePolicy,
  makeWithPorts,
  runOwnedInstances,
} from "./ProviderConfiguration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

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
  "an installed component replaces its unavailable configuration despite waiting work",
  () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("codex");
      const available = { driver: ProviderDriverKind.make("codex") };
      const initial = {
        [id]: {
          ...available,
          componentUnavailable: {
            installationSource: { kind: "component" as const, id: "codex" },
            reason: "installing" as const,
            message: "Codex is still installing.",
          },
        },
      };
      const nativeMap = yield* Ref.make<ProviderInstanceConfigMap>(initial);
      const configuration = yield* makeWithPorts(initial, {
        // Work queued while the component installs waits for this configuration.
        busyInstances: Effect.succeed(new Set([id])),
        closeIdleInstance: () => Effect.void,
        reconcile: (next) => Ref.set(nativeMap, next),
      });
      expect(yield* configuration.configure({ [id]: available })).toEqual({
        applied: true,
        deferredInstanceIds: [],
      });
      expect(yield* Ref.get(nativeMap)).toEqual({ [id]: available });
    }),
);

it.effect("a held queue owns no configuration, while waiting and active runs do", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = [
      ["held", "queued", { queueHeld: true }],
      ["next", "queued", {}],
      ["released", "queued", { queueHeld: false }],
      ["waiting", "waiting", {}],
      ["done", "completed", {}],
    ] as const;
    for (const [instance, status, payload] of runs)
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json)
        VALUES(${instance},${instance},1,'codex',${instance},${status},'2026-11-12T00:00:00Z',${JSON.stringify(payload)})`;
    expect([...(yield* runOwnedInstances(sql))].sort()).toEqual(["next", "released", "waiting"]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
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

it.effect(
  "retires a busy Nodex instance after closing admission while retaining native providers",
  () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("nodex_codex_account");
      const nativeId = ProviderInstanceId.make("codex");
      const initial = {
        [id]: { driver: ProviderDriverKind.make("codex"), source: "nodex" as const },
        [nativeId]: { driver: ProviderDriverKind.make("codex") },
      };
      const policy = yield* makePolicy(initial);
      const closed: string[] = [];
      const configuration = yield* makeWithPorts(initial, {
        busyInstances: Effect.succeed(new Set([id, nativeId])),
        admission: policy.setDesired,
        closeIdleInstance: (instanceId) =>
          Effect.gen(function* () {
            expect((yield* policy.admission)[id]?.enabled).toBe(false);
            closed.push(instanceId);
          }),
        reconcile: policy.replace,
      });
      const result = yield* configuration.configure({ [nativeId]: initial[nativeId]! });
      expect(result).toEqual({ applied: true, deferredInstanceIds: [] });
      expect(closed).toEqual([id]);
      expect(yield* policy.current).toEqual({ [nativeId]: initial[nativeId]! });
    }),
);
