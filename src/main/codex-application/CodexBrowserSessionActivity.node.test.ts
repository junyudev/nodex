import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import { install } from "./CodexBrowserSessionActivity";
import { CodexApplicationEventHub, make as makeEvents } from "./CodexApplicationEventHub";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";

it.effect("interruption and current native idle release browser activity independently of turn completion", () => Effect.gen(function* () {
  const native = yield* PubSub.unbounded<CodexEndpointEvent>();
  const events = yield* makeEvents;
  const interrupted = yield* Deferred.make<void>();
  const idle = yield* Deferred.make<void>();
  const calls: string[] = [];
  yield* install.pipe(
    Effect.provideService(CodexApplicationEventHub, events),
    Effect.provideService(BrowserUseRuntime, { endSessionActivity: (id: string) => Effect.sync(() => { calls.push(id); }).pipe(Effect.andThen(Deferred.succeed(id === "interrupted" ? interrupted : idle, undefined))) } as unknown as BrowserUseRuntime["Service"]),
    Effect.provideService(CodexGateway, { events: Stream.fromPubSub(native), connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 2 }) } as unknown as CodexGateway["Service"]),
  );
  events.publish({ kind: "conversationTurnInterruptStarted", value: "interrupted" });
  yield* Deferred.await(interrupted);
  yield* PubSub.publish(native, { kind: "notification", hostId: "local", generation: 1, value: { protocol: "extension", method: "thread/status/changed", params: { threadId: "stale", status: { type: "idle" } } } });
  yield* PubSub.publish(native, { kind: "notification", hostId: "local", generation: 2, value: { protocol: "extension", method: "thread/status/changed", params: { threadId: "idle", status: { type: "idle" } } } });
  yield* Deferred.await(idle);
  assert.deepEqual(calls, ["interrupted", "idle"]);
}));
