import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { TelemetrySettings } from "../../shared/types";
import { inertProductAnalytics, make, type ProductAnalyticsPorts } from "./ProductAnalytics";
import { decodeState, type StatsigRequest } from "./product-analytics-state";

const ON: TelemetrySettings = { enabled: true, active: true, blockedBy: null, managed: false };
const OFF: TelemetrySettings = { enabled: false, active: false, blockedBy: null, managed: false };
const TICK_MS = 15_000;

/** Delivery fibers do real file IO, so a virtual tick must also yield real time to finish it. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const advance = (milliseconds: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += TICK_MS) {
      yield* TestClock.adjust(TICK_MS);
      yield* settle;
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
    const directory = yield* fs.makeTempDirectoryScoped();
    const statePath = path.join(directory, "product-analytics", "state.json");
    const requests = yield* Ref.make<readonly StatsigRequest[]>([]);
    const changes = yield* PubSub.unbounded<TelemetrySettings>();
    const ports: ProductAnalyticsPorts = {
      statePath,
      context: {
        appVersion: "1.0.0",
        channel: "stable",
        tier: "production",
        os: "darwin",
        arch: "arm64",
        locale: "en-US",
      },
      telemetry: input.telemetry ?? ON,
      telemetryChanges: Stream.fromPubSub(changes),
      noticeApplies: Effect.succeed(input.noticeApplies ?? true),
      profileKind: Effect.succeed("new"),
      windowFocused: Effect.succeed(input.focused ?? false),
      send: (request) =>
        Ref.update(requests, (all) => [...all, request]).pipe(Effect.as(input.status?.() ?? 202)),
    };
    const analytics = yield* make(ports);
    const sentNames = Ref.get(requests).pipe(
      Effect.map((all) =>
        all.flatMap((request) =>
          (JSON.parse(request.body) as { events: { eventName: string }[] }).events.map(
            (event) => event.eventName,
          ),
        ),
      ),
    );
    const stored = fs.readFileString(statePath).pipe(Effect.map(decodeState));
    yield* settle;
    return { analytics, changes, requests, sentNames, stored };
  });

const inertActivity = inertProductAnalytics.activity;

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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
      assert.strictEqual((yield* stored).outbox.length, 0);
      assert.deepStrictEqual((yield* sentNames).slice(-2), [
        "installation_created",
        "app_launched",
      ]);
      const activity = yield* analytics.activity;
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
      const { analytics, requests, stored } = yield* harness({ status: () => 400 });
      yield* analytics.noticeAcknowledged;
      yield* advance(2 * MINUTE);
      assert.strictEqual((yield* stored).outbox.length, 0);
      assert.strictEqual((yield* Ref.get(requests)).length, 1);
      yield* advance(5 * MINUTE);
      assert.strictEqual((yield* Ref.get(requests)).length, 1);
      assert.deepStrictEqual((yield* analytics.activity).sent, []);
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
      const unfocused = yield* harness({ focused: false });
      yield* advance(TICK_MS);
      assert.strictEqual(yield* activeDays(unfocused.analytics), 0);

      const focused = yield* harness({ focused: true });
      yield* advance(TICK_MS);
      assert.strictEqual(yield* activeDays(focused.analytics), 1);
      yield* advance(10 * MINUTE);
      assert.strictEqual(yield* activeDays(focused.analytics), 1);
      yield* TestClock.adjust("24 hours");
      yield* settle;
      yield* advance(TICK_MS);
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
      const directory = yield* fs.makeTempDirectoryScoped();
      const statePath = path.join(directory, "state.json");
      const ports: ProductAnalyticsPorts = {
        statePath,
        context: {
          appVersion: "1.0.0",
          channel: "stable",
          tier: "production",
          os: "darwin",
          arch: "arm64",
          locale: "en-US",
        },
        telemetry: ON,
        telemetryChanges: Stream.empty,
        noticeApplies: Effect.succeed(true),
        profileKind: Effect.succeed("new"),
        windowFocused: Effect.succeed(false),
        send: () => Effect.succeed(202),
      };
      const first = yield* Effect.scoped(
        make(ports).pipe(Effect.flatMap((analytics) => analytics.activity)),
      );
      const second = yield* Effect.scoped(
        make(ports).pipe(Effect.flatMap((analytics) => analytics.activity)),
      );
      assert.isString(first.installationId);
      assert.strictEqual(second.installationId, first.installationId);

      yield* fs.writeFileString(statePath, "{corrupt");
      const third = yield* Effect.scoped(
        make(ports).pipe(Effect.flatMap((analytics) => analytics.activity)),
      );
      assert.notStrictEqual(third.installationId, first.installationId);
      const names = yield* fs.readDirectory(directory);
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
