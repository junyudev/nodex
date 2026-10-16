import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { makeNativeNotificationAuthorization } from "./NativeNotificationAuthorization";

vi.mock("electron", () => ({ Notification: { isSupported: () => true } }));

it.effect("serializes first authorization requests and reads the current system decision", () =>
  Effect.gen(function* () {
    let status = "not-determined";
    let requests = 0;
    let reads = 0;
    const authorization = yield* makeNativeNotificationAuthorization({
      platform: "darwin",
      isSupported: () => true,
      loadBridge: () => ({
        readAuthorization: async () => {
          reads++;
          return status;
        },
        requestAuthorization: async () => {
          requests++;
          await Promise.resolve();
          status = "authorized";
          return status;
        },
      }),
    });
    assert.strictEqual(yield* authorization.read, "not-determined");
    assert.strictEqual(requests, 0);
    assert.deepEqual(
      yield* Effect.all([authorization.request, authorization.request], {
        concurrency: "unbounded",
      }),
      ["authorized", "authorized"],
    );
    assert.strictEqual(requests, 1);
    assert.strictEqual(reads, 3);
    status = "denied";
    assert.strictEqual(yield* authorization.request, "denied");
    assert.strictEqual(requests, 1);
    status = "provisional";
    assert.strictEqual(yield* authorization.request, "provisional");
    assert.strictEqual(requests, 1);
  }),
);

it.effect(
  "propagates invalid and failed native authorization instead of assuming delivery is allowed",
  () =>
    Effect.gen(function* () {
      const unavailable = yield* makeNativeNotificationAuthorization({
        platform: "darwin",
        isSupported: () => true,
        loadBridge: () => ({
          readAuthorization: async () => "unknown",
          requestAuthorization: async () => "authorized",
        }),
      });
      assert.strictEqual((yield* Effect.result(unavailable.request))._tag, "Failure");
      const rejected = yield* makeNativeNotificationAuthorization({
        platform: "darwin",
        isSupported: () => true,
        loadBridge: () => ({
          readAuthorization: async () => "not-determined",
          requestAuthorization: async () => {
            throw new Error("Native permission failed");
          },
        }),
      });
      assert.strictEqual((yield* Effect.result(rejected.request))._tag, "Failure");
    }),
);

it.effect("uses platform support without loading a macOS bridge on other platforms", () =>
  Effect.gen(function* () {
    let supported = true;
    const authorization = yield* makeNativeNotificationAuthorization({
      platform: "linux",
      isSupported: () => supported,
      loadBridge: () => {
        throw new Error("macOS bridge must not load");
      },
    });
    assert.strictEqual(yield* authorization.request, "unknown");
    supported = false;
    assert.strictEqual(yield* authorization.read, "unsupported");
  }),
);
