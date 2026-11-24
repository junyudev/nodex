import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { AgentRuntimeSessionActivityChange } from "../../shared/agent-runtime-api";
import {
  providerKeyRuntimeInstanceId,
  type ProviderKeyConnection,
} from "../../shared/provider-keys";
import {
  AgentRuntimeSessionActivity,
  inactive,
} from "../agent-runtime/AgentRuntimeSessionActivity";
import { ApplicationSettings, make as makeSettings } from "../settings/ApplicationSettings";
import { make, type ProviderKeyReading, type ProviderKeyUsageReader } from "./ProviderKeyUsage";

const deepseek: ProviderKeyConnection = {
  id: "deep",
  preset: "deepseek",
  agent: "codex",
  endpoint: "international",
  displayName: "DeepSeek",
  enabled: true,
  baseUrl: null,
  models: [{ id: "fixture-model", name: "Fixture model" }],
  keyHint: "same",
};
const kimi: ProviderKeyConnection = { ...deepseek, id: "kimi", preset: "moonshot" };
const minimax: ProviderKeyConnection = { ...deepseek, id: "mini", preset: "minimax" };
const glm: ProviderKeyConnection = { ...deepseek, id: "glm", preset: "zhipu" };
const balance = (amount: number): ProviderKeyReading => ({
  balance: { amount, currency: "CNY" },
  windows: [],
});

const harness = (
  initial: readonly ProviderKeyConnection[],
  read: (id: string, key: string) => Effect.Effect<ProviderKeyReading | null, "read-failed">,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-provider-key-usage-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    const secrets = new Map<string, string>();
    const settings = yield* makeSettings({
      settingsPath: join(root, "config.toml"),
      hostHomeDirectory: root,
      environment: {},
      secretEncryption: {
        isAvailable: () => true,
        encryptString: (value) => {
          const ref = String(secrets.size);
          secrets.set(ref, value);
          return Buffer.from(ref);
        },
        decryptString: (ciphertext) => secrets.get(ciphertext.toString())!,
      },
    });
    const save = (connection: ProviderKeyConnection, key?: string) =>
      Effect.gen(function* () {
        yield* settings.update({
          type: "update-provider-keys",
          input: { connection, key: key ? Redacted.make(key) : undefined },
        });
      });
    const remove = (removeId: string) =>
      settings.update({ type: "update-provider-keys", input: { removeId } });
    yield* Effect.forEach(initial, (connection) => save(connection, "old-same"), { discard: true });
    const changes = yield* PubSub.unbounded<AgentRuntimeSessionActivityChange>();
    const reads: string[] = [];
    const reader: ProviderKeyUsageReader = ({ id, preset }) =>
      preset === "zhipu"
        ? undefined
        : (key) =>
            Effect.suspend(() => {
              reads.push(id);
              return read(id, Redacted.value(key));
            });
    const usage = yield* make(reader).pipe(
      Effect.provideService(ApplicationSettings, settings),
      Effect.provideService(AgentRuntimeSessionActivity, {
        ...inactive,
        activityChanges: Stream.fromPubSub(changes),
      }),
    );
    const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
      discard: true,
    });
    yield* settle;
    return { usage, reads, changes, settle, save, remove };
  });

const running = (
  connection: ProviderKeyConnection,
  sessionId: string,
): AgentRuntimeSessionActivityChange => ({
  type: "upsert",
  sequence: 0,
  activity: {
    sessionId,
    threadId: sessionId,
    status: "running",
    activeRunId: "run",
    pendingRequestCount: 0,
    backgroundTasks: [],
    providerInstanceId: providerKeyRuntimeInstanceId(connection),
    model: "model",
    updatedAt: "",
  },
});

