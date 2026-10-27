import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivityChange,
} from "../../shared/agent-runtime-api";
import { adoptClaudeRows, make, nextClaudeUsageReadAt } from "./AgentRuntimeClaudeUsage";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type Provider = Providers[number];

const MINUTE = 60_000;

const claude = (overrides: {
  readonly instanceId?: string;
  readonly readAt?: number;
  readonly usedPercent?: number;
  readonly signedIn?: boolean;
}): Provider =>
  ({
    instanceId: overrides.instanceId ?? "claude-default",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.310",
    status: overrides.signedIn === false ? "error" : "ready",
    auth:
      overrides.signedIn === false
        ? { status: "unauthenticated" }
        : { status: "authenticated", email: "ada@example.com", type: "max", label: "Claude Max" },
    checkedAt: new Date(0).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    ...(overrides.signedIn === false
      ? {}
      : {
          usageLimits: {
            checkedAt: new Date(overrides.readAt ?? 0).toISOString(),
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: overrides.usedPercent ?? 10,
              },
            ],
          },
        }),
  }) as unknown as Provider;
const codex = { instanceId: "codex", driver: "codex" } as unknown as Provider;

const harness = (options: {
  readonly declared?: readonly string[];
  /** Whether Agent execution is running; mutable so a test can stop or start it. */
  readonly execution?: { running: boolean };
  /** What Nodex knows without starting execution. */
  readonly known?: () => Effect.Effect<Providers | null, Error>;
  /** A from-scratch check of the Claude Agents. */
  readonly check?: () => Effect.Effect<Providers, Error>;
  readonly logout?: (instanceIds: readonly string[]) => Effect.Effect<Providers, Error>;
}) =>
  Effect.gen(function* () {
    const execution = options.execution ?? { running: true };
    /** `asked` may start execution; `poll` runs only while it already does. */
    const reads: ("known" | "asked" | "poll")[] = [];
    let skipped = 0;
    const served = yield* PubSub.unbounded<Providers>();
    const connection = yield* PubSub.unbounded<AgentRuntimeConnectionState>();
    const activity = yield* PubSub.unbounded<AgentRuntimeSessionActivityChange>();
    const now = (usedPercent: number) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((readAt): Providers => [codex, claude({ readAt, usedPercent })]),
      );
    const check = () => options.check?.() ?? now(30);
    const usage = yield* make({
      declared: Effect.succeed(options.declared ?? ["claude-default"]),
      known: Effect.suspend(() => {
        reads.push("known");
        return options.known?.() ?? now(10);
      }),
      refresh: () =>
        Effect.suspend(() => {
          reads.push("asked");
          execution.running = true;
          return check();
        }),
      refreshWhileRunning: () =>
        Effect.suspend(() => {
          if (!execution.running) {
            skipped += 1;
            return Effect.succeed(null);
          }
          reads.push("poll");
          return check();
        }),
      logout: options.logout ?? (() => Effect.succeed([])),
      served: Stream.fromPubSub(served),
      connectionChanges: Stream.fromPubSub(connection),
      activityChanges: Stream.fromPubSub(activity),
    });
    const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
      discard: true,
    });
    yield* settle;
    return {
      usage,
      reads,
      skipped: () => skipped,
      execution,
      served,
      connection,
      activity,
      settle,
    };
  });

it("reads usage again once the oldest reading is an interval old, never sooner than an attempt", () => {
  assert.strictEqual(
    nextClaudeUsageReadAt({ readings: [4 * MINUTE], lastAttemptAt: null, intervalMs: 5 * MINUTE }),
    9 * MINUTE,
  );
  // A reading that keeps failing to refresh stays old; the last attempt paces the retry.
  assert.strictEqual(
    nextClaudeUsageReadAt({
      readings: [0, 20 * MINUTE],
      lastAttemptAt: 30 * MINUTE,
      intervalMs: 5 * MINUTE,
    }),
    35 * MINUTE,
  );
  assert.strictEqual(
    nextClaudeUsageReadAt({ readings: [null], lastAttemptAt: null, intervalMs: 5 * MINUTE }),
    -Infinity,
  );
  assert.strictEqual(
    nextClaudeUsageReadAt({ readings: [], lastAttemptAt: 2 * MINUTE, intervalMs: 5 * MINUTE }),
    7 * MINUTE,
  );
});

