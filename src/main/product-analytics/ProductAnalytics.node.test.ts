import { describe, expect, test } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { AppUpdateChannel, TelemetrySettings } from "../../shared/types";
import { inertProductAnalytics, make, type ProductAnalyticsShape } from "./ProductAnalytics";
import {
  decodeState,
  type StatsigRequest,
  admitLaunch,
  deliveryOpen,
  dropExpired,
  dueBatch,
  encodeState,
  enqueue,
  initialState,
  MAX_BATCH_EVENTS,
  MAX_EVENT_AGE_MS,
  MAX_OUTBOX_EVENTS,
  NOTICE_GRACE_MS,
  removeDelivered,
  retryDelayMs,
  shouldRetryStatus,
  statsigRequest,
  type ProductAnalyticsState,
} from "./product-analytics-state";
import type { ProductEvent } from "../../shared/product-analytics/catalog";
import { productEventFromRuntime } from "./runtime-events";

describe("ProductAnalytics", () => {
  const ON: TelemetrySettings = { enabled: true, active: true, blockedBy: null, managed: false };
  const OFF: TelemetrySettings = { enabled: false, active: false, blockedBy: null, managed: false };
  const TICK_MS = 15_000;

  /**
   * Each session's delivery fiber sleeps one tick, does real file IO, then sleeps again. The
   * virtual clock cannot see that IO, so these count the sleeps it is asked for: a tick has
   * settled once every running session is asleep again, however long the disk took.
   */
  let runningSessions = 0;
  let sleepsStarted = 0;
  let sleepWaiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const sleepsReach = (count: number) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          if (sleepsStarted >= count) resolve();
          else sleepWaiters.push({ count, resolve });
        }),
    );
  const countSleeps = Clock.clockWith((clock) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const sleep = clock.sleep;
        runningSessions = 0;
        sleepsStarted = 0;
        sleepWaiters = [];
        clock.sleep = (duration) => {
          sleepsStarted += 1;
          const reached = sleepWaiters.filter((waiter) => waiter.count <= sleepsStarted);
          sleepWaiters = sleepWaiters.filter((waiter) => waiter.count > sleepsStarted);
          for (const waiter of reached) waiter.resolve();
          return sleep(duration);
        };
        return sleep;
      }),
      (sleep) =>
        Effect.sync(() => {
          clock.sleep = sleep;
        }),
    ),
  );
  /** Lets a fiber that was just handed work, without a tick, reach its file IO. */
  const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const advance = (milliseconds: number) =>
    Effect.gen(function* () {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += TICK_MS) {
        const asleepAgain = sleepsStarted + runningSessions;
        yield* TestClock.adjust(TICK_MS);
        yield* sleepsReach(asleepAgain);
      }
    });
  const MINUTE = 60_000;

  const harness = (input: {
    readonly telemetry?: TelemetrySettings;
    readonly status?: () => number;
    readonly focused?: boolean;
    readonly noticeApplies?: boolean;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const owner = yield* Effect.scope;
      const directory = yield* fs.makeTempDirectoryScoped();
      const statePath = path.join(directory, "product-analytics", "state.json");
      const channel = yield* Ref.make<AppUpdateChannel>("stable");
      const requests = yield* Ref.make<readonly StatsigRequest[]>([]);
      const changes = yield* PubSub.unbounded<TelemetrySettings>();
      let refusedReplacements = 0;
      // Windows refuses to replace a file that another handle still has open.
      const files: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) => {
          if (refusedReplacements === 0) return fs.rename(from, to);
          refusedReplacements -= 1;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
              pathOrDescriptor: to,
            }),
          );
        },
      };
      /** One app session over the shared Profile; `quit` runs the shutdown delivery. */
      const launch = (telemetry: TelemetrySettings = input.telemetry ?? ON) =>
        Effect.gen(function* () {
          const session = yield* Scope.fork(owner);
          const asleep = sleepsStarted;
          const analytics = yield* make({
            statePath,
            channel: Ref.get(channel),
            context: {
              appVersion: "1.0.0",
              tier: "production",
              os: "darwin",
              arch: "arm64",
              locale: "en-US",
            },
            telemetry,
            telemetryChanges: Stream.fromPubSub(changes),
            noticeApplies: Effect.succeed(input.noticeApplies ?? true),
            profileKind: Effect.succeed("new"),
            windowFocused: Effect.succeed(input.focused ?? false),
            send: (request) =>
              Ref.update(requests, (all) => [...all, request]).pipe(
                Effect.as(input.status?.() ?? 202),
              ),
          }).pipe(Scope.provide(session), Effect.provideService(FileSystem.FileSystem, files));
          runningSessions += 1;
          yield* sleepsReach(asleep + 1);
          return {
            analytics,
            quit: Effect.suspend(() => {
              runningSessions -= 1;
              return Scope.close(session, Exit.void);
            }),
          };
        });
      const sentNames = Ref.get(requests).pipe(
        Effect.map((all) =>
          all.flatMap((request) =>
            (JSON.parse(request.body) as { events: { eventName: string }[] }).events.map(
              (event) => event.eventName,
            ),
          ),
        ),
      );
      // Only while no save can be in flight: on Windows, an open reader makes the save's rename
      // fail. Durable outcomes are observed through `quit` and `launch` instead.
      const stored = fs.readFileString(statePath).pipe(Effect.map(decodeState));
      const refuseNextSave = Effect.sync(() => {
        refusedReplacements += 1;
      });
      return {
        ...(yield* launch()),
        launch,
        changes,
        channel,
        requests,
        sentNames,
        stored,
        statePath,
        refuseNextSave,
      };
    });

  const pendingNames = (analytics: ProductAnalyticsShape) =>
    analytics.activity.pipe(Effect.map(({ pending }) => pending.map(({ event }) => event.name)));

  const inertActivity = inertProductAnalytics.activity;

  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    countSleeps.pipe(Effect.andThen(effect), Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("reports the effective update channel after it changes", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, channel, quit, requests } = yield* harness({});
        assert.strictEqual((yield* analytics.activity).context.channel, "stable");

        yield* Ref.set(channel, "nightly");
        assert.strictEqual((yield* analytics.activity).context.channel, "nightly");
        yield* analytics.noticeAcknowledged;
        yield* quit;

        const [request] = yield* Ref.get(requests);
        assert.isDefined(request);
        const body = JSON.parse(request!.body) as { user: { custom: { channel: string } } };
        assert.strictEqual(body.user.custom.channel, "nightly");
      }),
    ),
  );

  it.effect("sends nothing until the notice has been on screen for the grace period", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, sentNames } = yield* harness({});
        yield* advance(5 * MINUTE);
        assert.deepStrictEqual(yield* sentNames, []);

        yield* analytics.noticePresented;
        yield* advance(TICK_MS);
        assert.deepStrictEqual(yield* sentNames, []);

        yield* advance(MINUTE);
        assert.deepStrictEqual(yield* sentNames, ["installation_created", "app_launched"]);
      }),
    ),
  );

  it.effect("turning analytics off before the grace period ends sends nothing at all", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, changes, requests, stored } = yield* harness({});
        yield* analytics.noticePresented;
        yield* PubSub.publish(changes, OFF);
        yield* settle;
        yield* analytics.noticeAcknowledged;
        yield* analytics.record({ name: "app_active", properties: {} });
        yield* advance(5 * MINUTE);
        assert.strictEqual((yield* Ref.get(requests)).length, 0);
        assert.deepStrictEqual((yield* stored).outbox, []);
        assert.deepStrictEqual((yield* analytics.activity).pending, []);
      }),
    ),
  );

  it.effect("reports the installation once a person opts in later", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, changes, sentNames } = yield* harness({ telemetry: OFF });
        yield* analytics.noticeAcknowledged;
        yield* analytics.record({ name: "app_active", properties: {} });
        yield* advance(5 * MINUTE);
        assert.deepStrictEqual(yield* sentNames, []);

        yield* PubSub.publish(changes, ON);
        yield* settle;
        yield* advance(3 * MINUTE);
        assert.deepStrictEqual(yield* sentNames, ["installation_created", "app_launched"]);
      }),
    ),
  );

  it.effect("keeps events through a failed delivery and backs off", () =>
    provided(
      Effect.gen(function* () {
        let status = 503;
        const { analytics, requests, sentNames, stored } = yield* harness({
          status: () => status,
        });
        yield* analytics.noticeAcknowledged;
        yield* advance(2 * MINUTE);
        assert.strictEqual((yield* Ref.get(requests)).length, 1);
        assert.strictEqual((yield* stored).outbox.length, 2);

        yield* advance(30_000);
        assert.strictEqual((yield* Ref.get(requests)).length, 1, "retries wait for backoff");

        status = 202;
        yield* advance(MINUTE);
        assert.strictEqual((yield* Ref.get(requests)).length, 2);
        assert.deepStrictEqual((yield* sentNames).slice(-2), [
          "installation_created",
          "app_launched",
        ]);
        const activity = yield* analytics.activity;
        assert.deepStrictEqual(activity.pending, []);
        assert.deepStrictEqual(
          activity.sent.map((entry) => entry.event.name),
          ["installation_created", "app_launched"],
        );
      }),
    ),
  );

  it.effect("a batch the service rejects is dropped rather than retried forever", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, quit, launch, requests } = yield* harness({ status: () => 400 });
        yield* analytics.noticeAcknowledged;
        yield* advance(2 * MINUTE);
        assert.strictEqual((yield* Ref.get(requests)).length, 1);
        yield* advance(5 * MINUTE);
        assert.strictEqual((yield* Ref.get(requests)).length, 1);
        assert.deepStrictEqual((yield* analytics.activity).pending, []);
        assert.deepStrictEqual((yield* analytics.activity).sent, []);

        yield* quit;
        const relaunched = yield* launch();
        assert.deepStrictEqual(yield* pendingNames(relaunched.analytics), ["app_launched"]);
      }),
    ),
  );

  it.effect("a save the system refuses is repeated, so a restart resends nothing delivered", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, quit, launch, refuseNextSave, sentNames } = yield* harness({});
        yield* analytics.noticeAcknowledged;
        yield* refuseNextSave;
        yield* advance(2 * MINUTE);
        assert.deepStrictEqual(yield* sentNames, ["installation_created", "app_launched"]);

        yield* quit;
        const relaunched = yield* launch();
        assert.deepStrictEqual(yield* pendingNames(relaunched.analytics), ["app_launched"]);
      }),
    ),
  );

  it.effect("analytics that is off at launch withdraws what an earlier launch left unsent", () =>
    provided(
      Effect.gen(function* () {
        const { analytics, quit, launch, requests } = yield* harness({ status: () => 503 });
        yield* analytics.noticeAcknowledged;
        yield* quit;
        const attempted = (yield* Ref.get(requests)).length;

        const relaunched = yield* launch(OFF);
        assert.deepStrictEqual(yield* pendingNames(relaunched.analytics), []);
        yield* advance(5 * MINUTE);
        yield* relaunched.quit;
        assert.strictEqual((yield* Ref.get(requests)).length, attempted);
      }),
    ),
  );

  it.effect("counts one active day per UTC day, and only with a focused window", () =>
    provided(
      Effect.gen(function* () {
        const activeDays = (analytics: { readonly activity: typeof inertActivity }) =>
          analytics.activity.pipe(
            Effect.map(
              (activity) =>
                activity.pending.filter((entry) => entry.event.name === "app_active").length,
            ),
          );
        yield* TestClock.setTime(Date.parse("2026-11-10T23:58:45Z"));
        const unfocused = yield* harness({ focused: false });
        yield* advance(TICK_MS);
        assert.strictEqual(yield* activeDays(unfocused.analytics), 0);

        const focused = yield* harness({ focused: true });
        yield* advance(TICK_MS);
        assert.strictEqual(yield* activeDays(focused.analytics), 1);
        yield* advance(2 * TICK_MS);
        assert.strictEqual(yield* activeDays(focused.analytics), 1);
        yield* advance(2 * TICK_MS);
        assert.strictEqual(yield* activeDays(focused.analytics), 2);
      }),
    ),
  );

  it.effect("a renderer cannot report what it does not own, and bad input is ignored", () =>
    provided(
      Effect.gen(function* () {
        const { analytics } = yield* harness({});
        const before = (yield* analytics.activity).pending.length;
        yield* analytics.recordFromRenderer({ name: "app_active", properties: {} });
        yield* analytics.recordFromRenderer({ name: "feature_used", properties: { feature: "x" } });
        yield* analytics.recordFromRenderer("garbage");
        yield* analytics.recordFromRuntime("chatgpt.auth.started", {});
        assert.strictEqual((yield* analytics.activity).pending.length, before);

        yield* analytics.recordFromRenderer({
          name: "feature_used",
          properties: { feature: "terminal" },
        });
        assert.strictEqual((yield* analytics.activity).pending.length, before + 1);
      }),
    ),
  );

  it.effect("the identity survives a restart and a corrupt document is replaced", () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { analytics, quit, launch, statePath } = yield* harness({});
        const first = (yield* analytics.activity).installationId;
        yield* quit;
        const second = yield* launch();
        assert.isString(first);
        assert.strictEqual((yield* second.analytics.activity).installationId, first);
        yield* second.quit;

        yield* fs.writeFileString(statePath, "{corrupt");
        const third = yield* launch();
        assert.notStrictEqual((yield* third.analytics.activity).installationId, first);
        const names = yield* fs.readDirectory(path.dirname(statePath));
        assert.isTrue(names.some((name) => name.startsWith("state.json.corrupt-")));
      }),
    ),
  );

  it.effect("the notice stops once acknowledged and does not apply when nothing is shared", () =>
    provided(
      Effect.gen(function* () {
        const { analytics } = yield* harness({});
        assert.isTrue((yield* analytics.notice).present);
        yield* analytics.noticeAcknowledged;
        assert.isFalse((yield* analytics.notice).present);

        const silent = yield* harness({ telemetry: OFF, noticeApplies: false });
        assert.isFalse((yield* silent.analytics.notice).present);
      }),
    ),
  );
});

