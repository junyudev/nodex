import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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
        yield* settle;
        return { analytics, quit: Scope.close(session, Exit.void) };
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
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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