it("a kept catalog never replaces an Agent that was checked more recently", () => {
  const checked = (at: number, usedPercent: number) =>
    ({ ...claude({ readAt: at, usedPercent }), checkedAt: new Date(at).toISOString() }) as Provider;
  const fresh = checked(10 * MINUTE, 60);
  assert.deepEqual(adoptClaudeRows([fresh], [codex, checked(2 * MINUTE, 20)]), [fresh]);
  const later = checked(12 * MINUTE, 70);
  assert.deepEqual(adoptClaudeRows([fresh], [later]), [later]);
  // The catalog decides which Agents exist.
  assert.deepEqual(adoptClaudeRows([fresh], []), []);
});

it.effect("keeps a shown reading no older than five minutes while execution runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { usage, reads, settle } = yield* harness({
        // What Nodex kept from its last launch was read an hour ago.
        known: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => [codex, claude({ readAt: now - 60 * MINUTE })]),
          ),
      });
      // Launch only takes over what Nodex knows.
      assert.deepEqual(reads, ["known"]);
      const launched = yield* SubscriptionRef.get(usage.snapshot);
      assert.strictEqual(launched.status, "ready");
      assert.deepEqual(
        launched.providers?.map((provider) => provider.instanceId),
        ["claude-default"],
      );

      yield* TestClock.adjust("4 minutes");
      yield* settle;
      assert.deepEqual(reads, ["known"]);
      yield* TestClock.adjust("1 minute");
      yield* settle;
      assert.deepEqual(reads, ["known", "poll"]);
      assert.strictEqual(
        (yield* SubscriptionRef.get(usage.snapshot)).providers?.[0]?.usageLimits?.windows[0]
          ?.usedPercent,
        30,
      );

      yield* TestClock.adjust("5 minutes");
      yield* settle;
      assert.deepEqual(reads, ["known", "poll", "poll"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("never starts stopped execution on its own, but an opened card does", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const execution = { running: false };
      const { usage, reads, skipped, connection, settle } = yield* harness({ execution });
      yield* TestClock.adjust("30 minutes");
      yield* settle;
      assert.deepEqual(reads, ["known"]);
      // Each due read looked once and let execution be; none spun.
      assert.strictEqual(skipped(), 6);

      yield* usage.refresh;
      assert.deepEqual(reads, ["known", "asked"]);

      // Execution started for any reason reports its fresh checks.
      yield* PubSub.publish(connection, { status: "ready", generation: "g1" });
      yield* settle;
      assert.deepEqual(reads, ["known", "asked", "known"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an opened card reads again unless it read moments ago, once for every opener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { usage, reads, settle } = yield* harness({});
      yield* usage.refresh;
      assert.deepEqual(reads, ["known", "asked"]);
      yield* usage.refresh;
      assert.deepEqual(reads, ["known", "asked"], "a refresh right after a read reuses it");

      yield* TestClock.adjust("90 seconds");
      yield* Effect.all([usage.refresh, usage.refresh, usage.refresh], {
        concurrency: "unbounded",
      });
      yield* settle;
      assert.deepEqual(reads, ["known", "asked", "asked"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("cancelling the first opener keeps one shared read alive for the other openers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const { usage, reads, settle } = yield* harness({
        check: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            return [claude({ usedPercent: 42 })];
          }),
      });
      const first = yield* usage.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const second = yield* usage.refresh.pipe(Effect.forkScoped);
      yield* settle;
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(finish, undefined);
      const result = yield* Fiber.join(second);
      assert.strictEqual(result.providers?.[0]?.usageLimits?.windows[0]?.usedPercent, 42);
      assert.deepEqual(reads, ["known", "asked"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("closing the usage owner interrupts an outstanding shared read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
      const { usage } = yield* harness({
        check: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      }).pipe(Effect.provideService(Scope.Scope, owner));
      yield* usage.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Scope.close(owner, Exit.void);
      assert.isTrue(yield* Deferred.isDone(stopped));
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a failed read keeps the last reading, says why, and retries on its own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let failing = false;
      const { usage, reads, settle } = yield* harness({
        check: () =>
          failing
            ? Effect.fail(new Error("Claude Code did not answer"))
            : Clock.currentTimeMillis.pipe(Effect.map((now) => [claude({ readAt: now })])),
      });
      failing = true;
      yield* TestClock.adjust("5 minutes");
      yield* settle;
      const failed = yield* SubscriptionRef.get(usage.snapshot);
      assert.strictEqual(failed.status, "unavailable");
      assert.strictEqual(failed.reason, "Claude Code did not answer");
      assert.strictEqual(failed.providers?.[0]?.usageLimits?.checkedAt, new Date(0).toISOString());
      const attempts = reads.length;
      yield* TestClock.adjust("5 minutes");
      yield* settle;
      assert.strictEqual(reads.length, attempts + 1);

      // A click asks again at once, even right after the failure.
      failing = false;
      assert.strictEqual((yield* usage.refresh).status, "ready");
      assert.deepEqual(reads.at(-1), "asked");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("with nothing known and execution stopped, nothing is shown or started", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { usage, reads, skipped, connection, settle } = yield* harness({
        execution: { running: false },
        known: () => Effect.succeed(null),
      });
      assert.deepEqual(yield* SubscriptionRef.get(usage.snapshot), {
        status: "ready",
        providers: null,
        reason: null,
      });
      yield* TestClock.adjust("1 hour");
      yield* settle;
      assert.deepEqual(reads, ["known"]);
      assert.strictEqual(skipped(), 0);

      // Execution starting for any other reason reads what it reports.
      yield* PubSub.publish(connection, { status: "ready", generation: "g1" });
      yield* settle;
      assert.deepEqual(reads, ["known", "known"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("nothing is read while no Claude Agent is declared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { usage, reads, settle } = yield* harness({ declared: [] });
      yield* TestClock.adjust("1 hour");
      yield* settle;
      assert.deepEqual(reads, []);
      assert.deepEqual(yield* SubscriptionRef.get(usage.snapshot), {
        status: "ready",
        providers: [],
        reason: null,
      });
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("takes over catalogs served elsewhere and reads again when a Claude reply ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { usage, reads, served, activity, settle } = yield* harness({});
      yield* PubSub.publish(served, [codex, claude({ readAt: 1_000, usedPercent: 55 })]);
      yield* settle;
      assert.strictEqual(
        (yield* SubscriptionRef.get(usage.snapshot)).providers?.[0]?.usageLimits?.windows[0]
          ?.usedPercent,
        55,
      );

      const running = {
        sessionId: "session-1",
        threadId: "thread-1",
        status: "running",
        activeRunId: "run-1",
        pendingRequestCount: 0,
        activeTaskCount: 0,
        resumesAutomatically: false,
        providerInstanceId: "claude-default",
        model: "claude-opus-5-5",
        updatedAt: new Date(0).toISOString(),
      } as const;
      const count = reads.length;
      yield* PubSub.publish(activity, { type: "upsert", sequence: 1, activity: running });
      yield* settle;
      assert.strictEqual(reads.length, count);
      yield* PubSub.publish(activity, { type: "remove", sequence: 2, sessionId: "session-1" });
      yield* settle;
      assert.deepEqual(reads.slice(count), ["known"]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("signing out replaces the Agent's reading with its signed-out state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const signedOut: string[][] = [];
      let refuse = false;
      const { usage, reads, settle } = yield* harness({
        logout: (instanceIds) => {
          signedOut.push([...instanceIds]);
          return refuse
            ? Effect.fail(new Error("Claude Code is still signed in."))
            : Effect.succeed([claude({ signedIn: false })]);
        },
      });
      const snapshot = yield* usage.logout(["claude-default"]);
      assert.deepEqual(signedOut, [["claude-default"]]);
      assert.strictEqual(snapshot.providers?.[0]?.auth.status, "unauthenticated");

      // A refused sign-out says why and reads the Agents again in case some changed.
      refuse = true;
      const count = reads.length;
      const failure = yield* usage.logout(["claude-default"]).pipe(Effect.flip);
      yield* settle;
      assert.strictEqual(failure.message, "Claude Code is still signed in.");
      assert.strictEqual(reads.length, count + 1);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