describe("product-analytics-state", () => {
  const ID = "6f1f8f2e-1f0a-4c55-9d0e-2b7f0c8a1e11";
  const active: ProductEvent = { name: "app_active", properties: {} };
  const acknowledged = {
    ...initialState(ID),
    notice: { presentedAt: 0, acknowledgedAt: 0 },
  };

  describe("launch admission", () => {
    const launch = (state: ReturnType<typeof initialState>, appVersion: string) =>
      admitLaunch(state, { appVersion, profile: "new", time: 1 });
    const names = (state: ReturnType<typeof initialState>) =>
      state.outbox.map((entry) => entry.event.name);
    const launchKind = (state: ReturnType<typeof initialState>) => {
      const last = state.outbox.at(-1)?.event;
      return last?.name === "app_launched" ? last.properties.launch : null;
    };

    test("the first launch reports the installation exactly once", () => {
      const first = launch(initialState(ID), "1.0.0");
      expect(names(first)).toEqual(["installation_created", "app_launched"]);
      expect(launchKind(first)).toBe("first");
      const second = launch({ ...first, outbox: [] }, "1.0.0");
      expect(names(second)).toEqual(["app_launched"]);
      expect(launchKind(second)).toBe("returning");
    });

    test("a new version is an update, then returning", () => {
      const first = launch(initialState(ID), "1.0.0");
      const updated = launch(first, "1.1.0");
      expect(launchKind(updated)).toBe("updated");
      expect(launchKind(launch(updated, "1.1.0"))).toBe("returning");
    });
  });

  describe("delivery gate", () => {
    test("holds everything until the notice has been on screen long enough to act on", () => {
      const queued = enqueue(initialState(ID), active, 0);
      expect(deliveryOpen(queued, 10 ** 12)).toBe(false);
      expect(dueBatch(queued, { now: 10 ** 12, retryAt: null, force: true })).toEqual([]);
      const presented = { ...queued, notice: { presentedAt: 1_000, acknowledgedAt: null } };
      expect(deliveryOpen(presented, 1_000 + NOTICE_GRACE_MS - 1)).toBe(false);
      expect(deliveryOpen(presented, 1_000 + NOTICE_GRACE_MS)).toBe(true);
    });

    test("acknowledging opens delivery immediately", () => {
      expect(deliveryOpen(acknowledged, 0)).toBe(true);
    });
  });

  describe("batching", () => {
    const withEvents = (count: number, time = 0) => {
      let state: ProductAnalyticsState = acknowledged;
      for (let index = 0; index < count; index += 1) state = enqueue(state, active, time);
      return state;
    };

    test("waits for age or size, and sends a bounded batch", () => {
      expect(dueBatch(withEvents(1), { now: 1_000, retryAt: null })).toEqual([]);
      expect(dueBatch(withEvents(1), { now: 120_000, retryAt: null })).toHaveLength(1);
      expect(dueBatch(withEvents(25), { now: 1_000, retryAt: null })).toHaveLength(25);
      expect(dueBatch(withEvents(250), { now: 1_000, retryAt: null })).toHaveLength(
        MAX_BATCH_EVENTS,
      );
    });

    test("does not retry before the backoff elapses, except a final forced attempt", () => {
      const state = withEvents(30);
      expect(dueBatch(state, { now: 1_000, retryAt: 2_000 })).toEqual([]);
      expect(dueBatch(state, { now: 2_000, retryAt: 2_000 })).toHaveLength(30);
      expect(dueBatch(state, { now: 1_000, retryAt: 2_000, force: true })).toHaveLength(30);
    });

    test("backoff doubles and is capped", () => {
      expect(retryDelayMs(1)).toBe(60_000);
      expect(retryDelayMs(2)).toBe(120_000);
      expect(retryDelayMs(50)).toBe(3_600_000);
    });

    test("only transient responses stay in the outbox", () => {
      for (const status of [408, 429, 500, 503]) expect(shouldRetryStatus(status)).toBe(true);
      for (const status of [202, 400, 401, 413]) expect(shouldRetryStatus(status)).toBe(false);
    });

    test("the outbox is bounded by count and age", () => {
      const full = withEvents(MAX_OUTBOX_EVENTS + 5);
      expect(full.outbox).toHaveLength(MAX_OUTBOX_EVENTS);
      expect(full.outbox[0]?.seq).toBeGreaterThan(1);
      const aged = enqueue(withEvents(2, 0), active, MAX_EVENT_AGE_MS);
      expect(dropExpired(aged, MAX_EVENT_AGE_MS + 1).outbox).toHaveLength(1);
    });

    test("removes exactly the delivered entries when more arrived during the request", () => {
      const before = withEvents(2);
      const delivered = before.outbox;
      const after = enqueue(before, active, 5);
      expect(removeDelivered(after, delivered).outbox.map((entry) => entry.time)).toEqual([5]);
    });
  });

  describe("persistence", () => {
    test("round-trips", () => {
      const state = admitLaunch(acknowledged, {
        appVersion: "1.0.0",
        profile: "existing",
        time: 9,
      });
      expect(decodeState(encodeState(state))).toEqual(state);
    });

    test("a stored event that left the catalog is dropped, not sent", () => {
      const raw = JSON.parse(encodeState(enqueue(acknowledged, active, 1)));
      raw.outbox[0].event = { name: "retired_event", properties: { text: "hello" } };
      expect(decodeState(JSON.stringify(raw)).outbox).toEqual([]);
    });

    test("a malformed document is refused", () => {
      expect(() => decodeState("{nope")).toThrow();
      expect(() => decodeState(JSON.stringify({ schemaVersion: 2 }))).toThrow();
    });
  });

  describe("statsig request", () => {
    test("identifies the installation, not a person, and stringifies metadata", () => {
      const request = statsigRequest({
        installationId: ID,
        context: {
          appVersion: "1.2.3",
          channel: "nightly",
          tier: "production",
          os: "darwin",
          arch: "arm64",
          locale: "en-US",
        },
        entries: [
          {
            seq: 1,
            time: 42,
            event: {
              name: "thread_message_navigation",
              value: 7,
              properties: { ordinal: 3, item_count: 9 },
            },
          },
        ],
        now: 100,
      });
      expect(JSON.parse(request.body)).toEqual({
        user: {
          userID: ID,
          appVersion: "1.2.3",
          locale: "en-US",
          statsigEnvironment: { tier: "production" },
          custom: { channel: "nightly", os: "darwin", arch: "arm64" },
        },
        events: [
          {
            eventName: "thread_message_navigation",
            time: 42,
            value: 7,
            metadata: { ordinal: "3", item_count: "9" },
          },
        ],
        statsigMetadata: { sdkType: "nodex-desktop", sdkVersion: "1.2.3" },
      });
      expect(request.headers["statsig-client-time"]).toBe("100");
    });
  });
});