it.effect(
  "reads enabled supported connections at launch and preserves a previous answer on failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let fail = false;
        const fixture = yield* harness(
          [deepseek, minimax, glm, { ...kimi, enabled: false }],
          (id) => {
            if (id === minimax.id) return Effect.succeed(null);
            return fail ? Effect.fail("read-failed") : Effect.succeed(balance(2.9));
          },
        );
        const { usage, reads, settle, save, remove } = fixture;
        assert.sameMembers(reads, [deepseek.id, minimax.id]);
        const initial = yield* usage.read;
        assert.deepEqual(initial.connections, [
          {
            connectionId: deepseek.id,
            observedAt: 0,
            readFailed: false,
            ...balance(2.9),
          },
        ]);
        yield* save(kimi, "new-same");
        yield* settle;
        assert.sameMembers(
          (yield* usage.read).connections.map(({ connectionId }) => connectionId),
          ["deep", "kimi"],
        );

        fail = true;
        yield* TestClock.adjust("1 minute");
        const failed = yield* usage.refresh(deepseek.id);
        assert.deepEqual(failed.connections[0], { ...initial.connections[0], readFailed: true });
        assert.isFalse(failed.connections[1]?.readFailed);
        yield* save({ ...deepseek, enabled: false });
        yield* remove(kimi.id);
        yield* settle;
        assert.deepEqual(yield* usage.read, { connections: [] });

        yield* save(deepseek);
        yield* settle;
        assert.deepEqual((yield* usage.read).connections, [
          {
            connectionId: deepseek.id,
            observedAt: null,
            readFailed: true,
            balance: null,
            windows: [],
          },
        ]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "throttles window refreshes, debounces settled work per connection and polls after fifteen quiet minutes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { usage, reads, changes, settle } = yield* harness([deepseek, kimi], () =>
          Effect.succeed(balance(1)),
        );
        const count = (id: string) => reads.filter((read) => read === id).length;
        yield* usage.refresh();
        yield* TestClock.adjust("59 seconds");
        yield* usage.refresh(deepseek.id);
        assert.sameMembers(reads, ["deep", "kimi"]);

        yield* TestClock.adjust("1 second");
        yield* Effect.all([usage.refresh(deepseek.id), usage.refresh(deepseek.id)], {
          concurrency: "unbounded",
        });
        assert.equal(count("deep"), 2);
        assert.equal(count("kimi"), 1);
        yield* usage.refresh();
        assert.equal(count("deep"), 2);
        assert.equal(count("kimi"), 2);

        yield* PubSub.publish(changes, running(deepseek, "first"));
        yield* PubSub.publish(changes, { type: "remove", sequence: 1, sessionId: "first" });
        yield* settle;
        yield* TestClock.adjust("2 seconds");
        yield* PubSub.publish(changes, running(deepseek, "second"));
        yield* PubSub.publish(changes, { type: "remove", sequence: 2, sessionId: "second" });
        yield* settle;
        yield* TestClock.adjust("2 seconds");
        assert.equal(count("deep"), 2);
        yield* TestClock.adjust("1 second");
        assert.equal(count("deep"), 3);
        assert.equal(count("kimi"), 2);

        yield* TestClock.adjust(14 * 60_000 + 55_000);
        assert.equal(count("deep"), 3);
        assert.equal(count("kimi"), 3);
        yield* TestClock.adjust("5 seconds");
        assert.equal(count("deep"), 4);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("replaces an in-flight credential even when the replacement has the same hint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const original = yield* Deferred.make<ProviderKeyReading>();
      const cancelled = yield* Deferred.make<void>();
      const { usage, reads, settle, save } = yield* harness([deepseek], (_, key) =>
        key === "old-same"
          ? Deferred.await(original).pipe(
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            )
          : Effect.succeed(balance(29)),
      );
      assert.deepEqual(reads, ["deep"]);
      assert.deepEqual(yield* usage.read, { connections: [] });
      yield* save(deepseek, "replacement-same");
      yield* Deferred.await(cancelled);
      yield* settle;
      yield* Deferred.succeed(original, balance(1));
      assert.deepEqual(reads, ["deep", "deep"]);
      assert.deepEqual((yield* usage.read).connections[0]?.balance, {
        amount: 29,
        currency: "CNY",
      });
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
