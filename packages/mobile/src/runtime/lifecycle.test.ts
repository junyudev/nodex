import { it } from "@effect/vitest";
import { encodePairingUri } from "@nodex/mobile-protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { FakeHost, fakePlatform } from "./fake-host.test-support";
import { createMobileRuntime } from "./runtime";

it.effect("uses TestClock for heartbeat deadlines and reconnect backoff", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const scheduler = yield* Scheduler.Scheduler;
    const platform = fakePlatform();
    const host = new FakeHost();
    host.pong = false;
    platform.routes.set(host.routes[0]!, host);
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => createMobileRuntime(platform, { clock, scheduler })),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
    yield* Effect.promise(() =>
      runtime.connection.pairWithUri(encodePairingUri(host.pairingOffer(platform.now() + 60_000))),
    );
    yield* TestClock.adjust(29_999);
    expect(runtime.connection.state.getState().status).toBe("connected");
    yield* TestClock.adjust(1);
    expect(runtime.connection.state.getState().status).toBe("offline");
    expect(platform.dials).toHaveLength(1);
    yield* TestClock.adjust(1_000);
    expect(platform.dials).toHaveLength(2);
    yield* Effect.promise(() => runtime.dispose());
    yield* TestClock.adjust(60_000);
    expect(platform.dials).toHaveLength(2);
  }),
);

it.effect("preserves encrypted frame order when concurrent sends yield frequently", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const scheduler = new Scheduler.MixedScheduler("sync");
    const platform = fakePlatform();
    const host = new FakeHost();
    platform.routes.set(host.routes[0]!, host);
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => createMobileRuntime(platform, { clock, scheduler })),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
    const saved = yield* Effect.promise(() =>
      runtime.connection.pairWithUri(encodePairingUri(host.pairingOffer(platform.now() + 60_000))),
    );
    const session = runtime.chats.get(saved.hostId, "chat");
    scheduler.shouldYield = (fiber) => fiber.currentOpCount >= 16;
    const messages = ["A".repeat(128_000), "B".repeat(128_000)];
    yield* Effect.promise(() =>
      Promise.all(messages.map((message) => session.send(message, [], "queue"))),
    );
    expect(
      host.requests
        .filter((request) => request.m === "chat.send")
        .map((request) => (request.p as { text: string }).text),
    ).toEqual(messages);
    expect(runtime.connection.state.getState().status).toBe("connected");
  }),
);