describe("Agent Runtime facts become catalog events", () => {
  test("a started Thread", () => {
    expect(
      productEventFromRuntime("thread.created", {
        driver: "claudeAgent",
        model: "claude-sonnet-5-5",
        kind: "root",
        source: "web",
        actor: "user",
      }),
    ).toEqual({
      name: "thread_started",
      properties: {
        provider: "claude",
        model: "claude-sonnet-5-5",
        source: "web",
        actor: "user",
        host: "local",
      },
    });
  });

  test("subagents, forks and side chats are not new conversations", () => {
    expect(
      productEventFromRuntime("thread.created", {
        driver: "codex",
        model: "gpt-6-luna",
        kind: "subagent",
        source: "provider",
        actor: "agent",
      }),
    ).toEqual({
      name: "thread_branched",
      properties: {
        provider: "codex",
        model: "gpt-6-luna",
        kind: "subagent",
        source: "provider",
        actor: "agent",
        host: "local",
      },
    });
  });

  test("a completed turn keeps counts and hides a private model", () => {
    expect(
      productEventFromRuntime("provider.turn.completed", {
        provider: "codex",
        model: "acme-internal",
        terminalStatus: "completed",
        usageStatus: "complete",
        effort: "high",
        inputTokens: 120,
        outputTokens: 30,
        durationMs: 1_500,
      }),
    ).toEqual({
      name: "turn_completed",
      value: 1_500,
      properties: {
        provider: "codex",
        model: "other",
        status: "completed",
        effort: "high",
        input_tokens: 120,
        output_tokens: 30,
      },
    });
  });

  test("anything outside the catalog disappears", () => {
    expect(productEventFromRuntime("chatgpt.auth.started", { flow: "direct" })).toBeNull();
    expect(
      productEventFromRuntime("thread.created", { driver: "codex", kind: "unknown-kind" }),
    ).toBeNull();
    expect(
      productEventFromRuntime("provider.turn.completed", {
        provider: "codex",
        terminalStatus: "completed",
        inputTokens: "a lot",
      }),
    ).toBeNull();
  });
});
