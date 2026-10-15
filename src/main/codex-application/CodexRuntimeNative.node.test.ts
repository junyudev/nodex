import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { AgentRuntimeApplicationConnection } from "../agent-runtime/AgentRuntimeApplication";
import type { AgentRuntimeProcessDelivery } from "../platform/node/AgentRuntimeProcess";
import { captureVoice } from "./CodexRuntimeNative";

it.effect("routes voice controls and observations through their captured Runtime source", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const incoming = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
      const calls: Array<{ method: string; input: unknown }> = [];
      let subscribed = false;
      let released = false;
      let claimId = "";
      const source = {
        runtimeGeneration: "runtime",
        threadId: "product-thread",
        providerSessionId: "provider-session",
        nativeGeneration: 7,
        providerThreadId: "provider-thread",
        nativeThreadId: "native-thread",
      };
      const connection = {
        subscribeNotifications: Effect.gen(function* () {
          subscribed = true;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
          const subscription = yield* PubSub.subscribe(incoming);
          return Stream.fromSubscription(subscription);
        }),
        request: (method: string, input: unknown) =>
          Effect.sync(() => {
            calls.push({ method, input });
            if (method === "native.voice.prepare") {
              assert.isTrue(subscribed);
              assert.deepEqual((input as { threadId: string }).threadId, "product-thread");
              claimId = (input as { claimId: string }).claimId;
              return {
                source,
                userAgent: "codex/0.162.0-alpha.20",
                voices: { v1: ["arbor"], defaultV1: "arbor" },
                features: [],
                history: [],
              };
            }
            if (method === "native.voice.current") return true;
            return null;
          }),
      } as unknown as AgentRuntimeApplicationConnection;
      const capture = yield* captureVoice(
        { hostId: "local", threadId: "product-thread" },
        Option.some({
          nativeThread: () => Effect.succeed({ connection }),
        } as unknown as AgentRuntimeApplication["Service"]),
      );
      assert.isNotNull(capture);
      const voice = capture!;
      yield* voice.request("thread/realtime/appendSpeech", {
        threadId: "native-thread",
        text: "Say this",
      });
      assert.deepEqual(calls.at(-1), {
        method: "native.voice.append-speech",
        input: { claimId, source, threadId: "native-thread", text: "Say this" },
      });
      const result = yield* voice.notifications.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* PubSub.publish(incoming, {
        delivery: 1,
        notification: { type: "native.voice.closed", claimId: "unrelated", source },
      });
      yield* PubSub.publish(incoming, {
        delivery: 2,
        notification: { type: "native.voice.closed", claimId, source },
      });
      assert.equal((yield* Fiber.join(result)).length, 1);
      const gap = yield* voice.notifications.pipe(
        Stream.runDrain,
        Effect.result,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* PubSub.publish(incoming, {
        delivery: 4,
        notification: { type: "native.voice.closed", claimId, source },
      });
      assert.equal((yield* Fiber.join(gap))._tag, "Failure");
      assert.isFalse(yield* voice.current);
      yield* voice.release;
      assert.isTrue(released);
      assert.isFalse(yield* voice.current);
      assert.equal(calls.at(-1)?.method, "native.voice.release");
    }),
  ),
);
